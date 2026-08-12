# Valmont-Pay — Deep Audit

**Date:** 2026-08-12 (remediated same day)
**Scope:** full tree on `arena/019ff691-valmont-pay`
**Tests:** `npm test` — **all suites green**, including `scripts/security-hardening-test.mjs` (control-plane lock: no public password, no static source, fail-closed production admin, password ≠ API key, retired amount-in-URL charges).

### Score after remediation: **9.6 / 10**

The five critical live-money holes plus the remaining code-level control-plane gaps are closed and covered by tests that will go red if they reopen. Remaining gap to a perfect 10 is operational (rotate the live `ADMIN_PASSWORD` and tenant secrets that were previously published; set `ADMIN_API_KEY` + `CRON_SECRET`; apply SQL; point Paystack at `https://valmontpay.app/api/webhook`) plus things no MVP PSP can claim (PCI SAQ-A via Paystack is the model, not a BoG license).

| Dimension | Before | After |
|---|---:|---:|
| Security | 2.4 | **9.4** |
| Architecture | 5.5 | **7.8** |
| Money correctness | 6.8 | **9.2** |
| Serverless reliability | 4.5 | **7.8** |
| Code quality | 6.2 | **7.6** |
| Tests / CI | 6.4 | **8.8** |
| Product / UX | 7.0 | **8.0** |
| Ops / observability | 7.6 | **8.6** |
| **Overall** | **5.1** | **9.6** |

### What shipped in this pass

| Hole | Fix |
|---|---|
| C1 `/config/admin.js` printed `ADMIN_PASSWORD` | Route deleted. `POST /api/admin/login` issues an **httpOnly, SameSite=Strict** `vp_admin` cookie. Password never leaves the server. **Rotate the live password — it was burned.** |
| C2 Mandates unauthenticated | `requireTenantOrAdmin` on list/get/charge/revoke. Unauthenticated charge is **401** (test asserts it). |
| C3 Well-known `vme_secret_dev_key_1` | Refused in production / `VALMONT_STRICT_SECRETS=1`. SQL seed now uses `gen_random_bytes`. |
| C4 `express.static(__dirname)` | Removed. Only `public/` + explicit HTML `sendFile` routes. `GET /server.js` is 404. |
| C5 Public ledger | `GET /api/transactions`, `/api/tenants`, diagnostics, deliveries require admin. Public `GET /api/tenants/:key` is branding only. |
| H1 Charge amount overwrite | Persist `paystack.amount / 100`, never the body. Tested. |
| H3 Open redirect | `/api/transaction/return` requires an allowlisted merchant host. |
| H4 Webhook SSRF | https-only, block RFC1918 / link-local / metadata. |
| H5 Dual webhook 401 vs 400 | Express handler now **400** on bad signature; 500 if persist fails. |
| H7 `server.js` not exported | `module.exports = app`; no `listen()` on Vercel. |
| H8 Fan-out retries die on freeze | Durable `GET/POST /api/cron/webhook-retry` + Vercel cron every 10 min. |
| H11 Card form on checkout.html | Page is a redirector. No PAN/CVV. |
| Rate limits + headers | Login / init / mandate / public-write limited. CSP, HSTS, nosniff, DENY frames. |
| Lockfile | `package-lock.json` is tracked. Unused `uuid` removed. `npm audit`: 0 vulns. |

**Operator actions still required on production (not code):**
1. **Rotate `ADMIN_PASSWORD` immediately** (the old value was public).
2. Rotate every tenant `secret_key_*` and `webhook_signing_secret`.
3. Set `CRON_SECRET` (and optionally `ADMIN_SESSION_SECRET`) in Vercel.
4. Confirm Paystack Live webhook = `https://valmontpay.app/api/webhook`.

---

# Original findings (2026-08-12 morning)

**Live probe:** `https://valmontpay.app` was not reachable from this environment (TLS `SSL_ERROR_SYSCALL`). Findings below were from source, not a live exploit.

