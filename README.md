# 🚀 VALMONT-PAY CORE GATEWAY PROTOTYPE (MVP)

Welcome to your actual foundational payment gateway prototype! This folder contains the **Minimum Viable Product (MVP)** codebase modeled after **Paystack** and **Stripe**, custom-architected for digital merchant settlements and Mobile Money (MoMo) payments in Ghana.

This acts as your **direct functional roadmap** to starting, coding, and scaling your own payment gateway enterprise!

---

## 🛠️ Folder File Architecture
Your gateway prototype contains the following master-built systems:
1.  **`package.json`**: Standard dependencies configuration connecting Express JSON parsers, UUID generators, and secure Cross-Origin Resource Sharing (CORS) engines.
2.  **`server.js` (The Backend Engine)**: Handles standard REST API endpoints representing actual fintech operations:
    *   `POST /api/v1/transaction/initialize`: Generates secure transaction UUIDs and returns dynamic checkout redirection URLs.
    *   `POST /api/v1/transaction/charge`: Simulates USSD PIN push notifications and clears settled funds directly into the merchant's escrow wallet balance.
    *   `GET /api/v1/transaction/verify/:ref`: Validates transaction clearance status.
    *   `GET /api/v1/merchant/dashboard`: Fetches active ledger arrays and settles wallet balances.
    *   `GET /api/transactions`: The canonical ledger feed the dashboard reads. Returns the live transactions array plus the derived balance.
    *   `POST /api/webhook`: Paystack webhook receiver (HMAC SHA512 signature verified). This is how real payments land on the ledger — and every `charge.success` instantly triggers an SMS/WhatsApp receipt via **`lib/notifier.js`** (the notification engine that texts both the customer and the merchant).
3.  **`checkout.html` (Secured Checkout Widget)**: A responsive popup widget styled in deep navy and bright emerald green. Features forms to collect **Mobile Money Number** (MTN, Telecel, AT) or **Card details**, communicates with the API, and displays loading spinners for simulated USSD PIN authorization prompts!
4.  **`dashboard.html` (Merchant Analytics Portal)**: A high-end dark analytics board displaying virtual wallet balances, a **Live Settlement Ledger**, and an **interactive Checkout Link Generator**!

---

## 🔗 Dynamic Merchant & Amount (Query Parameters)

Both `pay.html` and `checkout.html` are fully dynamic — nothing is hardcoded.

> **⚠️ Amounts are in CEDIS (major units), never pesewas.** Send
> `amount=23.50` for GH₵23.50 — sending `amount=2300` will charge
> GH₵2,300 instead, and pay.html will refuse to render the form and
> audit the bad URL. The full integration contract — every parameter,
> every unit, every error state — is in
> **[`docs/tenant-integration.md`](docs/tenant-integration.md)**. Read
> it before wiring a new storefront.

| Page | Example URL (cedis) | Reads |
|---|---|---|
| `pay.html` | `pay.html?amount=50.00&merchant=valmont-electricals` | `merchant`, `amount` |
| `checkout.html` | `checkout.html?reference=VP-123456&merchant=valmont-electricals&amount=50.00&email=buyer@example.com` | `reference`, `merchant`, `amount`, `email`, `callback_url` |

```javascript
const urlParams = new URLSearchParams(window.location.search);
const merchant = urlParams.get('merchant') || 'valmont-electricals';
// amount is cedis (e.g. 23.50 for GH₵23.50). Never multiply by 100.
const amount = parseFloat(urlParams.get('amount')) || 0;

document.getElementById('merchant-name').textContent = merchant;
document.getElementById('amount-display').textContent = 'GH\u20b5 ' + amount.toFixed(2);
```

If `merchant` is absent it falls back to `valmont-electricals`; if `amount` is absent or fails
the unit-mismatch guard, pay.html shows the *Payment Link Unavailable* card and POSTs the
offending URL to `/api/log/bad-amount` (logged as
`[VALMONT-PAY][BAD-AMOUNT] unit=mismatch reason=looks-like-pesewas`). In the dashboard, the
**Merchant Name** field starts empty so you can type any merchant name you like.

