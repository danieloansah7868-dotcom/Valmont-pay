# Valmont-Pay Merchant API

Base URL: `https://valmontpay.app`
Currency: **GHS**. Every amount is an **integer number of pesewas** (GH₵ 15.00 → `1500`), the same convention Paystack uses.

---

## 1. Keys

Four keys, two pairs:

| Key | Where it lives | What it does |
|---|---|---|
| `pk_test_…` / `pk_live_…` | Safe in a browser | Identifies the merchant. Cannot move money or read data. |
| `sk_test_…` / `sk_live_…` | **Server only** | Authorises `initialize` + `verify`, and is the HMAC key your webhooks are signed with. |

A `sk_` key must never appear in HTML, a JS bundle, a query string, or a log. In a Next.js store keep it in a server-only env var (no `NEXT_PUBLIC_` prefix) and call the API from a Route Handler / Server Action.

Test keys and live keys are separate universes: a `sk_test_` key cannot see, settle, or collide with a live payment, and the same reference can exist independently in both modes.

Get your keys from the dashboard at `/merchant`, or generate a set with `npm run keys` and pin them via `VALMONTPAY_TEST_SECRET_KEY` etc.

---

## 2. Initialize a payment (do this server-side)

> **Why this exists.** The old link put the amount in the URL:
> `pay.html?amount=1500&ref=VE-1234`. A customer can edit `1500` to `1` and underpay.
> Initialize server-side and the browser only ever carries an opaque `access_code`.

```http
POST /api/transaction/initialize
Authorization: Bearer sk_live_xxxxxxxx
Content-Type: application/json

{
  "amount": 1500,
  "reference": "VE-MFA1B2C3",
  "email": "ama@example.com",
  "phone": "0244123456",
  "callback_url": "https://valmontelectricals.com/order/done?order=9912"
}
```

| Field | Required | Notes |
|---|---|---|
| `amount` | yes | Positive **integer**, minor units (pesewas). `15.5` is rejected. |
| `reference` | yes | Your own idempotency key. Opaque to us — see §6. |
| `email`, `phone` | no | Pre-fills the checkout page. |
| `callback_url` | no | Where the customer is returned. |

**201 Created**

```json
{
  "status": true,
  "data": {
    "access_code": "ac_c9b972ab6804c56b0ffc724a6a295d4c",
    "reference": "VE-MFA1B2C3",
    "authorization_url": "https://valmontpay.app/pay.html?access_code=ac_c9b972ab…",
    "amount": 1500,
    "currency": "GHS",
    "expires_at": "2026-07-28T18:19:31.713Z"
  }
}
```

Redirect the customer to `authorization_url`. It contains no amount, so there is nothing to tamper with; `pay.html` resolves the real amount from the server.

```js
// app/api/checkout/route.js
const res = await fetch('https://valmontpay.app/api/transaction/initialize', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.VALMONTPAY_SECRET_KEY}`, // server-only
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    amount: Math.round(order.totalCedis * 100), // pesewas
    reference: order.reference,
    email: order.email,
    callback_url: `https://valmontelectricals.com/order/done?order=${order.id}`
  })
});
const { data } = await res.json();
return Response.redirect(data.authorization_url, 303);
```

**Idempotency.** Re-initializing the same `reference` with the same `amount` returns `200` and a fresh access code — no duplicate payment. Re-initializing with a *different* amount returns `409 reference_conflict`.

### Legacy query-string links

`pay.html?amount=…&merchant=…&ref=…&email=&phone=&callback_url=` still works, so your live links do not break. But the `amount` there is treated as an **untrusted claim**:

* If the reference *was* initialized, the initialized amount wins. The mismatch is recorded on the payment and shown in the dashboard as `UNVERIFIED AMOUNT` / `link claimed …`.
* If it was *not*, we have nothing to reconcile against; the payment proceeds but is flagged `amount_trusted: false`, and the customer sees a warning banner.

Migrate to `initialize` to remove the flag.

---

## 3. Webhooks — the source of truth

Set your endpoint at `/merchant`. On every terminal state we POST:

```http
POST https://valmontelectricals.com/api/valmontpay/webhook
Content-Type: application/json
x-valmontpay-signature: <hex HMAC-SHA512 of the raw body, keyed with your secret key>
x-valmontpay-event-id: evt_41083daf3ca3e71ed9dc6b7fe52501c4
x-valmontpay-event: charge.success
x-valmontpay-reference: VE-MFA1B2C3
x-valmontpay-attempt: 1
```

```json
{
  "event": "charge.success",
  "data": {
    "reference": "VE-MFA1B2C3",
    "status": "success",
    "amount": 1500,
    "currency": "GHS",
    "channel": "mobile_money",
    "paid_at": "2026-07-28T17:19:50.048Z",
    "merchant": "Valmont Electricals",
    "gateway_reference": null
  }
}
```

Events: `charge.success`, `charge.failed`, `refund.processed`.

### Verifying the signature

Identical scheme to Paystack — if you already verify `x-paystack-signature`, change the header name and the key:

```js
import crypto from 'node:crypto';