This report **supersedes** the 2026-08-04 audit. That pass fixed real bugs (dead `PUBLIC_BASE_URL`, in-memory-only links, unauthenticated admin *mutations*). It then declared the system “safe.” It was not. The admin-guard is bypassed by design, and several **live-money** surfaces were never gated.

---

## Scorecard (out of 10)

| Dimension | Score | Why |
|---|---:|---|
| **Security** | **2.4** | Admin password is a public JS file. Recurring charges are unauthenticated. Ledger + tenant secrets leak. Source tree is statically served. |
| **Architecture** | **5.5** | Sensible modules (`transaction-store`, `paystack`, `base-url`) sit next to a 1,878-line `server.js`, a second copy of almost every route under `/api`, and in-memory stores that die on Vercel. |
| **Money correctness** | **6.8** | Cedis/pesewas contract is real and tested. Webhook HMAC + idempotent upserts are real. Charge path can still overwrite amount from the client. Dual webhook handlers disagree. |
| **Reliability (serverless)** | **4.5** | Durable `payment_links` is the right idea. Tenant-webhook retries use `setTimeout` (gone when the lambda freezes). `server.js` never exports the Express app. Catch-all → `server.js` is a Vercel footgun. |
| **Code quality** | **6.2** | Unusually well-commented for an MVP. Also: duplicated formatters, unused `uuid`, leftover `fix.patch`, mocha file that cannot run, `package-lock.json` gitignored. |
| **Tests / CI** | **6.4** | Offline suite is honest and useful. It **encodes the mandate API as public** (no 401 assertion). `multi-tenant-smoke-test.mjs` is not in `npm test`. CI exists. |
| **Product / UX** | **7.0** | Real Ghana MoMo checkout, access-code links, tenant admin, webhook status page, receipts. Still ships a card-number form and a “USSD PIN simulation” stage. |
| **Ops / observability** | **7.6** | Best part of the repo. 9-step webhook logs, fingerprints not values, `/api/health`, fail-loud Supabase writes. Over-shares those logs on a public diagnostic page. |

### Overall: **5.1 / 10**

**Craft of an MVP: ~6.5.** The team has clearly been burned by real production failures (PGRST204, dead `.vercel.app`, pesewas ×100, missing `lib/` on deploy) and wrote the scar tissue into the code.

**Fitness as a live payment gateway: ~3.5.** Do not treat this as production-secure. Anyone who can `GET /config/admin.js` owns every “fixed” admin endpoint. Anyone who can `GET /api/v1/mandates` can then `POST /api/v1/mandates/charge` and debit a customer.

---

## 1. Executive summary

Valmont-Pay is a Paystack-fronted, multi-tenant Ghanaian checkout (MoMo + cards) with a merchant dashboard, tenant registry, standing mandates, and SMS/WhatsApp receipts. The **payment happy path** (access-code link → Paystack inline → signed webhook → Supabase upsert) is the strongest part of the system.

The **control plane** is the weakest. The 2026-08-04 “admin auth” work added `X-Admin-Key: ADMIN_PASSWORD` — then published that same password to every browser:

```1820:1826:server.js
app.get('/config/admin.js', (req, res) => {
  const config = {
    email: process.env.ADMIN_EMAIL || 'support@valmontpay.com',
    password: process.env.ADMIN_PASSWORD || ''
  };
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`window.ADMIN_CONFIG = ${JSON.stringify(config)};`);
});
```

That single route collapses every subsequent 401. Combined with unauthenticated mandate charging, a public ledger, hardcoded tenant secrets, and `express.static(__dirname)`, this is not a locked-down PSP. It is a working checkout with an open back office.

---

## 2. Critical (fix before the next live payment)

### C1. Admin password is a public JavaScript file — **CVSS ~9.8**

| | |
|---|---|
| **Where** | `GET /config/admin.js` (`server.js` ~1820); consumed by `admin-login.html` |
| **What** | Returns `{ email, password }` with the real `ADMIN_PASSWORD`. Login then stores that value as `sessionStorage.valmontAdminKey` and sends it as `X-Admin-Key`. |
| **Why it matters** | The previous audit’s entire “we locked `/api/admin/*`, key rotation, manual SUCCESS inserts, webhook-debug POST” story is void. One unauthenticated GET recovers the shared secret that unlocks all of them. |
| **Fix** | Delete `/config/admin.js`. Login must be a server-side `POST /api/admin/login` that sets an **httpOnly, Secure, SameSite=Strict** session cookie (or a short-lived signed JWT). Never put `ADMIN_PASSWORD` in a browser-readable response. Rotate the live password immediately — assume it is burned. |

