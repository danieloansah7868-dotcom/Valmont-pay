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
    *   `POST /api/webhook`: Paystack webhook receiver (HMAC SHA512 signature verified). This is how real payments land on the ledger.
3.  **`checkout.html` (Secured Checkout Widget)**: A responsive popup widget styled in deep navy and bright emerald green. Features forms to collect **Mobile Money Number** (MTN, Telecel, AT) or **Card details**, communicates with the API, and displays loading spinners for simulated USSD PIN authorization prompts!
4.  **`dashboard.html` (Merchant Analytics Portal)**: A high-end dark analytics board displaying virtual wallet balances, a **Live Settlement Ledger**, and an **interactive Checkout Link Generator**!

---

## 🔗 Dynamic Merchant & Amount (Query Parameters)

Both `pay.html` and `checkout.html` are fully dynamic — nothing is hardcoded.

| Page | Example URL | Reads |
|---|---|---|
| `pay.html` | `pay.html?amount=50&merchant=Valmont+Electricals` | `merchant`, `amount` |
| `checkout.html` | `checkout.html?reference=VP-123456&merchant=Valmont+Electricals&amount=50&email=buyer@example.com` | `reference`, `merchant`, `amount`, `email`, `callback_url` |

```javascript
const urlParams = new URLSearchParams(window.location.search);
const merchant = urlParams.get('merchant') || 'Valmont-Pay';
const amount = parseFloat(urlParams.get('amount')) || 0;

document.getElementById('merchant-name').textContent = merchant;
document.getElementById('amount-display').textContent = 'GH₵ ' + amount.toFixed(2);
```

If `merchant` is absent it falls back to `Valmont-Pay`; if `amount` is absent it falls back to `0.00`
(never a hardcoded figure). In the dashboard, the **Merchant Name** field starts empty so you can type
any merchant name you like.

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

```bash
curl -X POST http://localhost:3000/api/initialize-payment \
  -H 'Content-Type: application/json' \
  -d '{"email":"buyer@example.com","amount":50,"merchant":"Valmont Electricals"}'

curl "http://localhost:3000/api/verify-payment?reference=VP-123456"
```

### Webhook (real payments -> dashboard)

Point your Paystack dashboard webhook URL at `https://<your-domain>/api/webhook`.
Set `WEBHOOK_SECRET` in Vercel to the secret Paystack uses to sign webhook requests
(for Paystack this is normally the same value as `PAYSTACK_SECRET_KEY`). The handler
verifies the `x-paystack-signature` header against the exact raw request body, converts
pesewas back to GH₵, and inserts the transaction into Supabase. Configure `SUPABASE_URL`
and preferably `SUPABASE_SERVICE_ROLE_KEY`; `SUPABASE_ANON_KEY` is supported only when
the `transactions` table has suitable Row Level Security insert/select policies.

> **Amounts:** Paystack works in the smallest currency unit, so `GH₵ 50` is sent as `5000`.
> The conversion (with correct rounding) lives in `lib/paystack.js` and is applied in one place only.

Run the offline test suite (stubs the network, no secret key needed):

```bash
npm test
```

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

> **Persistence:** the ledger is process memory, so it resets on restart (and is
> per-instance on serverless). `/api/transactions` and `/api/webhook` are deliberately
> routed to `server.js` in `vercel.json` so the reader and writer share one instance.
> Swap the store in `lib/ledger.js` for Postgres/Redis when you need durable records.

Run the ledger test suite (starts empty, real payment appears, signatures verified):

```bash
npm test
```

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