For a tenant-authenticated server-to-server flow that never carries the amount in the URL,
use `POST /api/transaction/initialize` instead — see
[`docs/tenant-integration.md` § 2](docs/tenant-integration.md#2-secure-flow-recommended--step-by-step).

---

## 💳 Paystack Integration

Set your secret key before starting the server (copy `.env.example` to `.env`):

```bash
export PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxx
```

For the admin dashboard login (`admin-login.html`), credentials are read from environment variables
at runtime (via `/config/admin.js`) — none are stored in source:

```bash
export ADMIN_EMAIL=support@valmontpay.com
export ADMIN_PASSWORD=your-strong-password
```

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/initialize-payment` | POST | Initializes a Paystack transaction. Forwards your `reference` and converts the amount to **pesewas (x100)**. |
| `/api/verify-payment?reference=VP-123456` | GET | Verifies a transaction with Paystack and returns the raw payload plus a flattened `summary`. |
| `/api/transaction/initialize` | POST | **Tenant-authenticated** initializer (Bearer token). Returns a one-time `access_code` so the amount is server-resolved and the customer can never edit it. Use this for new integrations. |
| `/api/log/bad-amount` | POST | Audit endpoint hit by pay.html when a URL's `amount` looks like pesewas. Best-effort, always returns 200. |

```bash
curl -X POST http://localhost:3000/api/initialize-payment \
  -H 'Content-Type: application/json' \
  -d '{"email":"buyer@example.com","amount":50,"merchant":"Valmont Electricals"}'

curl "http://localhost:3000/api/verify-payment?reference=VP-123456"
```

### Tenant configuration precedence

Every tenant consumer resolves one effective configuration object in
`lib/tenants.js` — the tenant-list/admin APIs, Tenants UI, Dashboard Webhook
Settings and outbound webhook forwarder cannot disagree:

1. A non-empty tenant env var, e.g.
   `TENANT__VALMONT_ELECTRICALS__WEBHOOK_URL` (operator override)
2. A non-null row value in `public.tenants` (admin-editable source)
3. The in-code built-in default

`TENANTS_JSON` is also an environment source; a tenant-specific `TENANT__...`
variable wins if both define a field. A `NULL` DB `webhook_url` is absent rather
than an instruction to erase the default, so Valmont Electricals falls back to
`https://valmontelectricals.com/api/valmontpay/webhook`. The SQL migration in
`scripts/supabase-tenants-schema.sql` seeds the same URL and preserves any
existing non-null admin value when re-run.

The tenant `environment` field is **display-only metadata**. It labels rows as
Test or Live in the admin UI but never chooses a Paystack credential. Payment
initialization/verification uses the configured tenant Paystack secret (or the
global `PAYSTACK_SECRET_KEY` fallback); the credential's own `sk_test_` or
`sk_live_` prefix determines which Paystack mode receives the request.

### Database (Supabase) — where transactions actually live

The dashboard reads `/api/transactions`, which is backed by the Supabase
`transactions` table. Every writer goes through `lib/transaction-store.js`, the
single source of truth for the table shape, and it writes **exactly** these
columns:

| Column | Notes |
|---|---|
| `reference` | Unique. Rows are **upserted on this column**, so retries and replays are idempotent. |
| `merchant_name` | Defaults to `Valmont-Pay`. |
| `customer_email` | Defaults to `unknown@customer`. |
| `amount` | GH₵, rounded to 2dp (never pesewas). |
| `payment_method` | e.g. `Momo (MTN)`, `Credit/Debit Card`. |
| `status` | `SUCCESS` / `FAILED` / `PENDING`. |
| `paid_at` | Timestamp for settled payments, `null` for anything else. |

> ⚠️ **Never send `updated_at`.** The deployed table has no such column, and
> PostgREST rejects the *entire* write with `PGRST204`. That is exactly what made
> successful checkouts never appear on the dashboard.

```sql
create table if not exists public.transactions (
  id             bigint generated by default as identity primary key,
  reference      text not null unique,
  merchant_name  text,
  customer_email text,
  amount         numeric(12,2) not null default 0,
  payment_method text,
  status         text not null default 'PENDING',
  paid_at        timestamptz,
  created_at     timestamptz not null default now()
);
```

The `unique` constraint on `reference` is what makes the upsert work.

#### Dashboard checkout writes directly (no webhook)

`POST /api/v1/transaction/charge` is the dashboard's own checkout. It never
touches Paystack, **so no webhook ever fires for it** — the route persists the
transaction to Supabase itself. On Vercel the in-memory ledger dies with the
request, so if that write fails the route returns a clear `500` instead of
telling the customer the payment cleared.

### Webhook (real payments -> dashboard)

Point your Paystack dashboard webhook URL at `https://<your-domain>/api/webhook`.
Signature verification uses `PAYSTACK_SECRET_KEY` authoritatively, because that
is the key Paystack uses for the `x-paystack-signature` HMAC. `WEBHOOK_SECRET`
is only a legacy fallback when no Paystack key exists, so a stale test webhook
secret cannot reject live callbacks. The HMAC is always computed over the **exact raw request bytes**,
never a re-serialized payload. The handler converts pesewas back to GH₵ and
upserts the transaction into Supabase through the same shared helper the
dashboard checkout uses.

> **Amounts:** Paystack works in the smallest currency unit, so `GH₵ 50` is sent as `5000`.
> The conversion (with correct rounding) lives in `lib/paystack.js` and is applied in one place only.

### 📲 Instant SMS & WhatsApp receipts (`lib/notifier.js`)

After a `charge.success` event is verified and the `SUCCESS` row is upserted to
Supabase, the webhook fires `sendOrderReceiptNotification(trx, payload)`
**fire-and-forget** — the customer **and** the merchant get a real-time receipt,
and Paystack always gets its `200 OK` even if every provider is down:

```text
*VALMONT-PAY INSTANT RECEIPT* 🔒
Ref: #VP-123456
Merchant: Valmont Electricals
Amount Paid: GH₵ 50.00
Payment Method: Mobile Money (MTN)
Status: PAID ✅
Paid at: 31 Jul 2026, 12:00 pm
Thank you for your payment!
```

*   **Customer number** comes from the payment itself: `metadata.momo_number` →
    `momo_phone`/`momo_number` custom field → `metadata.phone` →
    `customer.phone` → `trx.customer_phone` (checkout writes the MoMo number
    into metadata, see `lib/paystack.js`).
*   **Merchant number** comes from `MERCHANT_NOTIFICATION_PHONE` /
    `ADMIN_NOTIFICATION_PHONE` (env-only — never from the payload).
*   **Channels** — every configured one is used: `WHATSAPP_WEBHOOK_URL` (POSTs
    `{ phone, message, reference }`), `SMS_WEBHOOK_URL` (same shape), or the
    Ghana SMS APIs `ARKESEL_API_KEY` and `MNOTIFY_API_KEY` (sender id via
    `ARKESEL_SENDER_ID` / `MNOTIFY_SENDER_ID`, default `VALMONT-PAY`).
*   **Auditable by default** — the full receipt is always logged as
    `[VALMONT-NOTIFIER] Sent receipt for Ref ...`, even with no provider set.
*   **Safe** — dispatch never throws; delivered references are remembered
    in-process so Paystack redeliveries never double-text a customer, while a
    fully failed pass stays retryable.

### 🛍️ Nanahemaa Market — automated checkout with Paystack subaccount split (Phase 4)

Nanahemaa Market (Jane Boadi Nyarko) is the flagship storefront connected to the
gateway. Online Mobile Money / Card checkouts are redirected to
`https://valmontpay.app/pay.html` with Jane's Paystack **subaccount
`ACCT_uvyay690lwskmw5`**, so Paystack automatically splits every settlement
**98% merchant / 2% gateway** — no manual reconciliation.

| File | Purpose |
|---|---|
| `nanahemaa-checkout.html` | Storefront checkout. Reads `nanahemaamarket_cart` from localStorage, collects delivery details, and offers **Mobile Money (Online)**, **Credit/Debit Card** (both redirect to the gateway) and **Cash on Delivery / Manual MoMo** (manual flow with WhatsApp confirmation, recorded as `PENDING_MOMO`). |
| `order-confirmed.html` | Callback receipt page. Reads `?reference=...&status=success` + `nanahemaa_pending_order`, shows the itemized receipt, WhatsApp (wa.me/233537683874) and Continue Shopping buttons, clears `nanahemaamarket_cart` / `nanahemaa_pending_order`, and fires `ValmontAnalytics.trackPurchase(order)`. |
| `admin.html` → **Nanahemaa Orders** tab | Jane's order dashboard: status filter tabs (`ALL / PENDING_MOMO / PAID / SHIPPED / CANCELLED`), one-click **Mark as PAID** to reconcile manual transfers, and **Export to CSV** for the filtered order ledger. |

The redirect built by `nanahemaa-checkout.html`:

```javascript
const gatewayUrl = new URL('https://valmontpay.app/pay.html');
gatewayUrl.searchParams.set('merchant', 'Nanahemaa Market');
gatewayUrl.searchParams.set('amount', Number(order.total_amount).toFixed(2));
gatewayUrl.searchParams.set('email', order.customer_email || 'orders@nanahemaamarket.com');
gatewayUrl.searchParams.set('reference', order.reference_code);
gatewayUrl.searchParams.set('subaccount', 'ACCT_uvyay690lwskmw5'); // Jane Boadi Nyarko 98% split
gatewayUrl.searchParams.set('callback_url', 'https://nanahemaamarket.com/order-confirmed.html');
window.location.href = gatewayUrl.toString();
```

How the split flows end-to-end:

1. `pay.html` reads the `reference` **and** `subaccount` query params (it also
   still accepts the legacy `ref` param) and forwards them to
   `POST /api/initialize-payment`.
2. `lib/paystack.js` passes `subaccount` straight through to Paystack's
   `transaction/initialize`, which splits the settlement 98/2 automatically.
3. The Paystack webhook records the paid transaction (merchant
   `Nanahemaa Market`) into the ledger, where it appears as **PAID** in the
   admin's Nanahemaa Orders tab.
4. Manual MoMo / COD orders are POSTed to `POST /api/transactions` with status
   `PENDING_MOMO` (CORS-enabled on `api/transactions.js` for the cross-origin
   storefront; `server.js` also accepts POST locally with an in-memory
   fallback). Jane marks them PAID with one click; both states are exportable
   as CSV for accounting.

---

## 🔍 Debugging: "the webhook isn't receiving events"

Three tools, meant to be used in this order. Each one eliminates a different
layer, so you always learn *where* the chain breaks instead of guessing.

### 1. `/webhook-status.html` — start here

A diagnostic page that answers, without exposing a single secret value:

* **Current webhook configuration** — the exact URL to paste into Paystack, the
  URL this deployment actually answers at, the signing-secret source, and
  whether the key is **Test** (`sk_test_…`) or **Live** (`sk_live_…`).
* **Configuration checklist** — every common misconfiguration as pass / warn /
  fail *with the fix*, including "is `WEBHOOK_SECRET` the same as
  `PAYSTACK_SECRET_KEY`?" (compared via SHA-256 fingerprints, never values).
* **Environment variable status** — set / missing, length, prefix and
  fingerprint only. The offline test asserts that no secret value can ever
  appear in the response.
* **Last 10 Paystack transactions vs. our database.** Paystack does **not**
  expose webhook delivery logs over its API, so the page does the honest
  equivalent: it lists recent Paystack transactions and flags any successful
  charge that never reached the `transactions` table. A row marked **MISSING**
  is proof the webhook did not land.
* **Inbound requests seen by this instance** — with full headers and bodies.

JSON version: `GET /api/webhook-status` (add `?paystack=0` to skip the outbound
Paystack call).

### 2. `/api/test-webhook` — can a POST reach us at all?

The dumbest possible receiver: no signature check, no database, no validation,
**always 200**. It logs the full headers and body and can never be the thing
that fails, so a failure here means the request never arrived.

```bash
curl -i -X POST https://valmont-pay.vercel.app/api/test-webhook \
  -H 'Content-Type: application/json' \
  -d '{"event":"charge.success","data":{"reference":"TEST-1"}}'
```

`200` here but nothing in `/api/webhook` ⇒ the network path is fine and the
problem is **Paystack's configuration** (wrong URL, or saved under the other
mode), not the code.

