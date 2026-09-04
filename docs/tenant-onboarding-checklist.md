# Adding a new tenant — audit findings & runbook

**Audited:** 2026-09-04 · **Branch:** `arena/01a06c9e-valmont-pay` · **Production:** `https://valmontpay.app`

This document answers two questions:

1. **Are the existing tenants live and working?** → [§ 1](#1-live-status-of-current-tenants)
2. **Is it safe to add another one, and what will bite me?** → [§ 2](#2-audit-findings) and [§ 4](#4-runbook-adding-a-tenant)

---

## 1. Live status of current tenants

Verified against production from the outside (no credentials used):

| Check | Result |
|---|---|
| `GET /api/health` | `ok: true` — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY` all configured; Supabase is using the **service-role** credential (writes bypass RLS) |
| `GET /api/config/pay` | `allow_legacy_amount_url: false` — the unsigned `?amount=` flow is off, as intended |
| `GET /api/v1/payment-link/catalogue` | 8 SKUs served under `valmont-web-services` |
| `GET /api/admin/tenants` (anonymous) | `401` — admin CRUD is genuinely guarded |
| `GET /api/transactions` (anonymous) | `401` — ledger PII is guarded |
| `GET /config/admin.js` | Removed (`window.ADMIN_CONFIG = undefined`) |

All five tenants resolve and serve branding:

| Tenant key | Display name | Origin |
|---|---|---|
| `valmont-electricals` | Valmont Electricals | built-in default + DB seed |
| `valmont-web-services` | Valmont Web Services | SKU catalogue merchant (reserved) |
| `nanahemaa-market` | Nanahemaa Market | admin-created (DB only) |
| `valmont-gadget` | Valmont Gadgets | admin-created (DB only) |
| `valmontdata` | Valmont Data | admin-created (DB only) |
| `valmontweb` → | *resolves to* Valmont Web Services | legacy read-only alias |

**The important signal:** `nanahemaa-market`, `valmont-gadget` and `valmontdata` do **not** exist anywhere in this repository — they live only in the Supabase `tenants` table. Three merchants were already created through the exact admin path you are about to use, and all three serve live. The create path works.

**Test suite:** `npm test` → 17 suites, all green (was 15; this branch adds two — see below).

---

## 2. Audit findings

### 🔴 F1 — The multi-tenant smoke test was a no-op that always reported success

`scripts/multi-tenant-smoke-test.mjs` defined 19 tests but called `test(...)` **fire-and-forget** and printed its summary synchronously. Every run ended with:

```
Results: 0 passed, 0 failed
All tests passed!
```

…while all 68 assertions were still in flight and the process exited. It was also **not wired into `npm test`**, so nothing caught this. This is the one test that would have caught a broken tenant.

**Fixed:**
- Tests are queued and awaited (`runQueue()`).
- The script now refuses to report success if zero assertions ran.
- It boots its **own** server (spare port + `scripts/fixtures/test-merchant-a.json`) so it is a single command — `node scripts/multi-tenant-smoke-test.mjs`, or `TEST_BASE_URL=… node …` to point at a running deployment.
- Wired into `npm test` and `npm run test:multi-tenant`.
- Test 13 (`PUT /api/tenants/{key}/webhook`) now asserts the correct contract per environment: a real persist when Supabase is configured, and a loud `503 Supabase is not configured` with the URL left unchanged when it is not.

**Real result now: 68 passed, 0 failed.** Verified the harness genuinely fails (exit 1) against a dead server.

> ⚠️ Every run must use a **fresh** server: test 14 rotates `valmont-electricals`' secret in memory, so a second run against the same process correctly fails *"old key still works during rotation"*.

### 🟠 F2 — The "new tenant" form pre-filled `allowed_domains` with `localhost`

`tenants.html` seeded the field with `'localhost'`. An operator who accepted the default shipped a tenant whose **production** `callback_url` was rejected with:

```
400 Invalid callback_url: Domain "theirstore.com" is not in the allowlist for this merchant
```

A new tenant's `allowed_domains` starts **empty** server-side, so *every* callback — including `valmontpay.app` — is refused until the domain is allowlisted.

**Fixed:** the form now seeds `'localhost,valmontpay.app'`.

### 🟠 F3 — A new tenant cannot take payments on its own Paystack account

The customer-facing charge path (`pay.html` → `POST /api/initialize-payment`) **always** uses the global `PAYSTACK_SECRET_KEY`. The only per-tenant money routing is `paystack_subaccount` (a Paystack split). A tenant's own `paystack_secret_key` is used only for pre-initialisation and for `GET /api/transaction/verify/:reference` fallbacks.

So: a new tenant's money lands in **your** Paystack account unless you configure a subaccount. Also note the admin form has **no** field for a tenant's own Paystack keys — consistent with the architecture, but it means `paystack_secret_key` can only be set by env var or direct DB edit.

Edge case worth knowing: if you *do* give a tenant its own `paystack_secret_key` from a different Paystack account, `verify` falls back to that key only when the transaction is not already in the ledger — and it fails closed (404) rather than mis-reporting.

### 🟡 F4 — `valmont-electricals` may still be using a committed dev credential

`lib/tenants.js` defaults this tenant's secret to `vme_secret_dev_key_1`, and `scripts/supabase-tenants-schema.sql` seeds that **same literal string** into the database. Precedence is `env > DB > default`, so unless `TENANT__VALMONT_ELECTRICALS__SECRET_KEY_1` is set in Vercel, that public, repo-committed value is the live API credential for your flagship merchant.

**Action:** check Vercel → if the var is unset, rotate immediately (`/tenants.html` → *Rotate keys*).

### 🟡 F5 — Notifications are global, not per-tenant

`lib/notifier.js` reads `ADMIN_NOTIFICATION_PHONE`, `MERCHANT_NOTIFICATION_EMAIL`, etc. — one global target. A new merchant does not get their own receipt SMS/email; their only private signal is their `webhook_url`.

### 🟡 F6 — Display names can shadow tenant keys

`getTenantByIdentifier()` slugifies a display name before matching, so a new tenant called e.g. "Valmont Gadget" resolves to the existing `valmont-gadget` key. Keep display names distinct from other tenants' keys and names.

### 🟢 Verified good

- Reserved-identity guardrails hold: `valmontweb`, `valmont-web-services`, and a duplicate "Valmont Web Services" display name are all refused at create/update.
- Slug validation is strict and consistent (2–63 chars, `^[a-z0-9][a-z0-9-]{1,62}$`, lowercase).
- Secrets (API secret, public key, webhook signing secret) are generated at create time and shown **once**.
- A created tenant is live **immediately** — no redeploy needed (`applyDbTenant` updates the in-memory registry; new serverless instances load it at boot).
- Public `GET /api/tenants` leaks nothing but branding (key, name, colour, logo, currency).
- Write endpoints never pretend to succeed: without Supabase they return `503` rather than faking a save.

---

## 3. What changed in this branch

| File | Change |
|---|---|
| `scripts/multi-tenant-smoke-test.mjs` | Fixed the vacuous harness; self-hosting; environment-aware webhook test; wired into `npm test` |
| `scripts/new-tenant-onboarding-test.mjs` | **New** — 38 checks that drive the real admin create path against a stubbed Supabase and pin the defaults a new tenant receives |
| `tenants.html` | New-tenant form seeds `allowed_domains` with `localhost,valmontpay.app` |
| `package.json` | Added `test:onboarding` and `test:multi-tenant`; both now run in `npm test` |

---

## 4. Runbook: adding a tenant

### Before you start — collect these

- [ ] **Slug** — lowercase, 2–63 chars, letters/numbers/hyphens, must start with a letter or digit (e.g. `new-shop`)
- [ ] **Display name** — unique; not "Valmont Web Services"; does not slugify to an existing tenant key
- [ ] **Allowed domains** — the storefront domain(s) that will send `callback_url`, **plus** `valmontpay.app`
- [ ] **Webhook URL** — `https://<their-site>/api/valmontpay/webhook` (optional but recommended)
- [ ] **Paystack subaccount** — `ACCT_…` if their money must settle separately

### Create

1. `/admin-login.html` → `/tenants.html` → **Add Tenant**.
2. Fill in the slug and display name.
3. **Replace the `allowed_domains` default** — keep `valmontpay.app`, add their storefront domain.
4. Set **Environment → Live** (cosmetic badge, but avoid the amber "test" on a live merchant).
5. Set the webhook URL and, if needed, the subaccount.
6. **Copy the three secrets immediately.** They are shown once and never again.

### Post-create verification

```bash
# 1. Public branding resolves
curl -s https://valmontpay.app/api/tenants/<slug>

# 2. Bearer auth works (expect 404 "not found", NOT 401 — 401 means a bad key)
curl -s -H "Authorization: Bearer <secret_key_1>" \
  https://valmontpay.app/api/transaction/verify/NOT-A-REAL-REF

# 3. Mint a real payment link (amount is server-side; nothing to tamper with)
curl -s -X POST https://valmontpay.app/api/transaction/initialize \
  -H "Authorization: Bearer <secret_key_1>" \
  -H "Content-Type: application/json" \
  -d '{"amount":1.00,"email":"you@example.com","callback_url":"https://<their-domain>/thanks"}'
# → 400 "not in the allowlist" means step 3 of the form was missed
```

Then open the returned `pay_url`, pay GH₵1.00, and confirm:
- the transaction appears on `/dashboard.html` attributed to the new tenant,
- their webhook receives a signed `charge.success` (`x-valmontpay-signature`, HMAC-SHA512 of the raw body with their signing secret).

### Tell the storefront integrator

- ❌ `pay.html?amount=…&merchant=…` is **retired** and refused in production. The only public path is `pay.html?access_code=…`, minted server-side.
- ✅ Amounts are **cedis** (major units): `23.50` = GH₵23.50. Never pesewas.
- Full contract: [`docs/tenant-integration.md`](tenant-integration.md).

---

## 5. Open items (not fixed here)

| # | Item | Why it is open |
|---|---|---|
| F4 | Confirm/rotate the Electricals dev credential | Needs a Vercel env check or an admin session — cannot be verified from outside |
| F3 | Per-tenant Paystack accounts for the hosted flow | Architectural: `/api/initialize-payment` hard-wires the global key |
| F5 | Per-tenant notification routing | `lib/notifier.js` is global by design; needs a product decision |
| — | `environment` defaults to `test` for new tenants | Display-only, but reads as "this merchant is in test mode" |
