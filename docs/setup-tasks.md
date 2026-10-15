# Valmont Pay — Complete Setup Tasks (Ghana)
> Every env var, every click, with *how to get it* — not just *what it is*.
> Copy `.env.example` → `.env` locally, and duplicate the same vars in **Vercel → Project → Settings → Environment Variables (Production)**.

---

## 0) Local dev prerequisites (5 mins)

**Task 0.1 — Install tools**
- Node 18+ (`node -v`), Git, a code editor
- Vercel CLI optional: `npm i -g vercel`

**Task 0.2 — Clone & install**
```bash
git clone https://github.com/danieloansah7868-dotcom/Valmont-pay.git
cd Valmont-pay
cp .env.example .env   # you will fill it below
npm install
npm start              # → http://localhost:3000  (needs env below)
```

**Task 0.3 — Generate strong secrets (do ONCE, reuse everywhere)**
```bash
# On Linux/Mac/Terminal — gives you 32-char random strings
openssl rand -base64 32   # for ADMIN_PASSWORD
openssl rand -base64 32   # for ADMIN_SESSION_SECRET
openssl rand -hex 16      # for any TENANT__...__SECRET_KEY_1 if you invent one
```
*On Windows without openssl: https://generate-secret.vercel.app/32 — copy.*

---

## PHASE 1 — MUST HAVE TO LAUNCH (Paystack + Supabase + Admin + Deploy)

### 1) Supabase — your durable database (10 mins)

**Task 1.1 — Create project**
1. Go https://supabase.com → Sign in with GitHub → **New Project**
2. Name: `valmont-pay` → Set a DB password (save it) → Region: **closest to Ghana (EU West / Singapore)** → Create (takes ~2 mins)

**Task 1.2 — Get 3 values (Project Settings → API):**
- `SUPABASE_URL` → **Project URL** `https://xxxxxx.supabase.co` (top field)
- `SUPABASE_ANON_KEY` → **anon / public** (long `eyJ...` — safe for browser, but we use service_role)
- `SUPABASE_SERVICE_ROLE_KEY` → **service_role** (long `eyJ...` — **click Reveal**, copy — **secret, never in browser, bypasses RLS**)

> How: Supabase Dashboard → Left sidebar → **Project Settings (gear) → API** → copy.

**Task 1.3 — Add to `.env` and Vercel:**
```
SUPABASE_URL=https://xxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...service_role...
SUPABASE_ANON_KEY=eyJ...anon...
```

**Task 1.4 — Create tables (run 4 SQL files once):**
1. Supabase Dashboard → **SQL Editor → New query**
2. Open each file, copy-paste, **Run** (safe to re-run):
   - `scripts/supabase-payment-links-schema.sql`  → table `payment_links`
   - `scripts/supabase-mandates-schema.sql`        → table `mandates`
   - `scripts/supabase-virtual-cards-schema.sql`   → tables `virtual_wallets`, `virtual_cards`, `virtual_card_transactions`
   - `scripts/supabase-receive-links-schema.sql`   → table `receive_links`
   - Your existing `transactions` table is created on first write if missing, but run any `transactions` schema if you have it (or let `transaction-store` create via RLS).

*How to open file: In this repo `scripts/...` — open in editor, Ctrl+A, Ctrl+C.*

**Task 1.5 — Verify**
```bash
curl -s http://localhost:3000/api/health | python3 -m json.tool
# expect "supabase": { "configured": true, "transport": "npm" }
```

---

### 2) Paystack — Ghana collections (MoMo / Card / Bank Transfer) (15 mins)

**Task 2.1 — Create Ghana business account**
1. Go https://dashboard.paystack.com/#/signup → **Ghana** → business name `Valmont Pay` (or your legal name), email, password
2. Verify email → Login → **Complete Business Verification**: Ghana business docs (CAC / TIN / ID), bank account for settlement, directors. Paystack Ghana requires this before **live** keys work. **Test keys work instantly** without verification.

