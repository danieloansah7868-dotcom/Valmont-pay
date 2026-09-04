#!/usr/bin/env node

/**
 * New-tenant onboarding test.
 *
 * This is the guard for the question "is it safe to add another merchant?".
 * It drives the REAL admin creation path (lib/tenant-store.createTenant →
 * lib/tenants.applyDbTenant, exactly what POST /api/admin/tenants does)
 * against a stubbed Supabase, then pins down the effective configuration a
 * brand-new tenant receives.
 *
 * Why it exists: several of those defaults are surprising, and two of them
 * silently break a new merchant's integration if an operator accepts them:
 *
 *   1. allowed_domains defaults to EMPTY, so EVERY callback_url the new
 *      tenant sends — including valmontpay.app — is rejected with 400
 *      "Domain … is not in the allowlist for this merchant".
 *   2. A new tenant gets no Paystack credential of its own, so its payments
 *      are charged on the global Paystack account. Per-tenant money
 *      separation is ONLY possible through paystack_subaccount (a split).
 *
 * Both behaviours are deliberate and correct; this test records them so a
 * future change (or a new operator) cannot be surprised by them.
 *
 * Run it: node scripts/new-tenant-onboarding-test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Offline posture: a stubbed database, a fake global Paystack credential.
// No real network call is made anywhere in this file.
process.env.PAYSTACK_SECRET_KEY = 'sk_live_offline_onboarding_test';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key';
delete process.env.TENANTS_JSON;

const tenantStore = require('../lib/tenant-store.js');
const tenants = require('../lib/tenants.js');
const forwarder = require('../lib/tenant-webhook-forwarder.js');

// ─── In-memory stub Supabase ─────────────────────────────────────────────

const rows = [];

function stubClient() {
  const api = {
    from(table) {
      assert.equal(table, 'tenants', 'test only stubs the tenants table');
      const self = {
        upsert(record) { self._pending = { op: 'upsert', record }; return self; },
        update(patch) { self._pending = { op: 'update', patch }; return self; },
        eq(col, val) { self._filter = { col, val }; return self; },
        order() { return self; },
        select() { return self; },
        single() { return self; },
        maybeSingle() { return self; },
        then(resolve) {
          let result = { data: null, error: null };
          const p = self._pending || {};
          if (p.op === 'upsert') {
            const row = { id: `uuid-${rows.length + 1}`, ...p.record };
            rows.push(row);
            result.data = row;
          } else if (p.op === 'update') {
            const row = rows.find(r => r.key === self._filter.val);
            if (row) Object.assign(row, p.patch);
            result.data = row || null;
          } else if (self._filter) {
            // select(...).eq(col, val).single()
            result.data = rows.find(r => r[self._filter.col] === self._filter.val) || null;
          } else {
            // select('*').order(...)
            result.data = rows;
          }
          return Promise.resolve(result).then(resolve);
        }
      };
      return self;
    }
  };
  return api;
}

tenantStore.setSupabaseClient(stubClient());

// ─── Helpers ────────────────────────────────────────────────────────────

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
  console.log(`  ✓ ${message}`);
};

console.log('\n# Creating a new tenant through the admin path');

const created = await tenantStore.createTenant({
  key: 'new-shop',
  display_name: 'New Shop'
});

check(created.ok === true, 'createTenant succeeds (Supabase stubbed)');
check(
  Boolean(created.rawSecrets && created.rawSecrets.secret_key_1),
  'an API secret key is generated for the new tenant'
);
check(
  Boolean(created.rawSecrets && created.rawSecrets.webhook_signing_secret),
  'a webhook signing secret is generated for the new tenant'
);

// Exactly what POST /api/admin/tenants does after the write.
const t = tenants.applyDbTenant(tenantStore.rowToTenant(created.raw));

console.log('\n# The new tenant is immediately live');

check(tenants.getTenant('new-shop') === t, 'resolves by key');
check(tenants.getTenantByIdentifier('New Shop') === t, 'resolves by display name');
check(
  tenants.getTenantBySecretKey(created.rawSecrets.secret_key_1) === t,
  'Bearer auth with the new secret key resolves the right tenant'
);
check(
  tenants.listTenants().some(x => x.key === 'new-shop'),
  'appears in the public GET /api/tenants branding list'
);
check(
  tenants.publicTenant(t).secret_keys === undefined,
  'the public view exposes no secrets'
);

console.log('\n# Default configuration a new tenant receives (pinned on purpose)');

check(
  Array.isArray(t.allowed_domains) && t.allowed_domains.length === 0,
  'allowed_domains is EMPTY by default — every callback_url is rejected until it is set'
);

const ownDomain = tenants.validateCallbackUrl(t, 'https://newshop.com/checkout/thanks');
check(
  ownDomain.valid === false && /not in the allowlist/.test(ownDomain.reason),
  'the tenant\'s own storefront callback_url is REJECTED while allowed_domains is empty'
);
check(
  tenants.validateCallbackUrl(t, 'https://valmontpay.app/checkout.html').valid === false,
  'even valmontpay.app is rejected while allowed_domains is empty'
);

check(
  t.paystack_secret_key === undefined || t.paystack_secret_key === '',
  'no tenant Paystack secret key — payments are charged on the global account'
);
check(
  t.paystack_subaccount === undefined || t.paystack_subaccount === '',
  'no Paystack subaccount — no split settlement until one is configured'
);
check(t.environment === 'test', 'environment defaults to "test" (display-only badge)');
check(!t.webhook_url, 'webhook_url is empty — nothing is forwarded to the storefront yet');
check(
  forwarder.dispatchWebhook && typeof forwarder.dispatchWebhook === 'function',
  'the forwarder is available once a webhook_url is set'
);
check(Boolean(forwarder.resolveSigningSecret(t)), 'a signing secret resolves for HMAC signatures');

console.log('\n# Configuring the tenant the way an operator must');

const updated = await tenantStore.updateTenant('new-shop', {
  allowed_domains: ['newshop.com', 'valmontpay.app'],
  webhook_url: 'https://newshop.com/api/valmontpay/webhook',
  paystack_subaccount: 'ACCT_newshop',
  environment: 'live'
});
check(updated.ok === true, 'updateTenant succeeds');

const t2 = tenants.applyDbTenant(tenantStore.rowToTenant(updated.raw));
check(
  tenants.validateCallbackUrl(t2, 'https://newshop.com/checkout/thanks').valid === true,
  'the storefront callback_url is accepted once its domain is allowlisted'
);
check(
  tenants.validateCallbackUrl(t2, 'https://evil.example/thanks').valid === false,
  'an unrelated domain is still rejected'
);
check(t2.webhook_url === 'https://newshop.com/api/valmontpay/webhook', 'webhook forwarding target is set');
check(t2.paystack_subaccount === 'ACCT_newshop', 'subaccount is set for split settlement');
check(t2.environment === 'live', 'environment badge flips to live');

console.log('\n# Guardrails a new tenant must not trip');

check(
  tenants.validateTenantIdentityForCreate({ key: 'valmontweb', display_name: 'Anything' }).valid === false,
  'the retired "valmontweb" key is rejected'
);
check(
  tenants.validateTenantIdentityForCreate({ key: 'valmont-web-services', display_name: 'Anything' }).valid === false,
  'the reserved SKU catalogue merchant key is rejected'
);
check(
  tenants.validateTenantIdentityForCreate({ key: 'another-shop', display_name: 'Valmont Web Services' }).valid === false,
  'a duplicate "Valmont Web Services" display name is rejected'
);
check(
  tenants.validateTenantIdentityForCreate({ key: 'new-shop-2', display_name: 'New Shop 2' }).valid === true,
  'an ordinary new merchant is accepted'
);

// A display name that slugifies onto ANOTHER tenant's key would capture that
// tenant's lookups.
check(
  tenants.validateTenantIdentityForCreate({ key: 'other-shop', display_name: 'New Shop' }).valid === false,
  'a display name that resolves to another tenant\'s key is rejected'
);
check(
  tenants.validateTenantIdentityForCreate({ key: 'new-shop', display_name: 'New Shop' }).valid === true,
  'a tenant may still keep a name that resolves to its OWN key'
);
check(
  tenants.validateTenantIdentityForUpdate('other-shop', { display_name: 'New Shop' }).valid === false,
  'a rename cannot capture another tenant\'s lookups either'
);
check(
  tenants.validateTenantIdentityForUpdate('new-shop', { display_name: 'New Shop' }).valid === true,
  'renaming a tenant to its own slug is allowed'
);

// Re-creating an existing slug used to silently OVERWRITE the live tenant and
// mint it a fresh API secret, taking a working integration offline.
const duplicate = await tenantStore.createTenant({
  key: 'new-shop',
  display_name: 'New Shop Duplicated'
});
check(duplicate.ok === false, 're-creating an existing tenant key is refused, not upserted');
check(
  /already exists/i.test(duplicate.reason || ''),
  'the refusal explains that editing is the safe path'
);
check(
  tenants.getTenant('new-shop').display_name === 'New Shop',
  'the existing tenant was left untouched'
);
check(
  tenants.getTenantBySecretKey(created.rawSecrets.secret_key_1) === tenants.getTenant('new-shop'),
  'and its original secret key still works (no silent rotation)'
);

const badSlugs = ['New Shop!', 'a', 'a'.repeat(64), '-leading', 'Upper_Case'];
for (const slug of badSlugs) {
  const result = await tenantStore.createTenant({ key: slug, display_name: 'Bad Slug' });
  check(result.ok === false, `slug "${slug.slice(0, 12)}" is refused`);
}
check((await tenantStore.createTenant({ key: 'ab', display_name: 'Two Chars' })).ok === true, 'a 2-character slug is accepted');
check((await tenantStore.createTenant({ key: 'a'.repeat(63), display_name: 'Long' })).ok === true, 'a 63-character slug is accepted');

console.log('\n# Creating a tenant must not depend on the newest migration');

// The notification columns were added after the first tenants existed. If a
// deployment ships the code before the migration is run, PostgREST rejects
// the upsert — and onboarding a merchant is exactly when that would bite.
function stubMissingColumnClient() {
  let attempts = 0;
  return {
    from(table) {
      assert.equal(table, 'tenants');
      const self = {
        upsert(record) { self._pending = { op: 'upsert', record }; return self; },
        update(patch) { self._pending = { op: 'update', patch }; return self; },
        eq(col, val) { self._filter = { col, val }; return self; },
        order() { return self; },
        select() { return self; },
        single() { return self; },
        maybeSingle() { return self; },
        then(resolve) {
          attempts += 1;
          const p = self._pending || {};
          // Old schema: the notification columns do not exist yet.
          if (p.op === 'upsert' && 'notification_email' in p.record) {
            return Promise.resolve({
              data: null,
              error: {
                message: "Could not find the 'notification_email' column of 'tenants' in the schema cache"
              }
            }).then(resolve);
          }
          // A plain select (the duplicate-key check) — never fabricate a row.
          if (!p.op && self._filter) {
            const found = rows.find(r => r[self._filter.col] === self._filter.val) || null;
            return Promise.resolve({ data: found, error: null }).then(resolve);
          }

          const row = { id: `uuid-legacy-${attempts}`, ...p.record };
          rows.push(row);
          return Promise.resolve({ data: row, error: null }).then(resolve);
        }
      };
      return self;
    }
  };
}

tenantStore.setSupabaseClient(stubMissingColumnClient());
const legacy = await tenantStore.createTenant({
  key: 'pre-migration-shop',
  display_name: 'Pre Migration Shop',
  notification_email: 'shop@example.com',
  notification_phone: '0244000002'
});
tenantStore.setSupabaseClient(stubClient());

check(legacy.ok === true, 'a tenant is still created when the notification columns are missing');
check(
  Array.isArray(legacy.migrationPending) && legacy.migrationPending.includes('notification_email'),
  'the caller is told which columns the database is missing'
);
// Exactly what POST /api/admin/tenants does after the write.
tenants.applyDbTenant(tenantStore.rowToTenant(legacy.raw));
check(
  tenants.getTenant('pre-migration-shop') !== undefined,
  'the tenant is usable immediately, before the migration is run'
);
check(
  tenants.getTenantBySecretKey(legacy.rawSecrets.secret_key_1)
    === tenants.getTenant('pre-migration-shop'),
  'and its issued secret key already authenticates'
);

console.log('\n# Key rotation must survive a cold start');

// This is the regression guard for the bug this audit found:
// POST /api/tenants/{key}/rotate-keys used to rewrite the in-memory registry
// only, so on a serverless platform the "revoked" credential came back at the
// next cold start while the database still held it.
const beforeRotate = tenants.getTenant('new-shop').secret_keys[0];
const rotated = await tenantStore.rotateSecrets('new-shop');
check(rotated.ok === true, 'rotateSecrets persists to the database');
check(
  rotated.secret_key_2 === beforeRotate,
  'the previous key is preserved as secret_key_2 during rotation (zero downtime)'
);
check(rotated.secret_key_1 !== beforeRotate, 'a new secret_key_1 is issued');

tenants.updateTenantInMemory('new-shop', {
  secret_keys: [rotated.secret_key_1, rotated.secret_key_2].filter(Boolean)
});
check(
  tenants.getTenantBySecretKey(rotated.secret_key_1) === tenants.getTenant('new-shop'),
  'the new key authenticates immediately'
);
check(
  tenants.getTenantBySecretKey(beforeRotate) === tenants.getTenant('new-shop'),
  'the old key still authenticates during the rotation window'
);

// Simulate a serverless cold start: rebuild the registry from the database.
tenants.resetRegistryForTests();
const { tenants: dbRows } = await tenantStore.loadTenants({ client: stubClient() });
for (const row of dbRows) tenants.applyDbTenant(row);

const afterColdStart = tenants.getTenant('new-shop');
check(
  tenants.getTenantBySecretKey(rotated.secret_key_1) === afterColdStart,
  'the new key STILL authenticates after a cold start (rotation was durable)'
);

// One rotation keeps the old key alive as secret_key_2 (that is the point of
// a rotation window). A SECOND rotation is what actually retires it.
const second = await tenantStore.rotateSecrets('new-shop');
tenants.updateTenantInMemory('new-shop', {
  secret_keys: [second.secret_key_1, second.secret_key_2].filter(Boolean)
});
check(
  tenants.getTenantBySecretKey(beforeRotate) === undefined,
  'a second rotation permanently retires the original key'
);
check(
  tenants.getTenantBySecretKey(second.secret_key_1) === tenants.getTenant('new-shop'),
  'the newest key authenticates after the second rotation'
);

console.log('\n# Committed dev credentials must never reach a deployment');

// The literals in lib/tenants.js are public (they are in git). They are fine
// for a laptop and indefensible in production, so a deployed environment
// resolves them to empty and the tenant fails closed instead.
const { execFileSync } = require('node:child_process');
const repoRoot = new URL('..', import.meta.url).pathname;
const tenantsModulePath = new URL('../lib/tenants.js', import.meta.url).pathname;

// The path is passed as argv rather than written into the script text: the
// build guard (scripts/verify-module-graph.mjs) scans source for relative
// require() specifiers, and a literal one here would be read as an import of
// ./lib/tenants.js from scripts/, which does not exist.
const probe = (envAssignment) => JSON.parse(
  execFileSync(process.execPath, [
    '-e',
    `${envAssignment}` +
      'const modulePath = process.argv[1];' +
      'const t = require(modulePath);' +
      "const e = t.getTenant('valmont-electricals');" +
      'process.stdout.write(JSON.stringify({ secrets: e.secret_keys, signing: e.webhook_signing_secret || null }));',
    tenantsModulePath
  ], { cwd: repoRoot }).toString()
);

const local = probe('');
const deployed = probe("process.env.VERCEL='1';");

check(local.secrets.length > 0, 'local runs keep the dev credential so tests and laptops work');
check(
  deployed.secrets.length === 0,
  'a deployed environment gets NO baked credential (fails closed, no public secret)'
);
check(
  deployed.signing === null || deployed.signing === '',
  'a deployed environment gets no baked webhook signing secret either'
);

console.log('\n# Architecture facts a new tenant inherits');

const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
check(
  /secretKey: paystackCredentials\.chargeSecret\(chargeTenant\)/.test(serverSource),
  'the customer-facing charge uses the TENANT Paystack key when it has one, else the gateway key'
);
check(
  /verifyPaymentWithKey\(\s*reference,\s*paystackCredentials\.chargeSecret\(verifyTenant\)/.test(serverSource),
  'verification uses the same credential the charge used'
);
check(
  /subaccount = subaccount \|\| \(intentTenant && intentTenant\.paystack_subaccount\) \|\| undefined/.test(serverSource),
  'paystack_subaccount still splits settlement per tenant'
);

const webhookSource = fs.readFileSync(new URL('../lib/webhook.js', import.meta.url), 'utf8');
const apiWebhookSource = fs.readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');
check(
  /matchesAnyWebhookSecret\(raw, signature\)/.test(webhookSource),
  'webhook ingestion accepts an event signed by a tenant\'s own Paystack account'
);
check(
  /verifyWithVariantsAnySecret\(rawBody, signature, parsedForVariants\)/.test(apiWebhookSource),
  'the serverless webhook handler does the same'
);

const notifierSource = fs.readFileSync(new URL('../lib/notifier.js', import.meta.url), 'utf8');
check(
  /tenantPhone \|\|\s*process\.env\.MERCHANT_NOTIFICATION_PHONE/.test(notifierSource),
  'a tenant\'s own notification target wins over the gateway-wide one'
);

const payHtml = fs.readFileSync(new URL('../pay.html', import.meta.url), 'utf8');
check(
  /\/api\/config\/pay/.test(payHtml),
  'pay.html still fails closed on the server-side legacy-link policy'
);

const tenantsHtml = fs.readFileSync(new URL('../tenants.html', import.meta.url), 'utf8');
check(
  /document\.getElementById\('f_allowed_domains'\)\.value = 'localhost,valmontpay\.app'/.test(tenantsHtml),
  'the admin "new tenant" form seeds allowed_domains with valmontpay.app, not just localhost'
);

console.log(`\n✓ new-tenant onboarding: all ${checks} checks passed.`);
console.log('  Reminder for operators: after creating a tenant, set allowed_domains');
console.log('  (replace the "localhost" default), webhook_url, and paystack_subaccount —');
console.log('  see docs/tenant-onboarding-checklist.md.\n');
