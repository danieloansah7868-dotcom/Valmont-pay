# Valmont Pay — Virtual Card (MoMo Direct)

> Pay anywhere online with your MoMo. GHS in → USD Visa out.

## TL;DR

- **Customer flow:** Create card (email) → Fund via MoMo (Paystack USSD prompt) → Card balance in USD → Pay online.
- **Two funding modes (you asked for both):** 
  1. **Direct:** `MoMo → Card` — amount goes straight to the selected card.
  2. **Wallet:** `MoMo → Wallet → Card(s)` — top up one GHS wallet, fund any of your cards later.
- **Two phases:**
  - **Phase 1 (live now):** Closed-loop card — works on any Valmont Pay merchant checkout (no external license, no partner, `provider: internal`). BIN `4832 46…` is a test range, Luhn-valid but not routed to Visa.
  - **Phase 2 (next sprint):** Real Visa/Mastercard via **Strowallet / Maplerad / Flutterwave** — card works on Netflix, Spotify, Amazon, etc. Same UI + same MoMo funding, provider holds the real PAN.

---

## Live API (Phase 1)

Base: `https://valmontpay.app` (or `http://localhost:3000` locally)

### Create a card

```bash
curl -X POST https://valmontpay.app/api/v1/virtual-cards \
  -H "Content-Type: application/json" \
  -d '{"customer_email":"you@example.com","currency":"USD"}'
# → { status:true, data:{ id:"vc_…", pan_masked:"•••• •••• •••• 4821", expiry:"10/29", balance_ghs:0, balance_usd:0 } }
```

### List your cards

```bash
curl "https://valmontpay.app/api/v1/virtual-cards?customer_email=you@example.com"
```

### Reveal full PAN/CVV (requires owner email or admin)

```bash
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/reveal \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

### Fund a card (MoMo direct)

Tries Paystack MoMo first when `PAYSTACK_SECRET_KEY` is set. Returns a Paystack checkout URL to complete. Falls back to instant demo credit when Paystack is absent.

```bash
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/fund \
  -H "Content-Type: application/json" \
  -d '{"amount_ghs":150,"momo_number":"0544000000","email":"you@example.com"}'
# Paystack configured → { paystack_authorization_url, paystack_reference }
# No Paystack / demo       → { data:{ balance_ghs:150, balance_usd:9.49 }, transaction:{...} }
```

Instant demo (always credits):

```bash
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/fund-local \
  -H "Content-Type: application/json" \
  -d '{"amount_ghs":150,"momo_number":"0544000000"}'
```

### Freeze / Unfreeze / Terminate / Limit

```bash
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/freeze   # → frozen, cannot fund or spend
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/unfreeze
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/terminate # irreversible
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/limit \
  -H "Content-Type: application/json" -d '{"spending_limit_usd":50}'
```

### Closed-loop spend (Phase 1 demo of authorization)

```bash
curl -X POST https://valmontpay.app/api/v1/virtual-cards/vc_xxx/spend \
  -H "Content-Type: application/json" \
  -d '{"amount_usd":4.99,"merchant":"Netflix"}'
```

### Wallet (shared GHS balance)

```bash
curl https://valmontpay.app/api/v1/wallets/you@example.com
curl -X POST https://valmontpay.app/api/v1/wallets/you@example.com/topup \
  -H "Content-Type: application/json" -d '{"amount_ghs":500,"momo_number":"0544000000"}'
curl -X POST https://valmontpay.app/api/v1/wallets/you@example.com/topup-local \
  -H "Content-Type: application/json" -d '{"amount_ghs":500}'
```

### Transactions

```bash
curl https://valmontpay.app/api/v1/virtual-cards/vc_xxx/transactions
```

---

## Frontend

- **Page:** `/virtual-card.html` (also `/virtual-card`) — creates, lists, funds, freezes, spends, shows wallet.
- **Nav:** Dashboard now has a **💳 Virtual Card** tab.
- **Auth:** Email in `localStorage` (`valmont_card_email`) — no password for beta. Phase 2 plugs into Valmont Pay login.
- **FX:** `GH₵ 15.80 / USD` by default. Override with `VIRTUAL_CARD_FX_RATE=16.2`.

---

## Persistence

- In-memory Maps are hot cache + local-dev fallback.
- **Durable:** `virtual_cards`, `virtual_wallets`, `virtual_card_transactions` in Supabase when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set.
- Run once: `scripts/supabase-virtual-cards-schema.sql` in Supabase SQL Editor (safe to re-run). Without it, cards work but die on cold start — same contract as `payment_links`.

---

## Phase 2 — Real Visa (Strowallet / Maplerad)

Valmont cannot mint a Visa BIN alone — only a licensed issuer can hold value and settle with Visa/Mastercard per Bank of Ghana EMI rules. So Valmont acts as **aggregator + MoMo funding rail**, provider is the **issuer**.

```
User MoMo → Valmont Pay (Paystack) → Provider Top-up API → Visa balance → Merchant
```

**Integration is ~1 file:** `lib/virtual-card-store.js` `fundCard()` + `createVirtualCard()`.

1. Create provider account: Strowallet (strowallet.co) or Maplerad.
2. Add to Vercel env:
   ```
   STROWALLET_API_KEY=sk_…
   STROWALLET_API_URL=https://api.strowallet.co/v1
   # or
   MAPLERAD_SECRET=…
   VIRTUAL_CARD_FX_RATE=15.8
   ```
3. In `lib/virtual-card-store.js`:
   - `createVirtualCard()` → `POST /cards` to provider, store `provider_card_id` + `pan`/`expiry`/`cvv` from provider response, set `provider: strowallet`.
   - `fundCard()` → after local credit, also `POST /cards/:id/fund` to provider with USD amount.
   - Never persist full PAN/CVV durably — provider vault holds them. Local `virtual_cards` keeps `pan_masked` + `last4` only (already the case).

**Fees (Ghana, 2024-2025 market):**
- Card creation: `$1–2` one-time
- Funding (MoMo → card): `1–2%`
- FX GHS→USD: interbank + `1–2%`
- Monthly: `$0–0.50`
- You set the markup on top.

**Compliance:** Phase 1 needs no license (closed-loop). Phase 2 runs under provider’s license (you are a distributor). Phase 3 (own license): apply to **Bank of Ghana** for PSP/EMI, partner with a settlement bank — then you become the issuer and keep the full fee.

---

## Ghana context

- MTN MoMo + Mastercard launched a **wallet-linked virtual card** in March 2024 for 13 markets including Ghana (Mastercard $200M investment in MTN Group Fintech). Valmont’s advantage: **multiple branded cards, per-card limits, wallet, API, merchant controls** vs MTN’s single card.
- Use `pay.html`’s Paystack MoMo checkout as the funding rail — same USSD prompt your customers already trust.

---

## Testing

```bash
# in-memory, no Supabase needed
node -e "const s=require('./lib/virtual-card-store'); (async()=>{ const r=await s.createVirtualCard({customer_email:'a@b.com'}); console.log(r.card.id); console.log(await s.fundCard(r.card.id, 100, {momo_number:'0544000000'})); })()"

# HTTP (server running)
curl -X POST http://localhost:3000/api/v1/virtual-cards -H 'Content-Type: application/json' -d '{"customer_email":"a@b.com"}'
```

---

## Files

- `lib/virtual-card-store.js` — store, wallet, FX
- `scripts/supabase-virtual-cards-schema.sql` — durable tables
- `virtual-card.html` — customer UI
- `server.js` — `/api/v1/virtual-cards/*` + `/api/v1/wallets/*`