**Task 2.2 — Get secret keys (Settings → API Keys & Webhooks):**
- Dashboard → **Settings (gear) → API Keys & Webhooks**
- Copy:
  - `PAYSTACK_SECRET_KEY` → **Secret Key** `sk_test_xxxxx` (test) or `sk_live_xxxxx` (live — after verification)
  - `PAYSTACK_PUBLIC_KEY` → **Public Key** `pk_test_xxxxx` / `pk_live_xxxxx` (used in frontend if needed, rarely)

> How: Paystack Dashboard → Settings → API Keys & Webhooks → **Reveal** secret key.

**Task 2.3 — Add to `.env` and Vercel:**
```
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxx  # start with test, swap to sk_live later
# Optional legacy fallback (never overrides PAYSTACK_SECRET_KEY):
# WEBHOOK_SECRET=
```

**Task 2.4 — Set webhook URL (so payments land on your ledger):**
1. Same page **Settings → API Keys & Webhooks → Webhook URL** field → paste:
   ```
   https://valmontpay.app/api/webhook
   # locally: use ngrok https://xxxx.ngrok.io/api/webhook
   ```
2. Save. Tick events `charge.success` + `charge.failed` (default is all).
3. Click **Save**.

> How: Paystack Dashboard → Settings → API Keys & Webhooks → **Webhook URL** → Save.

**Task 2.5 — (Optional) Subaccounts for entitled merchants (for bank split)**
If you want `ACCT_...` to make funds split instantly to a merchant’s own bank:
1. Paystack Dashboard → **Customers → Subaccounts → Create Subaccount**
2. Enter merchant bank: **Ghana → Bank → Account number → Percentage split** e.g. `98%` to subaccount, `2%` to main
3. Copy `ACCT_xxxxxxxx` code
4. Set per tenant:
   ```
   TENANT__VALMONT_ELECTRICALS__PAYSTACK_SUBACCOUNT=ACCT_xxxxxxxx
   ```
   or via **Tenants Admin → Edit → Paystack Subaccount**

> How: Paystack → Subaccounts → Create → copy ACCT_.

**Task 2.6 — Verify**
```bash
curl -s http://localhost:3000/api/webhook-status | python3 -m json.tool
# expect webhook url shows your vercel URL, paystack key configured = true
```

---

### 3) Admin login (secure, httpOnly cookie — never leaked) (2 mins)

**Task 3.1 — Choose credentials**
- `ADMIN_EMAIL` → your admin email e.g. `support@valmontpay.com` (or your personal)
- `ADMIN_PASSWORD` → **strong random 32+ chars** from Task 0.3 (`openssl rand -base64 32`). **This is also the `X-Admin-Key` for curl scripts.**
- `ADMIN_SESSION_SECRET` → **another random 32+ chars** (or leave unset → derived from ADMIN_PASSWORD, but separate is better)

**Task 3.2 — Add to `.env` and Vercel (Production mandatory):**
```
ADMIN_EMAIL=support@valmontpay.com
ADMIN_PASSWORD=put_random_32_here
ADMIN_SESSION_SECRET=put_another_random_32_here
# optional: ADMIN_SESSION_TTL_HOURS=12
```

> ⚠️  If `ADMIN_PASSWORD` is empty on Vercel (Production), **all admin endpoints return 503** (fail-closed) — you’ll be locked out until you set it.

**Task 3.3 — Verify**
- Open `https://valmontpay.app/admin-login.html` → login with email/password → should land on `/dashboard.html`

---

### 4) Vercel — deploy (10 mins)

**Task 4.1 — Import project**
1. https://vercel.com → **Add New → Project → Import** `Valmont-pay` from GitHub
2. Framework: **Other** (Node) → Build command: *empty* (we use `server.js`)
3. **Don’t deploy yet** — first add env vars.

**Task 4.2 — Add ALL env vars to Vercel → Settings → Environment Variables → Production:**
Paste **every var from `.env`** (PAYSTACK_SECRET_KEY, SUPABASE_..., ADMIN_..., etc.) — select **Production**, **Preview**, **Development** → Save.
*Essential: `vercel.json` routes `/api/*` to serverless functions, rest to `server.js`.*