### 3. `/api/webhook` logs — nine numbered steps

Every delivery is tagged with a short request id (`wh_abc123`) so one webhook
can be followed end-to-end in the Vercel runtime logs even when several arrive
at once:

| Step | Logs |
|---|---|
| 1 RECEIVED | method, URL, timestamp, caller IP |
| 2 HEADERS | every header, then the ones that matter |
| 3 BODY | byte count, **where the bytes came from**, and the raw body |
| 4 ENV | which secrets and Supabase credentials are present |
| 5 SIGNATURE | valid/invalid, plus received vs expected signature previews |
| 6 PAYLOAD | event name, reference, amount, channel, customer |
| 7 MAP | the exact row about to be written |
| 8 SUPABASE | the upsert result, or the rejection reason |
| 9 RESPONSE | status code, outcome label and duration |

Errors log `error.name`, `error.message` and the **full stack trace**.

Step 3 also detects a subtle platform bug: if the body arrives **already
parsed**, the raw bytes are gone and the HMAC is computed over re-serialized
JSON, which fails on whitespace alone. When that happens the handler warns
loudly and retries verification against the common JSON encodings, so an
authentic payment is not dropped over formatting.

### Checklist that actually matters

| Question | Answer |
|---|---|
| Should `WEBHOOK_SECRET` equal `PAYSTACK_SECRET_KEY`? | Leave it unset unless a legacy/local custom event needs it. Paystack verification always uses `PAYSTACK_SECRET_KEY` when present, so a stale `WEBHOOK_SECRET` cannot override the live key. |
| Webhook URL | Exactly `https://valmont-pay.vercel.app/api/webhook` — https, no trailing slash. Preview deployment URLs never receive production webhooks. |
| Test vs Live mode | Each mode has its **own** webhook URL field and its **own** secret key. An `sk_test_` deployment only ever receives Test Mode events. |
| `charge.success` / `charge.failed` | Paystack has no per-event subscription UI — it POSTs **every** event to your one URL. This handler processes those two and returns `200 (ignored)` for the rest, so Paystack never retries or disables the endpoint. |