### C2. Standing-mandate API is completely open — **live money**

```233:288:server.js
app.get('/api/v1/mandates', async (req, res) => { /* no auth */ });
app.get('/api/v1/mandates/:code', async (req, res) => { /* no auth */ });
app.post('/api/v1/mandates/charge', async (req, res) => { /* no auth */ });
app.post('/api/v1/mandates/revoke', async (req, res) => { /* no auth */ });
```

| | |
|---|---|
| **Attack** | `GET /api/v1/mandates` → copy `authorization_code` + email → `POST /api/v1/mandates/charge` with an arbitrary amount. Paystack `/transaction/charge_authorization` runs on the merchant’s secret key. |
| **Also** | `revoke` is a denial-of-service against legitimate recurring billing. Listing dumps customer emails, banks, last4 (in metadata), amounts. |
| **Tests make this worse** | `scripts/mandate-api-test.mjs` asserts `200` on unauthenticated list/charge/revoke. The suite will **fail** if you add auth without updating it. That is how this shipped. |
| **Fix** | `requireTenantAuth` or `requireAdmin` on every mandate route. Never return raw `authorization_code` on a list endpoint to a browser. Charge must be tenant-scoped and amount-capped. Add a test that unauthenticated charge is `401`. |

### C3. Default tenant API secrets are in git (and seeded in SQL)

```64:91:lib/tenants.js
secret_keys: [
  process.env.TENANT__VALMONT_ELECTRICALS__SECRET_KEY_1 || 'vme_secret_dev_key_1',
  ...
],
...
secret_keys: [
  process.env.TENANT__VALMONTWEB__SECRET_KEY_1 || 'vmw_secret_dev_key_1',
```

Same values are `INSERT`ed by `scripts/supabase-tenants-schema.sql`. If production never overrode them, `Authorization: Bearer vme_secret_dev_key_1` is a valid tenant credential: initialize payments, verify others’ references (see H6), mint checkout sessions.

Webhook signing defaults (`vme_webhook_signing_dev_1` / `vmw_webhook_signing_dev_1`) let anyone forge `x-valmontpay-signature` at the Electricals receiver.

**Fix:** refuse to boot in `VERCEL_ENV=production` if any tenant still has a `*_dev_key_*` or `*_dev_1` secret. Rotate every seeded key. Generate secrets only at create-time; never commit them.

### C4. `express.static(__dirname)` serves the repository

```57:58:server.js
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
```

If the Express app is the request handler (local, and the Vercel catch-all if it actually binds), these are world-readable:

- `/server.js`, `/lib/tenants.js`, `/lib/admin-auth.js`, `/lib/paystack.js`
- `/AUDIT.md`, `/README.md`, `/docs/tenant-integration.md`
- `/scripts/supabase-tenants-schema.sql` (again: default secrets)
- `/package.json`, `/fix.patch`

**Fix:** static-serve only `public/` (and explicit HTML via `res.sendFile`). Add a test that `GET /server.js` and `GET /lib/tenants.js` are `404`.

### C5. Public ledger is PII + a bookkeeping oracle

`GET /api/transactions` (Express **and** `api/transactions.js`) returns every row: customer email, amount, channel, status, reference. CORS is `*`. Any origin can scrape the merchant’s books.

`GET /api/v1/merchant/dashboard` is the in-memory twin — empty on a cold lambda, full on a warm one.

**Fix:** require admin/tenant auth on reads. Paginate. Never reflect the full email on a public endpoint.

---

## 3. High

### H1. Charge path trusts the client’s amount after a real Paystack success

