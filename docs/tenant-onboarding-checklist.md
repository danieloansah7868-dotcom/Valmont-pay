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

**Also fixed while here:** `POST /api/tenants/{key}/rotate-keys` rotated the in-memory registry ONLY — on Vercel the rotation evaporated at the next cold start while the database still held the old key, so a "revoked" credential came back to life. Rotation now persists to Supabase first and returns 503 when it cannot. See [`docs/key-rotation.md`](key-rotation.md).

### ✅ F3 — RESOLVED: a new tenant can now pay through its own Paystack account

Previously `pay.html` → `POST /api/initialize-payment` always charged the global `PAYSTACK_SECRET_KEY`, so every merchant's money landed in the gateway account and a tenant's own `paystack_secret_key` was half-wired (used for pre-init, ignored at charge time).

Per-tenant Paystack touches **four** call sites, and missing the webhook one produces the worst failure in payments: Paystack takes the money, our single-key verifier rejects the event as a forgery, and the payment never reaches the ledger. All four now resolve through one module, `lib/paystack-credentials.js`:

| Call site | Behaviour now |
|---|---|
| Initialize (`/api/initialize-payment`) | Charges the tenant's account when it has one |
| Webhook ingest (`/api/webhook`) | Accepts an event signed by **any** configured credential |
| Verify (`/api/verify-payment`) | Verifies against the account that charged the reference |
| Split settlement | `paystack_subaccount`, already per tenant |

Everything falls back to the gateway credential, so all five existing tenants behave **exactly** as before.

**Security note:** signature verification tries every candidate and never returns on first match, so the time taken does not reveal which tenants hold their own account.

**Still true:** the admin form has no field for a tenant's own Paystack keys. Set `TENANT__<KEY>__PAYSTACK_SECRET_KEY` in Vercel, or write the column directly.

### 🟡 F4 — `valmont-electricals` may still be using a committed dev credential

`lib/tenants.js` defaults this tenant's secret to `vme_secret_dev_key_1`, and `scripts/supabase-tenants-schema.sql` seeds that **same literal string** into the database. Precedence is `env > DB > default`, so unless `TENANT__VALMONT_ELECTRICALS__SECRET_KEY_1` is set in Vercel, that public, repo-committed value is the live API credential for your flagship merchant.

