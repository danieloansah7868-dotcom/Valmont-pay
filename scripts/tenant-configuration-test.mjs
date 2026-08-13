#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Module defaults capture the global key at load time. Its prefix is deliberately
// opposite the DB display label below to prove environment never gates routing.
process.env.PAYSTACK_SECRET_KEY = 'sk_live_offline_tenant_test';
delete process.env.TENANTS_JSON;
delete process.env.TENANT__VALMONT_ELECTRICALS__WEBHOOK_URL;
delete process.env.TENANT__VALMONT_ELECTRICALS__ENVIRONMENT;

const tenantStore = require('../lib/tenant-store.js');
const tenants = require('../lib/tenants.js');
const catalogue = require('../lib/service-catalogue.js');

const expectedWebhook = 'https://valmontelectricals.com/api/valmontpay/webhook';

// Built-ins are production labels and Electricals works out of the box.
let electricals = tenants.getTenant('valmont-electricals');
assert.equal(electricals.environment, 'live');
assert.equal(electricals.webhook_url, expectedWebhook);
assert.equal(electricals.paystack_secret_key, 'sk_live_offline_tenant_test');
assert.equal(tenants.getTenantByIdentifier('Valmont Electricals'), electricals);

// The SKU catalogue has one public merchant identity. Its default has no
// baked-in tenant API credential, and old keys/display names only resolve as
// aliases for historical payment/link data.
const service = tenants.getTenant(catalogue.SERVICE_MERCHANT_KEY);
assert.ok(service, 'canonical catalogue tenant is registered');
assert.equal(service.key, 'valmont-web-services');
assert.equal(service.display_name, 'Valmont Web Services');
assert.deepEqual(service.secret_keys, [], 'SKU tenant has no baked-in API secret');
assert.equal(tenants.DEFAULT_TENANTS.valmontweb, undefined, 'old seed is absent from production defaults');
assert.equal(tenants.canonicalTenantKey('valmontweb'), catalogue.SERVICE_MERCHANT_KEY);
assert.equal(tenants.getTenant('valmontweb'), service, 'old key resolves to canonical tenant');
assert.equal(tenants.getTenantByIdentifier('Valmont Web'), service, 'old display name resolves to canonical tenant');
assert.equal(tenants.getTenantBySecretKey('vmw_secret_dev_key_1'), undefined, 'old baked test key is not active');
const initialCatalogueMerchants = tenants.listAllTenants().filter(tenant =>
  tenant.key === catalogue.SERVICE_MERCHANT_KEY || tenant.display_name === catalogue.SERVICE_MERCHANT_NAME
);
assert.equal(initialCatalogueMerchants.length, 1, 'there is exactly one catalogue merchant for Valmont Web Services');

function dbRow(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    key: 'valmont-electricals',
    display_name: 'Valmont Electricals',
    brand_color: '#f68b1e',
    logo_url: '/logo.svg',
    currency: 'GHS',
    environment: 'test',
    webhook_url: null,
    paystack_subaccount: null,
    settlement_account: null,
    allowed_domains: ['valmontelectricals.com'],
    secret_key_1: 'db-api-secret',
    secret_key_2: null,
    public_key: null,
    paystack_secret_key: null,
    paystack_public_key: null,
    webhook_signing_secret: 'db-webhook-secret',
    status: 'active',
    created_at: '2026-08-02T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    ...overrides
  };
}

// NULL must remain absent so the in-code webhook/key defaults can fire.
const normalizedNullRow = tenantStore.rowToTenant(dbRow());
assert.equal(normalizedNullRow.webhook_url, undefined);
assert.equal(normalizedNullRow.paystack_secret_key, undefined);
tenants.applyDbTenant(normalizedNullRow);
electricals = tenants.getTenant('valmont-electricals');
assert.equal(electricals.webhook_url, expectedWebhook, 'NULL DB URL falls back to built-in URL');
assert.equal(electricals.environment, 'test', 'a DB display label is read without coercion');
assert.equal(
  electricals.paystack_secret_key,
  'sk_live_offline_tenant_test',
  'Paystack credential does not depend on the cosmetic environment label'
);

// A non-null DB edit beats the default.
const dbWebhook = 'https://merchant.example/receiver';
tenants.applyDbTenant(tenantStore.rowToTenant(dbRow({ webhook_url: dbWebhook })));
assert.equal(tenants.getTenant('valmont-electricals').webhook_url, dbWebhook);

// A non-empty tenant env var beats the DB and the underscore env key maps back
// to the hyphenated tenant slug (the old parser incorrectly created a third key).
process.env.TENANT__VALMONT_ELECTRICALS__WEBHOOK_URL = 'https://env.example/receiver';
process.env.TENANT__VALMONT_ELECTRICALS__ENVIRONMENT = 'live';
tenants.resetRegistryForTests();
tenants.applyDbTenant(tenantStore.rowToTenant(dbRow({ webhook_url: dbWebhook, environment: 'test' })));
electricals = tenants.getTenant('valmont-electricals');
assert.equal(electricals.webhook_url, 'https://env.example/receiver');
assert.equal(electricals.environment, 'live');
assert.equal(tenants.getTenant('valmont_electricals'), undefined);