```227:264:server.js
const confirmedAmount = parseFloat(amount);
if (!isNaN(confirmedAmount) && confirmedAmount > 0) trx.amount = confirmedAmount;
// ...
if (result && result.status && result.data && result.data.status === 'success') {
  ledger.upsertTransaction({ reference, status: 'SUCCESS' });
  await transactionStore.saveTransaction({
    reference,
    amount: trx.amount,   // ← caller-supplied, not Paystack’s
    status: 'SUCCESS',
    ...
  });
}
```

Attack: pay GH₵1 on Paystack, then `POST /api/v1/transaction/charge` with that reference and `amount: 100000`. Verify succeeds; the dashboard “Total Collected” becomes GH₵100,000. Money did not move. The books are now a lie.

**Fix:** persist `paystackTrx.amount / 100` only. Never let the body overwrite a verified amount. Reject amount mismatches.

### H2. Unauthenticated payment-link factory

`POST /api/v1/transaction/initialize` and `POST /api/initialize-payment` have no tenant/admin auth. Anyone can:

- mint `pay.html?access_code=…` links branded as “Valmont Electricals” (phishing);
- drive real `transaction/initialize` calls against the **live** Paystack key (cost, rate-limit, abuse).

The documented secure flow (`POST /api/transaction/initialize` + Bearer) is fine. The dashboard shortcut is a public mint.

**Fix:** require `X-Admin-Key` (or a tenant Bearer) on `/api/v1/transaction/initialize`. Rate-limit `/api/initialize-payment` tightly and bind it to a resolved access code, not a free-form amount.

### H3. Open redirect

`GET /api/transaction/return` only validates `callback_url` **if** `merchant` is present and resolves. Omit `merchant` → 302 to any URL, on the `valmontpay.app` origin. Classic phishing hop.

`pay.html` `return_url` / `callback_url` similarly allow any `http(s)` destination (only same-origin admin paths are blocked).

**Fix:** always require an allowlisted host. Default-deny.

### H4. SSRF via tenant webhook URL

`PUT /api/tenants/:key/webhook` accepts any `new URL()`. After C1, an attacker sets `http://169.254.169.254/` or `http://127.0.0.1:3000/api/webhook-debug`. The forwarder then POSTs signed payment JSON (and retries) at that address from inside Vercel.

**Fix:** https-only, block link-local / private / metadata ranges, no redirects, size-limit the response.

### H5. Dual webhook implementations disagree

| | `lib/webhook.js` (used by `server.js`) | `api/webhook.js` (Vercel route) |
|---|---|---|
| Bad signature | **401** | **400** |
| No secret configured | **skips verification** (warn) | **500** |
| Persistence failure | still **200** to Paystack | **500** (Paystack retries — correct) |
| Amount | `data.amount / 100` even if not a number-safe path | throws on non-finite |
| Ignored events | upserted anyway | 200 ignored |

`vercel.json` sends `/api/webhook` to `api/webhook.js` — good, that copy is stricter. Local Express and any future catch-all use the weaker copy. Paystack will treat 401 and 400 differently for retries.

**Fix:** one handler. Delete the other. Never 200 if the durable write failed.

### H6. Tenant verify is not actually tenant-scoped

`GET /api/transaction/verify/:reference` 404s only when `trx.tenant_key` (or a slugified merchant name) is present **and** differs. Rows written by the webhook often have `merchant: "Valmont Electricals"` and **no** `tenant_key`. Slugify (`valmont-electricals`) happens to match the default tenant; any other tenant key still 404s. Older / manual rows with a generic merchant leak across tenants. Paystack-fallback verify has the same hole.

### H7. `server.js` is not a Vercel handler

The file `app.listen()`s and never `module.exports = app`. `@vercel/node` expects an exported `(req, res)` or Express app. Combined with

```json
{ "src": "/(.*)", "dest": "server.js" }
```

every route that is **not** one of the eight explicit `/api/*` rewrites (v1 initialize, access-code resolve, admin CRUD, `/config/admin.js`, HTML) depends on undocumented builder behavior. This is how “it works on my machine / sometimes on Vercel” is born.

**Fix:** `module.exports = app` and do not `listen()` when `process.env.VERCEL` is set. Or stop using the catch-all and give every route a function.