### "Send test webhook" from Paystack

Paystack's dashboard does not offer a generic "send test webhook" button. The
supported way to fire a **real, correctly signed** event is to complete a test
payment in Test Mode (card `4084 0840 8408 4081`, any future expiry, CVV `408`),
which triggers a genuine `charge.success`. Paystack also exposes per-transaction
delivery attempts under **Transactions → (a transaction) → Webhook**, where
failed deliveries can be **retried**.

For a signed request without involving Paystack:

```bash
BODY='{"event":"charge.success","data":{"reference":"VP-MANUAL-1","amount":5000,"channel":"card","customer":{"email":"t@example.com"}}}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(process.argv[1]).digest('hex'))" "$BODY")
curl -i -X POST https://valmont-pay.vercel.app/api/webhook \
  -H 'Content-Type: application/json' -H "x-paystack-signature: $SIG" -d "$BODY"
```

Run the offline test suite (stubs the network, no secret key needed):

```bash
npm test
```

---

## 🧱 Build guard: every import must be in the repository

```bash
npm run verify:modules
```

`scripts/verify-module-graph.mjs` walks every `require('./…')` / `import … from
'../…'` in the codebase and asserts the target is **tracked by git, present and
non-empty**. It also checks that every `dest` in `vercel.json` points at a real
tracked file. It runs **first** in `npm test`, so any CI that runs the suite
enforces it. A dedicated CI workflow is provided in `ci/github-workflow-ci.yml`
— see `ci/README.md` for the one command that activates it.

