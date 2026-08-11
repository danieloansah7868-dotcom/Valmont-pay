# Tenant Integration Guide

This document is the single source of truth for storefronts integrating
with the Valmont-Pay gateway. It exists so every new client site ships
the right URL, the right units, and the right security posture on the
first try.

> **You are looking at the v1 contract.** If a piece of sample code in
> the broader repo disagrees with this file, this file is correct.

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
[§ 5 — Validation & error states](#5-validation--error-states).

---

## 1. The two ways to start a payment

| Flow | When to use | URL shape | Amount comes from |
|---|---|---|---|
| **Secure (access_code)** — recommended | All new integrations | `pay.html?access_code=ac_…` | The server, never the URL. The customer cannot edit the amount. |
| **Legacy (URL params)** | Only existing storefronts that pre-date the access-code flow | `pay.html?amount=…&merchant=…&reference=…&email=…&callback_url=…` | The URL (must be in cedis). |

The secure flow is preferred for one reason: the amount is resolved
server-side from a one-time access code, so the customer cannot edit it
by hand-editing the URL bar. New integrations should use it.

The legacy flow still works, but it is the path the "Blocker 4" bug
shipped through (Electricals passed `amount=2300` and pay.html charged
GH₵2,300 for a GH₵23 cart). It is now guarded by the unit validator
below.

---

## 2. Secure flow (recommended) — step by step

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

---

## 3. Legacy flow (existing integrations only)

If you cannot migrate to the access-code flow right now, use the URL
form below. It is identical in shape to the dynamic-link example in
the project README, and it is the form the unit validator guards.

### 3.1 Redirect URL format

```
https://valmontpay.app/pay.html
  ?amount=23.50                                  ← cedis, NEVER pesewas
  &merchant=valmont-electricals                  ← tenant key
  &reference=VE-MSCX67FD267C                     ← your order id
  &email=buyer@example.com                       ← optional
  &callback_url=https://your-site.com/thanks     ← optional
  &subaccount=ACCT_xxxxxxxxxxxx                  ← optional (split settlement)
  &return_url=https://your-site.com/cart         ← optional (back button)
```

### 3.2 Worked curl (one-shot, with every parameter)

```bash
# 1) Generate the redirect URL on the server side (any language):
URL="https://valmontpay.app/pay.html"
URL+="?amount=23.50"
URL+="&merchant=valmont-electricals"
URL+="&reference=VE-MSCX67FD267C"
URL+="&email=buyer@example.com"
URL+="&callback_url=https://valmontelectricals.com/orders/thanks"

# 2) 302 the customer there.
curl -i -X GET "$URL"
# → 200, HTML for pay.html (the customer sees the form with GH₵ 23.50).
```

### 3.3 What NOT to send (for reference)

```text
# WRONG — this would charge GH₵2,300.00, not GH₵23.00.
?amount=2300&merchant=valmont-electricals&reference=VE-MSCX67FD267C

# WRONG — this would charge GH₵1,500.00, not GH₵15.00.
?amount=1500&merchant=valmont-electricals&reference=VE-MSCX67FD267C

# WRONG — currency symbols, scientific notation, and locale-formatted
# numbers (commas) are not accepted by the gateway.
?amount=GH%E2%82%B523.50
?amount=2.350e1
?amount=1,500.00
```

pay.html rejects every form in the WRONG block and posts the rejection
to `/api/log/bad-amount` for audit.

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

## 5. Validation & error states

### 5.1 What pay.html validates (legacy flow)

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

### 5.2 Server-side audit

Every rejected URL fires a `POST /api/log/bad-amount` (best-effort,
non-blocking). The server logs:

```
[VALMONT-PAY][BAD-AMOUNT] unit=mismatch reason=looks-like-pesewas
  rawAmount=2300 suspectUnit=pesewas merchant=valmont-electricals
  ref=VE-MSCX67FD267C path=/pay.html url=… ua=…
```

Watch for these lines in Vercel runtime logs to catch a misconfigured
storefront before customers do.

### 5.3 What the server (`/api/initialize-payment`) validates

* `email` is required and must contain `@`.
* `amount` is required, must be a finite number, and must be > 0.
* `reference` is optional; if absent, the gateway generates
  `VP-XXXXXX` (six random digits).
* `callback_url` is validated against the tenant's `allowed_domains`
  when present; cross-domain callbacks are rejected with `400`.

### 5.4 What `/api/transaction/initialize` (the tenant-auth endpoint) validates

Same as 5.3, plus:

* `Authorization: Bearer <tenant_secret_key>` is required and must
  resolve to an enabled tenant.
* The body is bounded by the same `amount > 0` rule; no upper limit
  is enforced here (the merchant's Paystack plan is the real bound).

---

## 6. Reference: every URL parameter on `pay.html`

| Param | Legacy flow | Secure flow | Notes |
|---|---|---|---|
| `access_code` | — | ✅ required | The recommended way in. Server-resolved. |
| `amount` | ✅ cedis | — | Rejected if it looks like pesewas. |
| `merchant` / `tenant` | ✅ tenant key | — | Aliased; `merchant` is the original name. |
| `reference` | ✅ your order id | — | The merchant's reference, echoed through to Paystack. |
| `email` | optional | — | Pre-filled on the form. |
| `phone` | optional | — | Pre-filled on the form. |
| `callback_url` | optional | — | Where to send the customer after success. Must be on the tenant's `allowed_domains` when set on the server-init flow. |
| `subaccount` | optional | optional | Paystack split-settlement code. Usually set per-tenant in `lib/tenants.js`, not in the URL. |
| `return_url` | optional | optional | "← Return to merchant" link target. Never an internal Valmont-Pay admin page. |
| `reference` (alt: `ref`) | ✅ | — | `ref` is the legacy alias; `reference` wins. |

---

## 7. Checklist for a new storefront integration

Before going live, confirm each of these:

- [ ] The redirect uses **`amount=23.50`** (cedis), not `amount=2350`
      (pesewas). A `?amount=2300` URL renders the unit-mismatch error
      page, so this is the most important check.
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

---

## 8. Where to look in the code

| File | What it does |
|---|---|
| `pay.html` | Renders the payment form. Runs the unit validator. |
| `lib/paystack.js` | Converts cedis → pesewas at the wire boundary (`toSubunits`). |
| `api/initialize-payment.js` | Vercel serverless handler for the secure flow (cedis in, pesewas out). |
| `server.js` → `app.post('/api/transaction/initialize', …)` | Express route, identical contract. |
| `api/log-bad-amount.js` | Audit endpoint for unit-mismatch rejections. |
| `lib/tenants.js` | Tenant config (display name, brand color, allowed_domains, paystack_subaccount, …). |
| `lib/access-code-store.js` | One-time access codes for the secure flow. |
| `lib/webhook.js` | Paystack webhook → Supabase transaction upsert (the source of truth). |

---

## 9. Change log

| Date | Change | Why |
|---|---|---|
| 2026-08-03 | Unit contract formalized as "cedis only". pay.html validator added. `?amount=2300` (and any plain integer ≥ 1000 with no decimal) is now rejected and audited. | Blocker 4: Electricals `amount=2300` charged GH₵2,300 for a GH₵23 cart. |