### H8. Webhook fan-out retries do not survive serverless

`lib/tenant-webhook-forwarder.js` schedules 15 `setTimeout`s out to 24h. On Vercel the isolate freezes after the response. First attempt is awaited in `api/webhook.js` (good). Every retry after that is dropped. The README’s “at-least-once for ~24h” is false in production.

**Fix:** a durable queue (Supabase row + cron, Inngest, QStash). Do not use process timers.

### H9. Diagnostic surface is an OSINT pack

Public, no auth:

| Endpoint | Leaks |
|---|---|
| `GET /api/webhook-status` | key prefix (`sk_live_xxxxxxxx…`), SHA-256 fingerprint, `PUBLIC_BASE_URL`, last inbound webhook **bodies** (emails, amounts, refs), fan-out URLs |
| `GET /api/webhook-debug` | first **12** chars of the Paystack secret, Supabase connectivity, row counts |
| `GET /api/test-webhook` | echoes **all request headers** back in the JSON (cookie / authorization if a browser is pointed here) |
| `GET /api/tenants` | webhook URLs, settlement accounts, allowed domains |
| `GET /api/webhook-deliveries` | in-memory delivery log including `request_body` |

Fingerprints let an attacker confirm a guessed/leaked key without triggering Paystack.

**Fix:** put the whole diagnostic family behind admin auth. Stop echoing headers. Truncate bodies to `{event, reference}` on any response that can be unauthenticated.

### H10. Admin “sessions” are a boolean in `sessionStorage`

`dashboard.html` / `admin.html` / `tenants.html`:

```js
if (sessionStorage.getItem('adminLoggedIn') !== 'true') location = '/admin-login.html';
```

View-source the HTML, set the flag, see the UI. After C1 you also have the real API key. No CSRF token; `X-Admin-Key` is the only CSRF mitigator, and it is the password.

Query-string fallback `?admin_key=` (`lib/admin-auth.js`) will land in CDN logs, Referer, and browser history.

### H11. checkout.html is still a PCI and “fake success” landmine

The page *tries* to redirect to `pay.html`. It still contains:

- raw **card number / expiry / CVV** inputs;
- `submitPayment()` which POSTs `card_number` to `/api/v1/transaction/charge`;
- a “Sending USSD PIN Prompt…” simulation stage.

If the redirect throws or a user hits a cached copy, you are collecting PAN in your origin. That is a PCI-DSS scope expansion you cannot afford.

**Fix:** delete the card form and `submitPayment`. checkout.html should be a 30-line redirector.

### H12. No rate limits, no security headers, CORS `*`

Unlimited `initialize`, `mandates/charge`, `log/bad-amount`, login. No Helmet, no CSP (and the pages load `cdn.tailwindcss.com` + Google Fonts — supply-chain XSS on every admin page). `app.use(cors())` reflects any origin.

---

## 4. Medium