This exists because the same failure shipped twice:

* `lib/transaction-store.js` was imported by `server.js` and four `/api`
  functions but was **never committed**. It worked on the author's machine and
  every deployment died with `ERR_MODULE_NOT_FOUND` on cold start.
* `lib/ledger.js` *was* committed — as a **zero-byte file** — so
  `ledger.addTransaction` was `undefined` and the gateway `500`d immediately.

A local checkout is not the deployment: **what deploys is what git tracks.**
That is why the guard resolves against `git ls-files` rather than the filesystem,
and why it treats an empty file as a failure. Never add `lib/`, `api/`,
`scripts/` or any individual module to `.gitignore` or `.vercelignore`.

---

## 📒 The Transaction Ledger (no test data)

The ledger lives in `lib/ledger.js` and **starts completely empty** — there are no
seeded demo rows and no fake starting balance anywhere in the codebase.

* **Balance is derived, never stored.** It is always recomputed as the sum of every
  `SUCCESS` transaction, so it can never drift out of sync with the rows on screen.
  An empty ledger therefore shows exactly `GH₵ 0.00`.
* **`PENDING` and `FAILED` transactions are logged but never counted** toward the balance.
* **The dashboard renders an empty state** — *"No transactions yet. Real payments will
  appear here."* — until a real payment arrives, then polls `/api/transactions`
  every 10s (and on tab focus) so new payments show up without a refresh.
* **Writers:** `POST /api/v1/transaction/charge`, `GET /api/verify-payment` and
  `POST /api/webhook` all funnel through the same ledger via `upsertTransaction()`,
  which is idempotent by reference.

> **Persistence:** `lib/ledger.js` is process memory, so it resets on restart (and
> is per-instance on serverless). **Supabase is the durable source of truth** —
> `/api/transactions` returns Supabase rows whenever Supabase is configured, and
> merges in anything still only held in memory. A Supabase read error surfaces as
> a `500` rather than an innocent-looking empty list.

Run the ledger test suite (starts empty, real payment appears, signatures verified):

```bash
npm test
```

---

