#!/usr/bin/env node
// Exercise the deployed /api handlers, not just the Express counterparts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) delete process.env[name];
process.env.PAYSTACK_SECRET_KEY = 'sk_test_gateway';
process.env.TENANTS_JSON = JSON.stringify([
  { key: 'own-shop', display_name: 'Own Shop', paystack_secret_key: 'sk_test_shop' },
  { key: 'shared-shop', display_name: 'Shared Shop' }
]);
const tenants = require('../lib/tenants.js');
const accessStore = require('../lib/access-code-store.js');
const ledger = require('../lib/ledger.js');
const init = (await import('../api/initialize-payment.js')).default;
const verify = (await import('../api/verify-payment.js')).default;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  assert.ok(String(url).startsWith('https://api.paystack.co/transaction/'), 'only stubbed Paystack calls');
  calls.push({ url, options });
  return { json: async () => ({ status: true, data: String(url).includes('/initialize')
    ? { access_code: 'gateway-code', reference: JSON.parse(options.body).reference, authorization_url: 'https://checkout.paystack.com/test' }
    : { reference: decodeURIComponent(String(url).split('/').at(-1)), status: 'success', amount: 5000, currency: 'GHS', metadata: {}, customer: {} }
  }) };
};
function response() {
  return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };
}
for (const [merchant, expected] of [['own-shop', 'sk_test_shop'], ['Own Shop', 'sk_test_shop'], ['shared-shop', 'sk_test_gateway'], ['unknown', 'sk_test_gateway']]) {
  const res = response();
  await init({ method: 'POST', body: { merchant, reference: 'VP-ROUTING', amount: 50, email: 'buyer@example.com' } }, res);
  assert.equal(res.code, 200);
  assert.equal(calls.at(-1).options.headers.Authorization, `Bearer ${expected}`);
  await verify({ method: 'GET', query: { reference: 'VP-ROUTING', merchant } }, response());
  assert.equal(calls.at(-1).options.headers.Authorization, `Bearer ${expected}`);
  assert.ok(!JSON.stringify(res.body).includes('sk_test_'), 'secret stays server-side');
}

// Locked links override spoofed merchant/amount in the browser request.
const { access_code } = accessStore.createAccessCode({ reference: 'VP-LOCKED', amount: 50, tenant_key: 'own-shop' });
const res = response();
await init({ method: 'POST', body: { access_code, merchant: 'shared-shop', reference: 'SPOOFED', amount: 1, email: 'buyer@example.com' } }, res);
assert.equal(res.code, 200);
assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sk_test_shop');
assert.equal(JSON.parse(calls.at(-1).options.body).reference, 'VP-LOCKED');
assert.equal(JSON.parse(calls.at(-1).options.body).amount, 5000);

// Verification without a merchant keeps the known-ledger fallback.
ledger.upsertTransaction({ reference: 'VP-KNOWN', merchant: 'own-shop', amount: 50, status: 'PENDING' });
await verify({ method: 'GET', query: { reference: 'VP-KNOWN' } }, response());
assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sk_test_shop');

// DB-only tenants are loaded on a cold serverless invocation before selecting a key.
const originalRefresh = tenants.refreshFromDb;
let refreshed = 0;
tenants.refreshFromDb = async () => {
  refreshed++;
  tenants.registry.set('db-only-shop', { key: 'db-only-shop', paystack_secret_key: 'sk_test_db_shop' });
};
await init({ method: 'POST', body: { merchant: 'db-only-shop', reference: 'VP-DB', amount: 50, email: 'buyer@example.com' } }, response());
assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sk_test_db_shop');
await verify({ method: 'GET', query: { reference: 'VP-DB', merchant: 'db-only-shop' } }, response());
assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer sk_test_db_shop');
assert.equal(refreshed, 2);
tenants.refreshFromDb = originalRefresh;
console.log('PASS - serverless initialize/verify route merchant, locked link, ledger and DB-only credentials consistently');