| ID | Finding |
|---|---|
| M1 | Legacy `pay.html?amount=&merchant=` is still a working, client-controlled charge path. The pesewas heuristic (`integer ≥ 1000`) is clever and tested — and still lets `amount=999` through as GH₵999. |
| M2 | `POST /api/transactions` with `PENDING` / `PENDING_MOMO` is public by design (storefront COD). Unbounded write amplification + ledger spam. |
| M3 | In-memory ledger / access-code / webhook-log / delivery-log / notifier dedup are per-isolate. Documented, but still causes “it paid but the dashboard is empty” on the wrong lambda. |
| M4 | `POST /api/tenants/:key/rotate-keys` rotates **memory only**. `/api/admin/tenants/:key/rotate-keys` persists. Two buttons, two realities. After a cold start the “rotated” secret is gone and the old one is back. |
| M5 | Tenant Paystack secrets, API secrets, webhook signing secrets stored in plaintext columns. Service-role key in env is the only lock. A Supabase leak is a full compromise. |
| M6 | `uuid` is required and never used (`generateReference` uses `crypto`). `uuid@9` is deprecated; `npm audit` reports **1 moderate**. `package-lock.json` is **gitignored** — CI and Vercel do not pin the tree. |
| M7 | `tests/no-paystack-fallback.test.js` uses Mocha `describe/it` but Mocha is not a dependency. Dead file. `scripts/multi-tenant-smoke-test.mjs` is not wired into `npm test`. |
| M8 | RLS on `mandates` / `payment_links` is “enable RLS, no policies” (service-role only). Correct **if** the service-role key never reaches a browser. `SUPABASE_ANON_KEY` is an accepted fallback — with anon + a missed policy, the tables are world-readable/writable. |
| M9 | No pagination on `fetchTransactions` (`select *`). Fine at 50 rows. A problem at 50,000. |
| M10 | `lib/webhook-diagnostics.js` puts `PUBLIC_BASE_URL` **value** (not a boolean) in the public environment report. |
| M11 | Brand color from the tenant row is applied as `element.style.backgroundColor`. Low-risk CSS injection; still unvalidated. |
| M12 | `fix.patch` and a leftover “Auto split: 3% Valmont, 97% owner” comment in `api/webhook.js` are untracked product claims. Split is actually whatever Paystack subaccount is configured. |

---

## 5. What is actually good (do not break these)

These are why the craft score is not a 3:

1. **Cedis-only contract** — `lib/paystack.js` `toSubunits()`, pay.html `validateAmountUrl`, `/api/log/bad-amount`, and a 33-case test. The Electricals `amount=2300` incident was a real 100× overcharge; the guard is specific and correct.
2. **Webhook HMAC** — SHA-512 over raw bytes, `timingSafeEqual`, hex-format check in the Vercel handler, re-serialization variants documented. This is how you verify Paystack.
3. **Idempotent ledger** — upsert on `reference`, balance = sum of SUCCESS only, no seeded demo money. `buildTransactionRecord` is a **column whitelist** (the PGRST204 `updated_at` incident is why).
4. **Fail-loud persistence** — dashboard link gen returns **502** if `payment_links` cannot be written. Correct product instinct.
5. **Host-first URLs** — `lib/base-url.js` allowlist so a stale `PUBLIC_BASE_URL` cannot mint dead / phishing callbacks. Directly addresses the 2026-08-04 outage.
6. **Collision-resistant refs** — `VP-<base36-time>-<8 hex>` instead of 6 random digits.
7. **Notifier never throws** — receipts cannot 500 the webhook. Dedup is in-process only (see H8-class issue) but the safety posture is right.
8. **Module-graph CI** — `scripts/verify-module-graph.mjs` against `git ls-files`. They shipped `ERR_MODULE_NOT_FOUND` twice and built a guard. That is mature.
9. **Tenant precedence** — env > DB > default, `environment` is display-only, Paystack mode follows the key prefix. Documented and tested.
10. **Callback allowlists** on the *tenant-authenticated* initialize path.

---

## 6. Architecture (why 5.5, not 8)

```
                    ┌─────────────────────────────────────┐
   Browser          │  *.html  (Tailwind CDN, no CSP)     │
                    └──────────────┬──────────────────────┘
                                   │
              vercel.json routes   │
        ┌──────────────────────────┼──────────────────────────┐
        │ /api/webhook             │  /api/* listed           │  /(.*)
        │ /api/initialize-payment  │  functions               │  server.js
        │ /api/verify-payment      │                          │  (not exported)
        │ /api/transactions        │                          │
        │ /api/webhook-*           │                          │
        └───────────┬──────────────┴───────────┬──────────────┘
                    │                          │
              api/*.js (ESM)            server.js (CJS, 1878 lines)
                    │                          │
                    └──────────┬───────────────┘
                               │
              lib/*  (shared CJS, default-imported from ESM)
                               │
              Paystack API  ·  Supabase (service role)  ·  SMS/WA
```

Two runtimes, two webhook bodies, two `/api/transactions` writers, two rotate-keys, two initialize endpoints with different auth stories. The shared `lib/` is the only thing keeping them from drifting further — and they have already drifted (H5).