**Task 4.3 — Set domain**
- Vercel → Settings → Domains → Add `valmontpay.app` → follow DNS (CNAME / A record) → wait for TLS.

**Task 4.4 — Add fallback base URL**
```
PUBLIC_BASE_URL=https://valmontpay.app
ADDITIONAL_PUBLIC_HOSTS=checkout.valmontpay.app
```

**Task 4.5 — Deploy → Verify**
```bash
vercel --prod   # or push to main triggers auto-deploy
curl -s https://valmontpay.app/api/health | python3 -m json.tool
# expect ok:true, PAYSTACK + SUPABASE true
```

---

## PHASE 2 — VERY-SECOND INSTANT PAYOUTS (MoMo seconds, not T+1) — OPTIONAL but you asked for it

> Paystack Settlement (default) = Paystack → your bank **T+1** (next business day). **Not instant.**
> Paystack Transfer (this phase) = Paystack **balance** → MoMo **in seconds**, triggered by webhook. **Instant.**

**Task 5.1 — Enable Transfers in Paystack**
1. Paystack Dashboard → **Settings → Preferences → Transfers** (or **Settings → Payments → Transfers**) → **Enable Transfers**
2. You may need to submit settlement bank + ID for approval.

**Task 5.2 — Fund Paystack Balance**
- Dashboard → **Balance → Top up** → Bank transfer to Paystack’s Ghana settlement account (or let a test payment fund it).
- **Critical:** Transfers are paid from **balance**, not from pending settlement. If balance is GH₵0, Transfer fails even with flag = 1.

**Task 5.3 — Set env:**
```
PAYSTACK_TRANSFER_ENABLED=1
# PAYSTACK_TRANSFER_REASON=Valmont Pay payout  (optional, max 100 chars)
```

> How: Vercel → Env → Add `PAYSTACK_TRANSFER_ENABLED=1` (string **exactly** `1`, not `true`), Redeploy.

**Task 5.4 — Why safety switch?**
- `=1` → webhook auto-creates `mobile_money` recipient + `POST /transfer` GH₵ amount → MoMo in seconds. **Real money moves.**
- Unset / `0` → webhook is **DRY RUN** (logs `would have paid GH₵33 → 0544...` but moves nothing). Safe to test with `sk_test`.

**Task 5.5 — Verify**
```bash
curl -s https://valmontpay.app/api/v1/payouts/health | python3 -m json.tool
# transfer_enabled:true, paystack_balance: { ... }

# Create a Pay Me → MoMo link, pay GH₵1 (test MoMo 0544000000), then:
curl -s https://valmontpay.app/api/v1/payouts/VP-xxx | python3 -m json.tool
# expect payout.ok:true or dryRun:false when live
```

---

## PHASE 3 — INSTANT RECEIPT SMS / WhatsApp (Arkesel / mNotify) (10 mins)

**Task 6.1 — Choose provider(s) — you can set ALL, we fire all:**

| Provider | Ghana | How to get | Env | Sender ID |
|---|---|---|---|---|
| **Arkesel** | **Recommended Ghana SMS** | https://arkesel.com → Sign up → **Dashboard → SMS API → API Key** (copy) + **Sender IDs → Request New** (`VALMONT-PAY`, 11 chars max, A-Z0-9,  approval 2-12hrs) | `ARKESEL_API_KEY` + `ARKESEL_SENDER_ID` | 11 chars max |
| **mNotify** | Alternative Ghana SMS | https://mnotify.com → Register → **Settings → API Keys** → copy **API Key** → **Sender IDs** → Request `VALMONT-PAY` | `MNOTIFY_API_KEY` + `MNOTIFY_SENDER_ID` | 11 chars |
| **WhatsApp** | Any WhatsApp business hook | Use Twilio 360dialog / your own `whatsapp-web.js` server → exposes `POST /send` expecting `{phone, message, reference}` | `WHATSAPP_WEBHOOK_URL=https://your-hook.example/send` | N/A |
| **Generic SMS** | Any SMS gateway | Same JSON shape `POST {phone, message, reference}` | `SMS_WEBHOOK_URL` | N/A |

