# Tenant Integration Guide

This document is the single source of truth for storefronts integrating
with the Valmont-Pay gateway. It exists so every new client site ships
the right URL, the right units, and the right security posture on the
first try.

> **Onboarding a new merchant (operator side)?** That is a separate job —
> see [`docs/tenant-onboarding-checklist.md`](tenant-onboarding-checklist.md)
> for creating the tenant record, its secrets, `allowed_domains`, webhook
> URL and Paystack subaccount.

> **You are looking at the v1 contract.** If a piece of sample code in
> the broader repo disagrees with this file, this file is correct.

---

## 🚨 The legacy URL flow is RETIRED in production (read this second)

> **`pay.html?amount=…&merchant=…` no longer works for public merchants.**
> Every storefront must use the access-code flow in
> [§ 2](#2-secure-flow-access_code--the-only-public-path).

A customer must not be able to change what they pay by editing the URL.
The old link form carried the price in the query string and nothing
signed it, so `?amount=1400` could simply be retyped as `?amount=1`.

As of the change log entry below, opening such a link shows:

> **Payment Link Invalid**
> This link is missing a locked payment code. Ask the merchant for a new link.

…and charges nothing. The rejection is also enforced server-side: a
`POST /api/initialize-payment` whose `Referer` is a legacy `pay.html`
URL is refused with `403 LEGACY_URL_RETIRED`, so stripping the page's
JavaScript does not get you a payment either.

**If you are integrating a storefront, go straight to [§ 2](#2-secure-flow-access_code--the-only-public-path).**
[§ 3](#3-legacy-flow-retired) now documents only how to migrate off the
old flow and the one operator-only escape hatch.

---

## ⚠️ The amount-unit contract (read this first)

> **Amounts are always in cedis (major units). Send `23.50` for
> GH₵23.50 — never `2350` (pesewas).**

The Valmont-Pay gateway, the Paystack wire format, the Supabase
`transactions.amount` column, the admin dashboard, the example storefront
checkout, and every server-side helper all speak **cedis**. Paystack
converts to pesewas at the very last step (`lib/paystack.js →
toSubunits()`) so client integrations must never pre-multiply.

| If you want to charge… | Send in the URL | NOT this (rejected) |
|---|---|---|
| GH₵23.00 | `amount=23.00` (or `amount=23`) | ~~`amount=2300`~~ |
| GH₵23.50 | `amount=23.50` | ~~`amount=2350`~~ |
| GH₵1,500.00 | `amount=1500.00` | ~~`amount=150000`~~ or ~~`amount=1500`~~ |

The "rejected" column matters: pay.html refuses to render the payment
form when the value looks like pesewas (a plain integer ≥ 1000 with no
decimal point) and posts the offending URL to `/api/log/bad-amount` so
the misconfiguration is auditable. See
[§ 6 — Validation & error states](#6-validation--error-states).

---

## 1. The one way to start a payment

| Flow | Status | URL shape | Amount comes from |
|---|---|---|---|
| **Secure (access_code)** | ✅ **The only public path** | `pay.html?access_code=ac_…` | The server, never the URL. The customer cannot edit the amount. |
| **Legacy (URL params)** | ❌ **Retired** — rejected in production | ~~`pay.html?amount=…&merchant=…`~~ | The URL. Anyone could edit it. |

There is one flow because there is one property worth having: **the
amount is resolved server-side from a one-time access code, so the
customer cannot change what they pay by editing the URL bar.**

Pick your entry point:

| You are… | Use |
|---|---|
| A storefront with a server and a tenant secret key | [§ 2.1 `POST /api/transaction/initialize`](#21-initialize-a-payment) |
| A static/anonymous site selling fixed packages (e.g. Valmont Web Services) | [§ 2.4 `POST /api/v1/payment-link/sku`](#24-anonymous-storefronts-mint-by-sku) — no secret in the browser |
| An operator issuing a link by hand | The dashboard's link generators ([§ 2.5](#25-issuing-a-link-from-the-dashboard)) |

Every one of them ends in the same place: a
`pay.html?access_code=ac_…` URL with no price in it.

> **Why the legacy flow died.** It shipped the "Blocker 4" bug
> (Electricals passed `amount=2300`; pay.html charged GH₵2,300 for a
> GH₵23 cart), which the unit validator then caught. But that validator
> only ever checked *units* — it could not tell a genuine `amount=1400`
> from a customer-edited `amount=1`. Only a server-resolved amount can.

---

## 2. Secure flow (access_code) — the only public path

### 2.1 Initialize a payment

```bash
curl -X POST https://valmontpay.app/api/transaction/initialize \
  -H "Authorization: Bearer <tenant_secret_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 23.50,
    "email": "buyer@example.com",
    "reference": "VE-MSCX67FD267C",
    "callback_url": "https://valmontelectricals.com/orders/thanks",
    "phone": "+233241234567"
  }'
```

The response is:

```json
{
  "status": true,
  "message": "Transaction initialized successfully",
  "data": {
    "access_code": "ac_1a2b3c4d5e6f7g8h",
    "reference": "VE-MSCX67FD267C",
    "amount": 23.50,
    "currency": "GHS",
    "merchant": "valmont-electricals",
    "merchant_display_name": "Valmont Electricals",
    "merchant_brand_color": "#f68b1e",
    "pay_url": "https://valmontpay.app/pay.html?access_code=ac_1a2b3c4d5e6f7g8h",
    "checkout_url": "https://valmontpay.app/checkout.html?reference=VE-MSCX67FD267C&amount=23.5&email=buyer%40example.com&merchant=valmont-electricals",
    "callback_url": "https://valmontelectricals.com/orders/thanks"
  }
}
```

> **Note:** `amount` is the major-unit (cedis) value. Paystack's
> minimum is GH₵0.01 (1 pesewa). The maximum is bounded server-side
> only by the merchant's Paystack plan.

### 2.2 Redirect the customer

```javascript
// Storefront checkout handler
const data = await fetch('https://valmontpay.app/api/transaction/initialize', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + TENANT_SECRET_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    amount: order.total,           // ← cedis (e.g. 23.50 for GH₵23.50)
    email: order.customer_email,
    reference: order.id,
    callback_url: 'https://your-site.com/orders/thanks',
    phone: order.customer_phone
  })
}).then(r => r.json());

if (data.status) {
  // data.data.pay_url is the canonical redirect target.
  window.location.href = data.data.pay_url;
}
```

### 2.3 Receive the result

The customer returns to `callback_url` with two extra query params
appended:

```
https://your-site.com/orders/thanks?reference=VE-MSCX67FD267C&status=success
```

The webhook remains the source of truth — the redirect is for the
customer experience only. Configure your Paystack dashboard to POST
charge events to `https://valmontpay.app/api/webhook`.

### 2.4 Anonymous storefronts: mint by SKU

§ 2.1 needs a tenant secret key, which means it needs a server. A
static marketing site (the Valmont Web Services case) has neither — and
a secret key must **never** ship in a browser bundle.

So those sites don't send a price at all. They send a **SKU**, and the
gateway prices it from a server-side catalogue
(`lib/service-catalogue.js`):

```bash
curl -X POST https://valmontpay.app/api/v1/payment-link/sku \
  -H "Content-Type: application/json" \
  -d '{ "sku": "WEB-LITE-STG1", "email": "client@example.com" }'
```

```json
{
  "status": true,
  "data": {
    "sku": "WEB-LITE-STG1",
    "label": "Website Lite — Stage 1",
    "amount": 1400,
    "currency": "GHS",
    "reference": "WEB-LITE-STG1-MSQF42WD479",
    "merchant": "Valmont Web Services",
    "merchant_key": "valmont-web-services",
    "access_code": "ac_636a01a0d0d9c999d3a007eb",
    "pay_url": "https://valmontpay.app/pay.html?access_code=ac_636a01a0d0d9c999d3a007eb"
  }
}
```

Redirect the customer to `data.pay_url`. Note what is **not** in it: a
price.

**The catalogue** (amounts in cedis, `GET /api/v1/payment-link/catalogue`
returns this live):

| SKU (`reference` prefix) | Package | Stage | Amount |
|---|---|---|---|
| `WEB-LITE-STG1` | Website Lite | Stage 1 | GH₵1,400 |
| `WEB-LITE-FULL` | Website Lite | Full | GH₵3,500 |
| `WEB-STARTER-STG1` | Website Starter | Stage 1 | GH₵2,000 |
| `WEB-STARTER-FULL` | Website Starter | Full | GH₵5,000 |
| `WEB-BUSINESS-STG1` | Website Business | Stage 1 | GH₵2,600 |
| `WEB-BUSINESS-FULL` | Website Business | Full | GH₵6,500 |
| `WEB-EMPIRE-STG1` | Website Empire | Stage 1 | GH₵3,200 |
| `WEB-EMPIRE-FULL` | Website Empire | Full | GH₵8,000 |

Rules this endpoint enforces:

* **`sku` is the only price input.** If you also send `amount`, it is
  ignored and a warning is logged. There is no request shape that lets
  an anonymous caller name its own price.
* **An unknown SKU is refused** (`400 UNKNOWN_SKU`) with the list of
  valid ones. Unknown SKUs are never "priced by the caller".
* `email` is required; `phone` and `callback_url` are optional. A
  `callback_url` must be on the tenant's `allowed_domains`.
* Prices change by editing `lib/service-catalogue.js` (or, per SKU at
  deploy time, `SERVICE_PRICE__WEB_LITE_STG1=1500`) — never by a request.

#### 2.4.1 Canonical merchant identity and the legacy alias

Every new catalogue link belongs to **`valmont-web-services`**, the one public
merchant key for **Valmont Web Services**. Use that key in integrations,
reports, and operator tooling; it has no baked-in secret because the anonymous
SKU endpoint is the intended storefront path.

`valmontweb` (displayed historically as **Valmont Web**) is not a second
merchant. It is a **read-only legacy lookup alias** retained for durable
`payment_links` and ledger rows that already store the old key. The gateway
resolves those rows to `valmont-web-services` when an `access_code` or tenant
identifier is read, preserving the locked amount/reference while rendering the
canonical name and branding. Do not create, configure, or delete a tenant under
the old key. The database migration intentionally does not delete legacy rows:
transactions remain auditable.

`valmontweb.com` may still appear in callback-domain allowlists; a domain is
not a tenant identity.

Example front-end button, with no secret anywhere in it:

```html
<button onclick="payFor('WEB-LITE-STG1')">Pay Stage 1 — GH₵1,400</button>
<script>
  async function payFor(sku) {
    const email = prompt('Your email for the receipt:');
    if (!email) return;
    const res = await fetch('https://valmontpay.app/api/v1/payment-link/sku', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, email })   // ← no amount, by design
    });
    const json = await res.json();
    if (json.status) window.location.href = json.data.pay_url;
  }
</script>
```

### 2.5 Issuing a link from the dashboard

Two generators, both of which mint `pay.html?access_code=…`:

* **Quick Launch Payment Link Generator** — free-form amount, for
  ad-hoc invoices. `POST /api/v1/transaction/initialize`.
* **Valmont Web Services — Issue Stage 1 / Full Link** — pick a SKU
  from the catalogue above; the price is shown read-only because the
  server owns it. `POST /api/v1/payment-link` (admin-authed, same
  catalogue and same lock as § 2.4).

Both are safe to WhatsApp to a client: the link is durable (30 days by
default, `PAYMENT_LINK_TTL_HOURS`) and carries no editable amount.

---

## 3. Legacy flow (RETIRED)

> **Status: closed for public merchants.** The URL form below no longer
> produces a payment. It is documented here so you can recognise it in
> your codebase and migrate off it.

### 3.1 What a legacy link looked like

```
https://valmontpay.app/pay.html
  ?amount=23.50                                  ← the problem: editable
  &merchant=valmont-electricals
  &reference=VE-MSCX67FD267C
  &email=buyer@example.com
  &callback_url=https://your-site.com/thanks
```

The price travelled in the query string and nothing signed it. A
customer who changed `amount=1400` to `amount=1` paid one cedi. The
`validateAmountUrl` guard in pay.html catches a *unit* mistake
(`amount=2300` meaning pesewas) but cannot detect a
tampered-but-plausible cedis figure — it is not, and never was, a
tamper guard.

### 3.2 What happens now when one is opened

Opening `https://valmontpay.app/pay.html?amount=1&merchant=Valmont+Web+Services`:

1. pay.html renders the **Payment Link Invalid** card:
   > This link is missing a locked payment code. Ask the merchant for a new link.
2. No payment form is shown and **nothing is charged**.
3. The rejected URL is POSTed to `/api/log/bad-amount` with
   `reason=legacy-unsigned`, so every storefront still on the old flow
   shows up in the logs:
   ```
   [VALMONT-PAY][BAD-AMOUNT] unit=n/a reason=legacy-unsigned
     rawAmount=1 merchant=Valmont Web Services ref=none
     path=/pay.html url=… ua=…
   ```
4. Server-side backstop: `POST /api/initialize-payment` refuses any
   request whose `Referer` is a legacy `pay.html?amount=…` URL, with
   `403 LEGACY_URL_RETIRED`. Disabling JavaScript does not help.

### 3.3 How to migrate

| If your storefront… | Replace the link with |
|---|---|
| has a server + secret key | [§ 2.1](#21-initialize-a-payment) → redirect to `data.pay_url` |
| is static / anonymous, fixed prices | [§ 2.4](#24-anonymous-storefronts-mint-by-sku) → `POST /api/v1/payment-link/sku` |
| is a one-off invoice | [§ 2.5](#25-issuing-a-link-from-the-dashboard) → generate it in the dashboard |

Concretely, replace this:

```html
<!-- BEFORE — the customer can edit 1400 -->
<a href="https://valmontpay.app/pay.html?amount=1400&merchant=Valmont+Web+Services&reference=WEB-LITE-STG1">
  Pay Stage 1
</a>
```

…with a call that names the SKU and redirects to the returned
`pay_url` (full example in [§ 2.4](#24-anonymous-storefronts-mint-by-sku)).

### 3.4 The escape hatch (operators only)

A deployment can temporarily re-open the legacy flow by setting a
**server-side** environment variable:

```bash
ALLOW_LEGACY_AMOUNT_URL=1
```

* It is **off in production** and must stay off.
* It is server-side only — no request, header, or query parameter can
  set it. pay.html reads the posture from `GET /api/config/pay` and
  **fails closed**: if that call errors, the legacy link stays rejected.
* With it on, the old flow works exactly as before — including the
  pesewas unit validator ([§ 6.1](#61-what-payhtml-validates-legacy-flow--escape-hatch-only)),
  which is still the second gate.
* Use it only to unblock a storefront mid-migration, with a deadline.

### 3.5 What NOT to send (historical reference)

These were always rejected by the unit validator, and are now moot
because the whole flow is closed:

```text
# WRONG — would have charged GH₵2,300.00, not GH₵23.00.
?amount=2300&merchant=valmont-electricals

# WRONG — currency symbols, scientific notation, locale-formatted numbers.
?amount=GH%E2%82%B523.50
?amount=2.350e1
?amount=1,500.00
```

---

## 4. Subaccounts (split settlement, optional)

If your tenant is configured with a Paystack subaccount (e.g. `ACCT_xxxxxxxxxxxx`), the gateway forwards it to Paystack
and Paystack handles the split automatically (e.g. 98% merchant / 2% gateway).

Pass it on either flow:

* **Secure:** add `"subaccount": "ACCT_xxxxxxxxxxxx"` to the
  `POST /api/transaction/initialize` body.
* **Legacy:** add `&subaccount=ACCT_xxxxxxxxxxxx` to the redirect URL.

The subaccount is set per-tenant in `lib/tenants.js` and the
`tenants` table in Supabase; it is never inferred from the URL.

---

## 5. Standing Mandates & Auto-Renewal (Merchant-Initiated Debits)

When Valmont-Pay enables an operator's merchant-initiated or standing-mandate product — like MTN Ghana MoMo auto-renewal or recurring card debits — debits can run fully automatically after the customer's first approval.

### 5.1 Legal & Compliance Requirements (Act 987 & Scheme Rules)

Implementing automatic recurring debits is legal and compliant under Bank of Ghana (BoG) consumer protection rules, provided four operational rules are followed:

1. **Explicit Customer Mandate Authorization (Opt-In)**: The initial Customer-Initiated Transaction (CIT) must explicitly inform the customer that they are consenting to a standing instruction or recurring mandate. Once the USSD PIN or 3D-Secure prompt is authorized, Paystack issues a reusable `authorization_code`.
2. **Mandatory Opt-Out & Revocation Rights**: Customers must have an accessible way to cancel or revoke their standing approval at any time (e.g., via MTN MoMo USSD `*170#` approvals or through the merchant portal).
3. **Pre-Debit Notification**: Consumer protection guidelines require sending an advance notification (SMS/email/WhatsApp) to the customer before executing an automated debit on monthly or extended billing cycles.
4. **Gateway / Operator Underwriting**: Automatic MoMo Direct Debits without recurring USSD PIN prompts require Merchant-Initiated Direct Debit (MIDD) / Standing Instruction approval from the operator (MTN/Telecel/Paystack).

### 5.2 How to Initialize a Standing Mandate

When initializing a payment via `POST /api/transaction/initialize` (or in `lib/paystack.js`), pass recurring parameters in `metadata`:

```json
{
  "email": "customer@example.com",
  "amount": 45.00,
  "reference": "VP-SUB-INIT-001",
  "recurring": true,
  "mandate_type": "standing_instruction"
}
```

When the initial checkout succeeds, Valmont-Pay inspects the returned Paystack authorization object (`authorization.authorization_code` with `reusable: true`) and durably stores the mandate in the Supabase `mandates` table (created by `scripts/supabase-mandates-schema.sql`).

### 5.3 Managing & Charging Mandates via API

Valmont-Pay provides four endpoints for inspecting, executing, and revoking standing mandates:

* **`GET /api/v1/mandates`**: List standing mandates. Accepts optional query filters `?merchant=<name>&email=<email>&status=<ACTIVE|REVOKED|EXPIRED>`.
* **`GET /api/v1/mandates/:code`**: Get full details of a specific mandate by its `authorization_code`.
* **`POST /api/v1/mandates/charge`**: Charge an active standing mandate without customer PIN prompting:
  ```json
  {
    "authorization_code": "AUTH_xxxxxxxxx",
    "amount": 45.00,
    "email": "customer@example.com",
    "reference": "VP-RENEWAL-002"
  }
  ```
  Returns `200 OK` on successful charge and automatically records the new transaction in the dashboard ledger (`transactions` table).
* **`POST /api/v1/mandates/revoke`**: Revoke an active mandate:
  ```json
  {
    "authorization_code": "AUTH_xxxxxxxxx"
  }
  ```
  Marks the mandate `status` as `REVOKED`. Any subsequent attempt to charge a revoked mandate is immediately rejected by `lib/mandate-store.js` with `400 Bad Request` to guarantee opt-out compliance.

---

## 6. Validation & error states

### 6.1 What pay.html validates (legacy flow — escape hatch only)

> These rules only ever run when `ALLOW_LEGACY_AMOUNT_URL=1`
> ([§ 3.4](#34-the-escape-hatch-operators-only)). With the flag off — the
> production posture — a legacy link is rejected before any of this,
> with the copy in [§ 3.2](#32-what-happens-now-when-one-is-opened).


| Input | Verdict | Why |
|---|---|---|
| `amount=23` | ✅ accepted | Cedis, under threshold. |
| `amount=23.50` | ✅ accepted | Cedis, with decimal. |
| `amount=1500.00` | ✅ accepted | Cedis, with decimal (allowed by the `.00` suffix). |
| `amount=999` | ✅ accepted | Cedis, plain integer under the 1000 threshold. |
| `amount=1000` | ❌ rejected | Plain integer ≥ 1000 with no decimal — almost certainly pesewas. |
| `amount=2300` | ❌ rejected | Same heuristic — this is the Electricals bug pattern. |
| `amount=1,500.00` | ❌ rejected | Commas are not in the numeric grammar. |
| `amount=GH₵23.50` | ❌ rejected | Currency symbols are not in the numeric grammar. |
| `amount=0` | ❌ rejected | Not positive. |
| `amount=` (empty) | ❌ rejected | Missing. |

The rejection message is:

> Amount looks like pesewas. This gateway expects cedis (major units) —
> e.g. amount=23.00 not amount=2300. Contact the merchant site.

…with a dedicated `Payment Link Unavailable` error card. The customer
never sees a 100× wrong number and never sees the Pay button.

### 6.2 Server-side audit

Every rejected URL fires a `POST /api/log/bad-amount` (best-effort,
non-blocking). The server logs:

```
[VALMONT-PAY][BAD-AMOUNT] unit=mismatch reason=looks-like-pesewas
  rawAmount=2300 suspectUnit=pesewas merchant=valmont-electricals
  ref=VE-MSCX67FD267C path=/pay.html url=… ua=…
```

A retired legacy link logs the other reason — this is the **migration
log**, one line per storefront still on the old flow:

```
[VALMONT-PAY][BAD-AMOUNT] unit=n/a reason=legacy-unsigned
  rawAmount=1400 merchant=Valmont Web Services ref=WEB-LITE-STG1
  path=/pay.html url=… ua=…
```

Watch for both in Vercel runtime logs to catch a misconfigured
storefront before customers do.

### 6.3 What the server (`/api/initialize-payment`) validates

**Amount authority — `body.amount` is never gospel.** The request comes
from a browser that may have read the number out of the address bar, so:

* If **`access_code` is present**, the stored payment intent wins. The
  amount, reference and merchant are re-read from it and the body values
  are ignored (a mismatch is logged). This is what makes editing
  `?amount=` on an access-code URL a no-op. An unknown or expired code
  is `404 ACCESS_CODE_INVALID` — it never falls back to `body.amount`.
* If there is **no `access_code` and the `Referer` is a legacy
  `pay.html?amount=…` URL**, the request is refused with
  `403 LEGACY_URL_RETIRED` (unless
  [the escape hatch](#34-the-escape-hatch-operators-only) is on).

Then the ordinary field rules apply:

* `email` is required and must contain `@`.
* `amount` is required, must be a finite number, and must be > 0.
* `reference` is optional; if absent, the gateway generates
  `VP-XXXXXX` (six random digits).
* `callback_url` is validated against the tenant's `allowed_domains`
  when present; cross-domain callbacks are rejected with `400`.

### 6.4 What `/api/transaction/initialize` (the tenant-auth endpoint) validates

Same as 6.3, plus:

* `Authorization: Bearer <tenant_secret_key>` is required and must
  resolve to an enabled tenant.
* The body is bounded by the same `amount > 0` rule; no upper limit
  is enforced here (the merchant's Paystack plan is the real bound).

### 6.5 What `/api/v1/payment-link/sku` validates

* `sku` must be in the server-side catalogue; anything else is
  `400 UNKNOWN_SKU`. **The price is looked up, never accepted.**
* A caller-supplied `amount` is ignored and logged — there is no
  request shape that lets an anonymous caller set a price.
* `email` is required (`400 EMAIL_REQUIRED`).
* The link must persist durably before it is handed out; if it cannot,
  the endpoint returns `502 LINK_NOT_DURABLE` rather than issue a link
  that will 404 for the client.

---

## 7. Reference: every URL parameter on `pay.html`

| Param | Secure flow (live) | Legacy flow (retired) | Notes |
|---|---|---|---|
| `access_code` | ✅ **required** | — | The only way in. Everything else about the payment is resolved from it, server-side. |
| `amount` | ignored | ~~cedis~~ | **Present on an access-code URL it does nothing** — the stored intent wins. On its own it triggers the retired-link rejection. |
| `merchant` / `tenant` | ignored | ~~tenant key~~ | Comes from the stored intent. |
| `reference` (alt: `ref`) | ignored | ~~your order id~~ | Comes from the stored intent. Set it via `POST /api/transaction/initialize` instead. |
| `email` | optional | ~~optional~~ | Pre-filled on the form; the stored value wins when set. |
| `phone` | optional | ~~optional~~ | Pre-filled on the form. |
| `callback_url` | optional | ~~optional~~ | Where to send the customer after success. Must be on the tenant's `allowed_domains`. |
| `subaccount` | optional | ~~optional~~ | Paystack split-settlement code. Usually set per-tenant in `lib/tenants.js`, not in the URL. |
| `return_url` | optional | ~~optional~~ | "← Return to merchant" link target. Never an internal Valmont-Pay admin page. |

> **The short version:** on a `?access_code=` URL, no other parameter can
> change what the customer is charged.

---

## 8. Checklist for a new storefront integration

Before going live, confirm each of these:

- [ ] The redirect target is a **`pay.html?access_code=…`** URL. If any
      link in your storefront still contains `amount=`, it is a retired
      link and will show "Payment Link Invalid" — this is the most
      important check. See [§ 3.3](#33-how-to-migrate).
- [ ] No tenant secret key appears anywhere in browser-shipped code. A
      static site should be minting by SKU ([§ 2.4](#24-anonymous-storefronts-mint-by-sku)).
- [ ] Amounts sent server-to-server are **cedis** (`23.50`), not pesewas
      (`2350`).
- [ ] The storefront server sends `amount` as a JSON number (not a
      string) to `POST /api/transaction/initialize`. JavaScript's
      `Number(order.total).toFixed(2)` is the canonical form.
- [ ] The `reference` is unique per order and is the same value the
      storefront shows the customer in its own order history.
- [ ] The `callback_url` is on the tenant's `allowed_domains` (set in
      `lib/tenants.js` / `public.tenants`).
- [ ] The Paystack dashboard webhook is pointed at
      `https://valmontpay.app/api/webhook` and uses the same Paystack
      secret key as the gateway.
- [ ] The storefront handles a missing/invalid `reference` query
      parameter on its `callback_url` by showing a generic "check your
      order status" page rather than 500-ing.
- [ ] No `pay.html` URL is cached by a CDN — the page reads the URL
      on every load and Paystack's inline checkout depends on a fresh
      page state.
- [ ] If using standing mandates or auto-renewal, verify that customers
      are clearly informed of the recurring instruction (opt-in) and have a
      cancellation path (opt-out via `POST /api/v1/mandates/revoke` or USSD).

---

## 9. Where to look in the code

| File | What it does |
|---|---|
| `pay.html` | Renders the payment form. Rejects unsigned legacy links (`rejectLegacyUnsignedLink`) and runs the unit validator. |
| `lib/legacy-link-policy.js` | The retirement policy: the `ALLOW_LEGACY_AMOUNT_URL` flag, the legacy-referer check, and the rejection copy. |
| `lib/service-catalogue.js` | Server-side SKU → price table for Valmont Web Services. The reason an anonymous caller cannot name its own price. |
| `server.js` → `/api/v1/payment-link/sku`, `/api/v1/payment-link` | Mint a locked link from a SKU (anonymous / admin). |
| `server.js` → `/api/config/pay` | Tells pay.html whether the legacy escape hatch is on. |
| `lib/paystack.js` | Converts cedis → pesewas at the wire boundary (`toSubunits`). Includes `chargeAuthorizationWithKey`. |
| `api/initialize-payment.js` | Vercel serverless handler for the secure flow (cedis in, pesewas out). |
| `server.js` → `app.post('/api/transaction/initialize', …)` | Express route, identical contract. |
| `api/log-bad-amount.js` | Audit endpoint for `legacy-unsigned` and unit-mismatch rejections. |
| `lib/tenants.js` | Tenant config (display name, brand color, allowed_domains, paystack_subaccount, …). |
| `lib/access-code-store.js` | One-time access codes for the secure flow. |
| `lib/mandate-store.js` | Standing mandate & recurring authorization code storage and execution (`chargeMandate`, `revokeMandate`). |
| `lib/webhook.js` | Paystack webhook → Supabase transaction upsert (the source of truth). |

---

## 10. Change log

| Date | Change | Why |
|---|---|---|
| 2026-08-12 | **The legacy `pay.html?amount=…` flow is retired in production.** Unsigned links now show "Payment Link Invalid" and charge nothing; `/api/initialize-payment` ignores `body.amount` whenever an `access_code` is present and refuses requests from legacy pay URLs. Added the SKU catalogue and `POST /api/v1/payment-link/sku` so anonymous storefronts never hold a secret or a price. Escape hatch: `ALLOW_LEGACY_AMOUNT_URL=1`, off in production. | A customer could edit `?amount=1400` to `?amount=1` and pay one cedi. The unit validator only ever checked cedis-vs-pesewas, never tampering. |
| 2026-08-11 | Added Standing Mandates & Auto-Renewal documentation (Section 5) and API endpoints (`/api/v1/mandates`). | Explains legal/BoG compliance (Act 987 opt-in/opt-out) and merchant-initiated recurring debits for MTN MoMo & card authorizations. |
| 2026-08-03 | Unit contract formalized as "cedis only". pay.html validator added. `?amount=2300` (and any plain integer ≥ 1000 with no decimal) is now rejected and audited. | Blocker 4: Electricals `amount=2300` charged GH₵2,300 for a GH₵23 cart. |