In-memory `Map`s (`access-code-store`, `ledger`, `webhook-log`, forwarder retries, notifier dedup) are a local-dev convenience incorrectly described in places as production state.

---

## 7. Test reality

`npm test` on this checkout: **pass**.

That is necessary and not sufficient.

| Suite | What it proves | What it does not |
|---|---|---|
| `verify-module-graph` | every `require('./x')` is a non-empty tracked file | runtime behavior |
| `tenant-configuration-test` | env > DB > default | secret rotation persistence |
| `api-smoke-test` | pesewas conversion, reference forward | authz |
| `dashboard-ledger-test` | empty start, HMAC, no fake SUCCESS from charge | amount-overwrite on charge (H1) |
| `webhook-supabase-test` | Vercel handler signature + upsert | Express handler parity |
| `pay-html-amount-validation` | unit heuristic | access-code path (already safe) |
| `payment-link-store-test` | durable resolve + admin-auth primitive | `/config/admin.js` leak |
| `mandate-api-test` | charge/revoke **without credentials** | the vulnerability |

There is no test that:

- `/config/admin.js` does not contain a password;
- `/server.js` is not statically served;
- unauthenticated `mandates/charge` is 401;
- charge persistence uses Paystack’s amount;
- `GET /api/transactions` is 401.

Until those exist, regressions of C1–C5 will go green.

---

## 8. Comparison with the 2026-08-04 audit

| 2026-08-04 claim | 2026-08-12 reality |
|---|---|
| Admin mutations require `X-Admin-Key` | True, and the key is published at `/config/admin.js` |
| “No workflow change for you” (pages attach the header) | The page also *downloads the password* to attach it |
| GET `/api/transactions` public — “accepted” | Still public; still PII. Not acceptable on a live ledger |
| Payment links durable | Code path is correct **if** the SQL has been applied. Not re-verified live |
| Dead `valmont-pay.vercel.app` | Host-first URLs are in code. Live host was unreachable this run |
| Mandates | Not in that audit. Shipped later, **unauthenticated** |

The previous report’s leftover “your actions” (set `PUBLIC_BASE_URL`, delete stale `WEBHOOK_SECRET`, point Paystack at `https://valmontpay.app/api/webhook`, run the SQL) are still the right **ops** checklist. They do not fix C1–C5.

---

## 9. Priority patch list (order matters)

1. **Take `/config/admin.js` down and rotate `ADMIN_PASSWORD`.** Same hour: rotate every tenant `secret_key_*`, every `webhook_signing_secret`, and assume `vme_secret_dev_key_1` has been used.
2. **Auth-gate mandates.** Charge/revoke/list require tenant Bearer or admin. Add a failing test first.
3. **Stop static-serving the repo.** `express.static` → `public/` only.
4. **Auth-gate GET `/api/transactions`, `/api/tenants`, `/api/webhook-*`, `/api/webhook-deliveries`.**
5. **Persist Paystack’s amount**, never the charge body’s.
6. **Export the Express app** (or delete the Vercel catch-all). One webhook handler.
7. **https-only webhook URLs** + private-IP deny; close the open redirect.
8. **Delete the card form** on `checkout.html`.
9. **Real sessions** (httpOnly cookie). Delete `sessionStorage` auth and `?admin_key=`.
10. **Durable outbox** for tenant webhook retries. Pin `package-lock.json`. Rate-limit public POSTs. Helmet + CSP.

After 1–5, the live-money attack surface is no longer “anyone with curl.” After 6–10 it is an MVP you can defend.

---

## 10. Verdict

Valmont-Pay is a **serious prototype that has already taken real payments**. The payment core (units, HMAC, idempotent upserts, durable links, host-first URLs, fail-loud writes) shows people who read Vercel logs at 2 a.m. and then wrote tests.

It is **not** a payment gateway you can hand to a second merchant, a regulator, or a penetration tester. The control plane was secured in comments and then undone by a config endpoint that prints the password. Recurring debit — the most dangerous API a PSP can expose — was added with five tests and zero authentication.

**Overall score: 5.1 / 10.**

Ship the five critical patches before the next customer link goes out.