**Task 6.2 — Add to Vercel (example Arkesel Ghana):**
```
ARKESEL_API_KEY=Ark_xxxxxxxxxxxx
ARKESEL_SENDER_ID=VALMONT-PAY
MERCHANT_NOTIFICATION_PHONE=0544000000   # your phone — you get copy of every receipt
ADMIN_NOTIFICATION_PHONE=0544000000      # fallback
# per-tenant override (optional):
# TENANT__VALMONT_ELECTRICALS__NOTIFICATION_PHONE=0544000000
```

> How: Arkesel → SMS API → Copy **API Key** (header `api-key`). Sender ID → **Request VALMONT-PAY** → wait approval email.

**Task 6.3 — Test without real payment:**
```bash
curl -X POST https://sms.arkesel.com/api/v2/sms/send \
  -H "api-key: $ARKESEL_API_KEY" -H "Content-Type: application/json" \
  -d '{"sender":"VALMONT-PAY","message":"Test from Valmont Pay GH₵1.00","recipients":["233544000000"]}'

# Or trigger via Valmont webhook (sends via notifier):
# Pay a test GH₵1 link, then check Vercel logs: [VALMONT-NOTIFIER] ✓ arkesel-sms → customer ...
```

**Task 6.4 — Cost**
- Arkesel: ~GH₵0.035–0.05 / SMS (pay-as-you-go, top up wallet in Arkesel dashboard). Sender ID free.
- mNotify: similar.

---

## PHASE 4 — VIRTUAL CARD (MoMo → USD Visa) (5 mins to launch closed-loop, then provider for real Visa)

**Task 7.1 — Enable feature (already code-live):**
- Page: `/virtual-card.html` → customer enters email → **Create Card** → fund GH₵ via MoMo → card shows `4832 46...` (demo BIN).

**Task 7.2 — Make durable (if you want cards to survive cold starts):**
- Already run `scripts/supabase-virtual-cards-schema.sql` in Task 1.4.

**Task 7.3 — FX rate (optional):**
```
VIRTUAL_CARD_FX_RATE=15.8  # GHS per USD, default 15.8, override per deploy
```

**Task 7.4 — For REAL Visa that works on Netflix/Amazon (Phase 2, not closed-loop):**
1. Create provider: https://strowallet.co or https://maplerad.com → Business KYC → Get **API Key** (Strowallet → Dashboard → API → Secret Key `sk_...`)
2. Set:
   ```
   STROWALLET_API_KEY=sk_...   # or MAPLERAD_SECRET
   STROWALLET_API_URL=https://api.strowallet.co/v1
   ```
3. In `lib/virtual-card-store.js` we wire `create card` + `fund` calls (1-file change) — ask us and we’ll wire it when you have keys.

---

## PHASE 5 — RECEIVE LINKS (Pay Me to any entitled account) (already live)

**Task 8.1 — Already works:** `/receive.html`
- Receiver chooses **MoMo** `054...` (recommended for instant via Transfer) / **Bank** `GCB ...` (T+1) / **ACCT_...** (instant split)
- Share `receive.html?code=rv_...` — payer pays → funds land per task 5 if MoMo.

**Task 8.2 — Durable:** Already run `scripts/supabase-receive-links-schema.sql` in Task 1.4.

---

## ENV REFERENCE — ALL VARS IN ONE TABLE