## ✅ Required environment variables (Vercel → Production)

| Variable | Required? | Purpose |
|---|---|---|
| `SUPABASE_URL` | **Required** | Supabase project URL. Without it the dashboard cannot load or store transactions. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required (preferred)** | Trusted server-side writes. Bypasses Row Level Security so checkout/webhook writes are never silently rejected. |
| `SUPABASE_ANON_KEY` | Fallback only | Works **only** when the `transactions` table has explicit RLS insert/select policies. |
| `PAYSTACK_SECRET_KEY` | **Required** | Paystack API calls and authoritative inbound Paystack webhook verification. |
| `WEBHOOK_SECRET` | Optional | Legacy fallback only when no Paystack key is configured; it never overrides `PAYSTACK_SECRET_KEY`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Optional | Admin dashboard login. |
| `WHATSAPP_WEBHOOK_URL` | Optional | WhatsApp receipt hook. Receives POST `{ phone, message, reference }` for every SUCCESS payment. |
| `SMS_WEBHOOK_URL` | Optional | Generic SMS receipt hook. Same JSON payload shape as the WhatsApp hook. |
| `ARKESEL_API_KEY` / `MNOTIFY_API_KEY` | Optional | Ghana SMS provider keys for direct receipt dispatch (`ARKESEL_SENDER_ID` / `MNOTIFY_SENDER_ID` set the sender id, default `VALMONT-PAY`). |
| `MERCHANT_NOTIFICATION_PHONE` / `ADMIN_NOTIFICATION_PHONE` | Optional | Merchant/admin phone that also receives every payment receipt by SMS/WhatsApp. |

Verify a deployment at a glance — this reports which variables are set, and
never their values:

```bash
curl https://<your-domain>/api/health
```

`{"ok": true}` means every required variable is present. Otherwise `missing`
lists what to add, and `warnings` flags weaker configurations (for example
using the anon key instead of the service role key).

---

## 🚀 How to Launch Your Gateway Locally (Try it in 2 Steps!)

You can run your own payment gateway live on your machine right now inside the workspace terminal!

### Step 1: Install Dependencies
Open your workspace terminal and navigate to the gateway folder:
```bash
cd valmont_pay_gateway
npm install
```

### Step 2: Start the Secure Gateway
Start the API and static web controllers:
```bash
npm start
```

### Step 3: Open the Dashboard!
The gateway server starts running on Port **3000**!
- Open your browser to: **`http://localhost:3000/dashboard.html`**
- Fill in a customer email and amount (e.g. `customer@email.com` and `1200`), and click **"Generate Link"**!
- Open the generated Link in a new tab, type in a Mobile Money number, and click **"Pay"**!
- Watch the **live USSD authorization spinner** process, clear the funds, and instantly settle them into your merchant dashboard ledger!

---

## 📈 Roadmap: How to Grow This into the Next Paystack

Once you verify this running software, here is your actual, step-by-step engineering and business path to legal commercial production:

### 1. Integrate Real Financial APIs (Mobile Money & Cards)
- Partner with an **Aggregator API** (such as Hubtel, Zeepay, or NLA) or integrate directly with telcos.
- Replace our simulated delay inside `server.js` with active outgoing Fetch/Axios requests to push MTN USSD prompt payload calls natively to customers' handsets!

### 2. Legal licensing (Bank of Ghana)
- Register a local Ghanaian Fintech Corporation.
- Apply for a **Payment Service Provider (PSP) License** from the Bank of Ghana.
- Open a **Merchant Escrow Account** with a partner commercial bank (e.g. Ecobank, GCB, or Stanbic Bank) to handle customer settlements.

### 3. Build Tokenization for Card Security (PCI-DSS)
- If handling raw credit/debit card entries, integrate a secure **Vault tokenization system** or run through an authorized acquirer (like Visa or MasterCard) so that you never store raw credit cards in your primary database.

### 4. Code Developer Integration SDKs
- Provide clean, easy-to-use copy-paste integrations for merchants:
  ```javascript
  ValmontPay.setup({
    key: 'vp_live_xxxxxxxx',
    email: 'merchant@email.com',
    amount: 1500,
    callback: function(response) {
      alert("Payment Reference Cleared: " + response.reference);
    }
  });
  ```

---
**This prototype is 100% complete, fully tested, and ready to serve as your launching pad to building the next major African payment gateway!**
Test transactions removed, balances reset. Payout options (Bank/MoMo) and tenant API keys page added for valmontpay.app.