// The same parser works for tenants added later; this is not a one-off
// Electricals special case.
process.env.TENANT__GADGETS__DISPLAY_NAME = 'Valmont Gadgets';
process.env.TENANT__GADGETS__WEBHOOK_URL = 'https://gadgets.example/webhook';
tenants.resetRegistryForTests();
assert.equal(tenants.getTenant('gadgets').display_name, 'Valmont Gadgets');
assert.equal(tenants.getTenant('gadgets').webhook_url, 'https://gadgets.example/webhook');
delete process.env.TENANT__GADGETS__DISPLAY_NAME;
delete process.env.TENANT__GADGETS__WEBHOOK_URL;

// Existing DB rows are deliberately left untouched, but are not allowed to
// reappear as a second public tenant. Their key/display name resolve through
// the alias for old payment_links and ledger rows.
tenants.resetRegistryForTests();
const canonicalBeforeLegacyDb = tenants.getTenant(catalogue.SERVICE_MERCHANT_KEY);
const legacyDbTenant = tenantStore.rowToTenant(dbRow({
  key: 'valmontweb',
  display_name: 'Valmont Web',
  secret_key_1: 'legacy-row-secret'
}));
assert.equal(tenants.applyDbTenant(legacyDbTenant), undefined, 'legacy DB config is not loaded as a second tenant');
assert.equal(tenants.getTenant('valmontweb'), canonicalBeforeLegacyDb, 'legacy DB key still resolves to canonical identity');
assert.equal(tenants.getTenantByIdentifier('Valmont Web'), canonicalBeforeLegacyDb, 'legacy DB display name still resolves');
assert.equal(tenants.getTenantBySecretKey('legacy-row-secret'), undefined, 'legacy DB credentials are not reactivated');
process.env.TENANT__VALMONTWEB__SECRET_KEY_1 = 'ignored-legacy-env-key';
tenants.resetRegistryForTests();
assert.equal(tenants.getTenantBySecretKey('ignored-legacy-env-key'), undefined, 'legacy env credentials are ignored');
delete process.env.TENANT__VALMONTWEB__SECRET_KEY_1;

// A config source cannot create a third identity just by copying the display
// name or reusing the retired key.
assert.equal(tenants.validateTenantIdentityForCreate({ key: 'third-valmont', display_name: 'Valmont Web Services' }).valid, false);
assert.equal(tenants.validateTenantIdentityForCreate({ key: 'valmontweb', display_name: 'Anything' }).valid, false);
assert.equal(tenants.validateTenantIdentityForUpdate('valmontweb', {}).valid, false);
process.env.TENANTS_JSON = JSON.stringify([
  { key: 'third-valmont', display_name: 'Valmont Web Services', secret_keys: ['fixture-only-key'] }
]);
tenants.resetRegistryForTests();
assert.equal(tenants.getTenant('third-valmont'), undefined, 'duplicate JSON config is suppressed');
delete process.env.TENANTS_JSON;
delete process.env.TENANT__VALMONT_ELECTRICALS__WEBHOOK_URL;
delete process.env.TENANT__VALMONT_ELECTRICALS__ENVIRONMENT;
tenants.resetRegistryForTests();
const catalogueMerchants = tenants.listAllTenants().filter(tenant =>
  tenant.key === catalogue.SERVICE_MERCHANT_KEY || tenant.display_name === catalogue.SERVICE_MERCHANT_NAME
);
assert.equal(catalogueMerchants.length, 1, 'registry keeps exactly one catalogue merchant after config reloads');

// The Tenants UI is not hardcoded: exact live => green/live class; everything
// else => amber/test class, while the text comes from the API value itself.
const tenantsHtml = fs.readFileSync(new URL('../tenants.html', import.meta.url), 'utf8');
assert.match(
  tenantsHtml,
  /t\.environment === 'live' \? 'badge-live' : 'badge-test'/
);
assert.match(tenantsHtml, /esc\(t\.environment \|\| 'test'\)/);

// Credential routing is explicit and never mutates the process-wide key based
// on tenant.environment (which was misleading and unsafe under concurrency).
const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
assert.match(serverSource, /initializePaymentWithKey\([\s\S]*?secretKey: tenant\.paystack_secret_key/);
assert.match(serverSource, /verifyPaymentWithKey\(reference, tenant\.paystack_secret_key\)/);
assert.doesNotMatch(serverSource, /process\.env\.PAYSTACK_SECRET_KEY = tenant\.paystack_secret_key/);

// The production seed contains no old Valmont Web tenant or baked old test
// credential. Its explicit alias comment documents why existing DB/link rows
// are preserved rather than deleted.
const migration = fs.readFileSync(new URL('./supabase-tenants-schema.sql', import.meta.url), 'utf8');
assert.match(migration, /'valmont-electricals'[\s\S]*?'live'[\s\S]*?'https:\/\/valmontelectricals\.com\/api\/valmontpay\/webhook'/);
assert.match(migration, /do NOT delete or rename an existing `valmontweb`/);
assert.doesNotMatch(migration, /\(\s*'valmontweb'\s*,/);
assert.doesNotMatch(migration, /vmw_(secret|pub|webhook)_/);
assert.match(migration, /coalesce\(existing\.webhook_url, excluded\.webhook_url\)/);

console.log('✓ Tenant environment semantics, canonical catalogue identity, and env > DB > default precedence passed');