**Action:** run the one-line diagnostic in [`docs/key-rotation.md` § 1](key-rotation.md#1-is-the-valmont-electricals-dev-credential-live-right-now) and follow § 2 or § 3 there.

### ✅ F5 — RESOLVED: per-tenant receipt routing

`lib/notifier.js` previously read one global target (`MERCHANT_NOTIFICATION_PHONE`, `MERCHANT_NOTIFICATION_EMAIL`, …), so a new merchant never received their own receipt.

Tenants now carry `notification_phone` / `notification_email` (new nullable columns, `TENANT__<KEY>__NOTIFICATION_PHONE` / `__NOTIFICATION_EMAIL` env overrides, and two fields in the admin form). A tenant's own values win; blank — every tenant that predates this — keeps the gateway-wide target unchanged.

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
| `lib/paystack-credentials.js` | **New** — single source of truth for which Paystack credential charges, signs and verifies per tenant |
| `lib/webhook.js`, `api/webhook.js` | Webhook ingest accepts an event signed by a tenant's own Paystack account |
| `server.js` | `/api/initialize-payment` and `/api/verify-payment` use the tenant's credential; `rotate-keys` now persists to Supabase (was in-memory only) |
| `lib/notifier.js` | Per-tenant `notification_phone` / `notification_email` override the gateway-wide target |
| `lib/tenant-store.js` | New `notification_email` / `notification_phone` columns whitelisted, mapped, sanitised, settable on create/update |
| `lib/tenants.js` | `TENANT__…__NOTIFICATION_*` env overrides; **dev credentials now resolve to empty in a deployed environment** |
| `scripts/supabase-tenants-schema.sql` | New notification columns; the Electricals seed no longer inserts a known credential |
| `scripts/multi-tenant-smoke-test.mjs` | Fixed the vacuous harness; self-hosting; environment-aware webhook/rotate tests; wired into `npm test` |
| `scripts/new-tenant-onboarding-test.mjs` | **New** — 53 checks over the admin create path, rotation durability and the pinned new-tenant defaults |
| `scripts/per-tenant-paystack-test.mjs` | **New** — 32 checks over per-tenant charging, webhook signing, verification and receipt routing |
| `tenants.html` | New-tenant form seeds `localhost,valmontpay.app`; notification fields added |
| `package.json` | `test:onboarding`, `test:paystack`, `test:multi-tenant`; all three run in `npm test` |

## 4. Runbook: adding a tenant

### Step 0 — deploy prerequisites (once)

Two things must be true in production before the first new tenant:

1. **Run the notification migration** in Supabase → SQL Editor:
   ```sql
   alter table public.tenants add column if not exists notification_email text;
   alter table public.tenants add column if not exists notification_phone text;
   ```
   (That block is at the top of `scripts/supabase-tenants-schema.sql`; it is safe to re-run.)

   If you deploy the code *without* it, tenant creation still works — the store retries the write without the new columns and the admin UI shows a **⚠ Database migration pending** banner naming what is missing. Per-tenant receipts just fall back to the gateway-wide target. It will not block onboarding.

2. **Settle the shared dev credential** — run the diagnostic in [`docs/key-rotation.md` § 1](key-rotation.md#1-is-the-valmont-electricals-dev-credential-live-right-now). Do this *before* adding a merchant, not after, so you are not rotating keys while a new integration is mid-rollout.

### Before you start — collect these

- [ ] **Slug** — lowercase, 2–63 chars, letters/numbers/hyphens, must start with a letter or digit (e.g. `new-shop`)
- [ ] **Display name** — unique; not "Valmont Web Services"; does not slugify to an existing tenant key
- [ ] **Allowed domains** — the storefront domain(s) that will send `callback_url`, **plus** `valmontpay.app`
- [ ] **Webhook URL** — `https://<their-site>/api/valmontpay/webhook` (optional but recommended)
- [ ] **Paystack subaccount** — `ACCT_…` if their money must settle separately
- [ ] **Own Paystack account?** — optional; set `TENANT__<KEY>__PAYSTACK_SECRET_KEY` in Vercel if this merchant should charge on their own account instead of the gateway's (see F3)
- [ ] **Notification phone / email** — this merchant's own receipt target; blank means the gateway-wide one

### Create

1. `/admin-login.html` → `/tenants.html` → **Add Tenant**.
2. Fill in the slug and display name.
3. **Replace the `allowed_domains` default** — keep `valmontpay.app`, add their storefront domain.
4. Set **Environment → Live** (cosmetic badge, but avoid the amber "test" on a live merchant).
5. Set the webhook URL and, if needed, the subaccount.
6. Fill in **Notification Phone / Email** if this merchant should get their own receipt messages.
7. **Copy the three secrets immediately.** They are shown once and never again.

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
- their webhook receives a signed `charge.success` (`x-valmontpay-signature`, HMAC-SHA512 of the raw body with their signing secret),
- the receipt goes to **their** notification target (check the Vercel log line `[VALMONT-NOTIFIER] Merchant contact for … [source: tenant (…)]`).

### Tell the storefront integrator

- ❌ `pay.html?amount=…&merchant=…` is **retired** and refused in production. The only public path is `pay.html?access_code=…`, minted server-side.
- ✅ Amounts are **cedis** (major units): `23.50` = GH₵23.50. Never pesewas.
- Full contract: [`docs/tenant-integration.md`](tenant-integration.md).

---

## 5. Open items

| # | Item | Why it is open |
|---|---|---|
| F4 | Confirm/rotate the Electricals dev credential | Needs a Vercel env check — follow [`docs/key-rotation.md`](key-rotation.md) |
| F6 | Display-name shadowing — a new tenant called e.g. "Valmont Gadget" resolves to the existing `valmont-gadget` key | Cosmetic today; would matter if two merchants pick near-identical names |
| — | `environment` defaults to `test` for new tenants | Display-only, but reads as "this merchant is in test mode" |
| — | Admin form has no field for a tenant's own Paystack keys | Deliberate: set `TENANT__<KEY>__PAYSTACK_SECRET_KEY` in Vercel |