export async function POST(request) {
  const raw = await request.text();               // the RAW body, not JSON.parse'd
  const expected = crypto
    .createHmac('sha512', process.env.VALMONTPAY_SECRET_KEY)
    .update(raw)
    .digest('hex');

  if (expected !== request.headers.get('x-valmontpay-signature')) {
    return new Response('Invalid signature', { status: 401 });
  }

  const { event, data } = JSON.parse(raw);
  await fulfil(event, data);                       // must be idempotent — see below
  return new Response('ok', { status: 200 });      // 2xx stops the retries
}
```

You must hash the **exact bytes** you received. Re-serialising the parsed object changes whitespace and key order, and the signature will not match.

### Retries and idempotency

* Anything `2xx` = delivered. Everything else (including a timeout) is retried.
* Exponential backoff — 30s, 1m, 5m, 15m, 30m, 1h, 2h, 3h, then every 6h — for **~24 hours**, then we give up and the delivery shows as `failed` in the dashboard.
* **Every retry sends a byte-identical body with the same `x-valmontpay-event-id`.** De-duplicate on that header (or on `reference` + `event`) and a retry storm is harmless.
* **Exactly one webhook per payment per event.** The state transition and the delivery are both keyed on the reference and both idempotent, so a double-submit, a duplicate Paystack callback, or a customer refreshing the page cannot produce a second webhook.

Return `2xx` *fast* and do the slow work afterwards; we time out an attempt at 15s.

> **Serverless note.** The retry loop is an in-process timer. On Vercel there is no long-lived process, so schedule a cron to `POST /api/webhooks/drain` (authorised with your secret key) every minute — that drains whatever retries are due.

---

## 4. Verify — your fallback when a webhook is missed

```http
GET /api/transaction/verify/VE-MFA1B2C3
Authorization: Bearer sk_live_xxxxxxxx
```

```json
{
  "status": true,
  "message": "Verification successful",
  "data": {
    "reference": "VE-MFA1B2C3",
    "status": "success",
    "amount": 1500,
    "currency": "GHS",
    "channel": "mobile_money",
    "paid_at": "2026-07-28T17:19:50.048Z",
    "merchant": "Valmont Electricals",
    "gateway_reference": null
  }
}
```

The `data` object is **exactly** the one in the webhook, so one parser handles both. `status` is one of `pending`, `success`, `failed`, `cancelled`, `refunded`.

Use it when the customer lands back on your site and you have not yet processed a webhook, and in a reconciliation sweep over orders still pending after a few minutes. Always re-check `amount` against your own order total before fulfilling.

---

## 5. Return redirect (cosmetic)

After the payment we send the customer to your `callback_url` with two params appended:

```
https://valmontelectricals.com/order/done?order=9912&ref=VE-MFA1B2C3&status=success
```

`status` is `success`, `failed` or `cancelled`. Your existing query params are preserved.

**Do not fulfil orders here.** Customers close tabs, lose signal on mobile data, and hit Back. Use this only to render "Thank you" / "Payment failed", then confirm with the webhook (or `verify`). The webhook is queued server-side *before* the browser is redirected, so an abandoned redirect never loses a payment.

---

## 6. References are opaque

`VE-MFA1B2C3`, `VE-BK-123456`, `VE-BK-1-2-3` — we never parse, split, or interpret a reference. It is a primary key and an idempotency key, nothing more.

If one payment covers several orders on your side, that mapping is yours to keep; we always send **exactly one webhook per payment**, and it carries the one reference you gave us.

---

## 7. Errors

| Code | HTTP | Meaning |
|---|---|---|
| `missing_credentials` | 401 | No `Authorization: Bearer` header. |
| `invalid_key` | 401 | Unknown or wrong-type key (a `pk_` key cannot authenticate). |
| `invalid_amount` | 400 | Not a positive integer in minor units. |
| `invalid_reference` | 400 | Missing, or longer than 200 characters. |
| `reference_conflict` | 409 | Already initialized with a different amount, or owned by someone else. |
| `already_completed` | 409 | Already in a terminal state. |
| `not_found` | 404 | No such reference **in this key's mode**. |

---

## 8. Dashboard

`https://valmontpay.app/merchant` — sign in with a secret key to:

* view both keypairs (secrets redacted until you click **Reveal**) and rotate them;
* set the webhook URL per mode (live must be HTTPS);
* browse every delivery: state, attempt log with status codes and timings, the exact signed payload, and the signature — plus **Replay**, which re-sends the identical body and event id so your handler de-duplicates it exactly like an automatic retry;
* see payments, including any flagged with an unverified amount.
