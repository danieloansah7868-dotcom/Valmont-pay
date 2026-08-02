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

const expectedWebhook = 'https://valmontelectricals.com/api/valmontpay/webhook';

// Built-ins are production labels and Electricals works out of the box.
let electricals = tenants.getTenant('valmont-electricals');
assert.equal(electricals.environment, 'live');
assert.equal(electricals.webhook_url, expectedWebhook);
assert.equal(electricals.paystack_secret_key, 'sk_live_offline_tenant_test');
assert.equal(tenants.getTenantByIdentifier('Valmont Electricals'), electricals);

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

// The migration both fixes legacy rows and makes clean deploys operational.
const migration = fs.readFileSync(new URL('./supabase-tenants-schema.sql', import.meta.url), 'utf8');
assert.match(migration, /'valmont-electricals'[\s\S]*?'live'[\s\S]*?'https:\/\/valmontelectricals\.com\/api\/valmontpay\/webhook'/);
assert.match(migration, /'valmontweb'[\s\S]*?'live'/);
assert.match(migration, /update public\.tenants[\s\S]*environment = 'live'[\s\S]*valmont-electricals[\s\S]*valmontweb/);
assert.match(migration, /coalesce\(existing\.webhook_url, excluded\.webhook_url\)/);

console.log('✓ Tenant environment semantics and env > DB > default precedence passed');
