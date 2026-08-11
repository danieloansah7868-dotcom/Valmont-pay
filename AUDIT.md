# 🔍 Valmont-Pay — Deep Audit Report

**Date:** 2026-08-04 · **Target:** https://valmontpay.app (Vercel `production`, commit `7421594`)
**Goal:** make "generate a payment link and send it to a client" work reliably — and safely.

---

## 1. Executive summary

Your site **is live and well-configured at the infrastructure level** (Vercel production, Supabase connected with the service-role key, and a **LIVE** Paystack key `sk_live_0562…`). But four defects meant the link you wanted to send today would have failed for your client:

| # | Defect | Impact for you today |
|---|---|---|
| 1 | `PUBLIC_BASE_URL` in Vercel = `https://valmont-pay.vercel.app`, and that hostname returns **`DEPLOYMENT_NOT_FOUND`** (dead). Payment links, Paystack callbacks, and the webhook URL shown to you were all built on the dead domain. | The link the dashboard generated pointed at a dead page. **This is why you couldn't send one.** |
| 2 | Payment-link details lived **only in server memory** (30-min expiry). On Vercel each serverless instance has its own memory and cold-starts lose it. | Even with the domain fixed, a link opened by your client ~10+ minutes later (or on another instance) showed **"Payment Link Invalid"**. |
| 3 | Your Paystack dashboard webhook was almost certainly aimed at the dead `valmont-pay.vercel.app` URL (it's what the diagnostics recommended). | Client pays ✅, but the payment **never reaches your dashboard/ledger**. |
| 4 | Several admin/mutation API endpoints were **completely unauthenticated** (including one that hands out freshly-rotated tenant API secrets, and several that can inject fake `SUCCESS` money into your books). | Anyone on the internet could have hijacked tenant credentials or poisoned your ledger. |

**All four are fixed in code on this branch** (`arena/019fcb9d-valmont-pay`). Four dashboard actions remain for you (§6) — they take ~10 minutes.

---

## 2. Live production check (verified 2026-08-04, from the outside)

| Check | Result |
|---|---|
| `https://valmontpay.app` | ✅ Serving (redirects to admin login; Vercel `production`, Node v24, commit `7421594`) |
| `https://valmont-pay.vercel.app` | ❌ `404 DEPLOYMENT_NOT_FOUND` — the `.vercel.app` hostname is **dead** (project renamed or domain disabled in the Vercel project settings) |
| `PUBLIC_BASE_URL` env | ⚠️ Set to the **dead** `https://valmont-pay.vercel.app` |
| Paystack | ✅ LIVE key configured (`sk_live_0562…`) |
| Supabase | ✅ Configured (service-role), connectivity OK |
| `WEBHOOK_SECRET` | ⚠️ Set to a **TEST** key (`sk_test_…`) — ignored by code, but should be unset |
| Webhook deliveries | ⚠️ None observed (cold-start logs are inconclusive, but consistent with a dead webhook URL) |

---

## 3. Root cause of "my payment link doesn't work"

### 3.1 Links were built on a dead domain (fixed)
Every link builder preferred `PUBLIC_BASE_URL` over the request's actual host — and that env var points to a hostname Vercel no longer serves. The dashboard **generated** links fine; they just led your client to `DEPLOYMENT_NOT_FOUND`. The default Paystack `callback_url` in `api/initialize-payment.js` was even hardcoded to the dead domain.

**Fix:** `lib/base-url.js` now derives URLs **host-first** (the domain the request actually arrived on), with an **allowlist** (`valmontpay.app`, `*.vercel.app`, localhost) so a forged `Host:` header can't mint callback URLs on a phishing domain. `PUBLIC_BASE_URL` is now only a fallback for non-HTTP contexts. Applied to: `server.js`, `api/initialize-payment.js`, `api/webhook-debug.js`, `lib/webhook-diagnostics.js`.

### 3.2 Links died with the serverless instance (fixed)
`pay.html?access_code=…` resolved everything from an **in-memory** map (`lib/access-code-store.js`) with a hard 30-minute expiry. On Vercel that's one warm lambda's memory: cold start or a different instance = "Payment Link Invalid".

**Fix:** new `lib/payment-link-store.js` + `payment_links` Supabase table:
- Dashboard links persist durably and live **`PAYMENT_LINK_TTL_HOURS`** hours (default **30 days**).
- `GET /api/transaction/access/:code` reads memory → falls back to Supabase → rehydrates the cache.
- If Supabase is configured but the write fails, the generator now **fails loudly (HTTP 502)** instead of handing you a link that will die.
- Tenant API checkout sessions also persist (unchanged 30-minute TTL per your integration docs).

### 3.3 Webhooks aimed at the dead domain (code fixed; Paystack dashboard action needed — §6)
The diagnostics recommended `https://valmont-pay.vercel.app/api/webhook`. Recommendations are now host-derived (production shows `https://valmontpay.app/api/webhook`).

### 3.4 Reference collisions (fixed)
`VP-` + 6 random digits (~900k values) with reference-keyed upserts → a collision would **overwrite a real transaction**. Now `VP-<base36-time>-<8 hex>` (e.g. `VP-MB3K7Z1A-9F4C2E18`).

---

## 4. Security findings

### 🔴 Critical — now fixed in code
| Endpoint | Was possible | Now |
|---|---|---|
| `POST /api/tenants/:key/rotate-keys` | Anyone could rotate tenant API keys and receive **fresh valid secrets in the response** → full API takeover | `401` without `X-Admin-Key` |
| `/api/admin/tenants*` (create/update/delete/enable/disable/rotate) | Full tenant CRUD unauthenticated | guarded |
| `POST /api/manual-transaction` | Inject arbitrary `SUCCESS` rows → fake "Total Collected" money on your dashboard | guarded |
| `POST /api/webhook-debug` | Same fake-money primitive | guarded |
| `POST /api/transactions` (terminal statuses) | Anyone could flip orders to `PAID`/`CANCELLED`/`SUCCESS` | ALL writes admin-only (pure gateway: no public PENDING order injection) |
| `PUT /api/tenants/:key/webhook` | Redirect a tenant's payment-event stream to an attacker's server | guarded |
| `POST /api/webhook-deliveries/:ref/replay` | Replay spoofed payment events at tenant backends | guarded |

Guard design (`lib/admin-auth.js`): `X-Admin-Key` must equal `ADMIN_PASSWORD`; constant-time compare; when `ADMIN_PASSWORD` is unset (local dev) it warns and stays open. The admin pages attach the header automatically after login — **no workflow change for you**.

### 🟡 Accepted / noted (not fixed in this pass)
- **`GET /api/transactions` is public** — customer emails + amounts visible to anyone. The dashboard needs it without auth today; consider admin-guarding it once the dashboard sends the key on reads too.
- **Client-side-only UI auth** (sessionStorage flag) — fine for MVP; the server-side guard is what now protects the API.
- **CORS `*`** — consistent with the public-checkout design; pair with the guards above.
- **`WEBHOOK_SECRET=sk_test_…` in prod** — safely ignored, but delete it from Vercel to remove confusion.

### 🟢 Verified good (kept intact)
- Webhook HMAC-SHA512 over **raw request bytes** with `timingSafeEqual`; live Paystack key is authoritative.
- Amounts locked **server-side** via access codes; pesewas-vs-cedis URL guard with audit logging.
- No simulated `SUCCESS` anywhere; only Paystack webhook / verify can settle.
- Transaction upserts keyed on `reference` (idempotent webhook + verify + retries).
- Callback-URL domain validation per tenant.

---

## 5. What changed (this branch)

```
NEW  lib/base-url.js                  host-first, allowlisted URL derivation
NEW  lib/payment-link-store.js        Supabase-durable payment links (30-day TTL)
NEW  lib/admin-auth.js                X-Admin-Key guard
NEW  scripts/supabase-payment-links-schema.sql   ← run this in Supabase (§6)
NEW  scripts/payment-link-store-test.mjs         33 assertions, offline
NEW  AUDIT.md                          this report
MOD  server.js                        durable links + guards + host-first URLs
MOD  api/initialize-payment.js        dead-domain callback fixed
MOD  api/transactions.js              terminal-status guard
MOD  api/webhook-debug.js             guarded POST, host-first URL
MOD  lib/webhook-diagnostics.js       recommendations host-derived
MOD  lib/paystack.js                  collision-proof references
MOD  admin-login/admin/tenants/dashboard .html  attach admin key; link expiry shown
MOD  README.md, .env.example          documented
```

`npm test`: **all suites green** (9 files, incl. the new link-store test). The local smoke test verified: link generation with 30-day expiry, access-code resolution, 404s for unknown codes, host-header-injection rejection, 401s for all guarded endpoints, the open-posture local-dev fallback with a loud warning, and public storefront orders still working. The branch was re-verified end-to-end after merging `main@385d9b8` (PR #37, durable webhook-delivery log) — both feature sets intact (one conflict: shared requires block, resolved).

---

## 6. Your actions (≈10 minutes, in this order)

1. **Merge the PR** from `arena/019fcb9d-valmont-pay` → `main`. Vercel redeploys automatically.
2. **Supabase** → SQL Editor → run `scripts/supabase-payment-links-schema.sql` (one paste).
   (This branch also integrates main's webhook-delivery-log feature — run
   `scripts/supabase-webhook-deliveries-schema.sql` there too if you haven't.)
3. **Vercel** → Project Settings → Environment Variables (Production):
   - `PUBLIC_BASE_URL` = `https://valmontpay.app`
   - **Delete** `WEBHOOK_SECRET` (it's a stale test key)
   - Confirm `ADMIN_PASSWORD` is set (it now also guards the API)
   - Redeploy after changing env vars.
4. **Paystack Dashboard** → Settings → API Keys & Webhooks → **Live mode** webhook URL:
   `https://valmontpay.app/api/webhook`
   (set the Test mode field too if you test there: same URL).
5. *(Optional)* Vercel → Domains: check why `valmont-pay.vercel.app` 404s (project renamed or default domain disabled). Not required — `valmontpay.app` is your face to the world.

### Then generate the link for your client
1. Log in at `https://valmontpay.app/admin-login.html` → Dashboard.
2. **Quick Launch Payment Link Generator**: client email + amount (GHS) → *Generate link*.
3. Copy the `https://valmontpay.app/pay.html?access_code=…` link (valid **30 days**, survives restarts) and send it.
4. Client pays with MoMo/card → you see it in the dashboard ledger within seconds (webhook), and the client gets the on-page receipt.

### Verify the deploy (from your machine)
```bash
curl https://valmontpay.app/api/admin/tenants                       # expect 401 (guard is live)
curl https://valmontpay.app/api/webhook-debug                       # expectedWebhookUrl must say valmontpay.app
curl -X POST https://valmontpay.app/api/v1/transaction/initialize \
  -H 'Content-Type: application/json' \
  -d '{"email":"client@example.com","amount":50.00,"merchant":"valmont-electricals"}'
# expect: "link_durable": true and a https://valmontpay.app/pay.html?access_code=… URL
```

---

## 7. Residual roadmap (not blockers)
- Guard `GET /api/transactions` once the dashboard attaches the key on reads (PII).
- Scheduled cleanup of expired `payment_links` rows (SQL snippet at the bottom of the migration file).
- Rate-limit the public init endpoints (link-generation spam).
- Real sessions for the admin UI (httpOnly cookies) replacing the sessionStorage flag.
- Alerting on `[LINK-GEN]`, `[WEBHOOK]` and `payment_links-table-missing` log lines.