| Var | Required? | Where to get it | Example |
|---|---|---|---|
| `PAYSTACK_SECRET_KEY` | **YES** | Paystack Dashboard → Settings → API Keys & Webhooks → Secret Key → Reveal → copy `sk_test/live` | `sk_test_xxxxx` |
| `SUPABASE_URL` | **YES** | Supabase → Project Settings → API → Project URL | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **YES** | Same page → service_role → Reveal | `eyJ...` |
| `SUPABASE_ANON_KEY` | fallback | Same page → anon | `eyJ...` |
| `ADMIN_EMAIL` | **YES** | You choose | `support@valmontpay.com` |
| `ADMIN_PASSWORD` | **YES** (Production) | `openssl rand -base64 32` | `aB3...` |
| `ADMIN_SESSION_SECRET` | recommended | `openssl rand -base64 32` (separate random) | `xYz...` |
| `PUBLIC_BASE_URL` | recommended | `https://valmontpay.app` | `https://valmontpay.app` |
| `PAYSTACK_TRANSFER_ENABLED` | for instant MoMo | Set to exactly `1` in Vercel when ready (see Phase 2) | `1` |
| `ARKESEL_API_KEY` | for SMS | Arkesel → SMS API → API Key | `Ark_...` |
| `ARKESEL_SENDER_ID` | for SMS | Arkesel → Sender IDs → Request `VALMONT-PAY` (11 chars) | `VALMONT-PAY` |
| `MNOTIFY_API_KEY` | alt SMS | mNotify → Settings → API Keys | `...` |
| `MNOTIFY_SENDER_ID` | alt SMS | mNotify → Sender IDs → Request | `VALMONT-PAY` |
| `MERCHANT_NOTIFICATION_PHONE` | for receipts | Your Ghana phone `0544...` | `0544000000` |
| `VIRTUAL_CARD_FX_RATE` | optional | You set | `15.8` |
| `PAYMENT_LINK_TTL_HOURS` | optional | Default 720 | `720` |
| `TENANT__...` | optional multi-tenant | You define per merchant | — |
| `WEBHOOK_SECRET` | legacy | Only if no Paystack key | — |
| `WHATSAPP_WEBHOOK_URL` / `SMS_WEBHOOK_URL` | optional hooks | Your Twilio / custom server URL | `https://.../send` |

> **Never commit `.env` to git.** Only `.env.example` is committed. Real secrets live in **Vercel Env** and local `.env` (gitignored).

---

## VERIFICATION CHECKLIST (after every deploy)

```bash
curl -s https://valmontpay.app/api/health | python3 -m json.tool
# ok:true, supabase:true, paystack:true ?

curl -s https://valmontpay.app/api/webhook-status | python3 -m json.tool
# webhook url = https://valmontpay.app/api/webhook ?

# Create a pay link as admin (use your ADMIN_PASSWORD as X-Admin-Key):
curl -X POST https://valmontpay.app/api/v1/transaction/initialize \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_PASSWORD" \
  -d '{"email":"test@example.com","amount":1,"merchant":"Valmont-Pay"}' | python3 -m json.tool
# → pay.html?access_code=ac_...

# Pay Me instant check:
curl -s https://valmontpay.app/api/v1/payouts/health | python3 -m json.tool
# transfer_enabled reflects PAYSTACK_TRANSFER_ENABLED

# Test SMS (if Arkesel set):
# Check Vercel Logs → [VALMONT-NOTIFIER] ✓ arkesel-sms → customer ...
```

---

## TENANT SETUP (if you host multiple merchants)

**Option A — In UI (easiest):**
- Login → `/tenants.html` → **Create Tenant** → fill display_name, brand_color, settlement_account, webhook_url → Save → copy generated `SECRET_KEY_1`.

**Option B — In env (for GitOps):**
```
TENANT__MERO_MART__DISPLAY_NAME=Mero Mart
TENANT__MERO_MART__SECRET_KEY_1=mr_live_secret_abc
TENANT__MERO_MART__PAYSTACK_SECRET_KEY=sk_live_mero_xxx
TENANT__MERO_MART__PAYSTACK_SUBACCOUNT=ACCT_mero_xxx
TENANT__MERO_MART__ALLOWED_DOMAINS=meromart.com,valmontpay.app
```

Merchant then calls API with `Authorization: Bearer mr_live_secret_abc`.

---

## OPTIONAL / LEAVE UNSET

- `ALLOW_LEGACY_AMOUNT_URL` → **LEAVE UNSET** (legacy pay.html?amount flow, retired)
- `CHARGE_SETTLEMENT_DELAY_MS` → default 2000, only for demo delay
- `SERVICE_PRICE__WEB_LITE_STG1` etc. → only to override SKU prices

---

**Need help with any single step?** Tell me which task number (e.g. `2.2` or `6.1`) and I’ll walk you through that screen click-by-click.
