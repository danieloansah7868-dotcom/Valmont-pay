#!/usr/bin/env node

/**
 * Integration test for the Standing Mandates / Recurring Billing HTTP API
 * in server.js (/api/v1/mandates, /api/v1/mandates/:code,
 * /api/v1/mandates/charge, /api/v1/mandates/revoke).
 *
 *   node scripts/mandate-api-test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_fake_mandate_api_key';
process.env.PORT = '4330';
// Exercise the REAL authorization path: with ADMIN_PASSWORD set the mandate
// API is enforced, so these tests now prove that a legitimate, authenticated
// operator can still use it (scripts/security.test.mjs proves the anonymous
// caller cannot). Without this, the suite would pass merely because the
// local-dev posture leaves the endpoints open.
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mandate-api-test-admin-key';

// Mock Paystack charge authorization endpoint
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/transaction/charge_authorization')) {
    const body = JSON.parse(opts.body || '{}');
    return {
      json: async () => ({
        status: true,
        message: 'Charge attempted',
        data: {
          status: 'success',
          reference: body.reference || 'VP-API-MANDATE-CHARGED',
          amount: body.amount
        }
      })
    };
  }
  return origFetch(url, opts);
};

const mandateStore = require('../lib/mandate-store.js');

let passed = 0;
function pass(message) {
  passed += 1;
  console.log(`  ✓ ${message}`);
}

console.log('\n# server.js Mandate API (/api/v1/mandates)');

// Seed a test mandate
await mandateStore.saveMandate({
  authorization_code: 'AUTH_API_MTN_001',
  reference: 'VP-INITIAL-REF-1',
  customer_email: 'api_customer@example.com',
  merchant_name: 'Valmont Electricals',
  payment_method: 'Momo (MTN)',
  bank: 'MTN',
  amount: 45,
  status: 'ACTIVE'
});

await import('../server.js');
await new Promise(r => setTimeout(r, 400));
const baseUrl = 'http://127.0.0.1:4330';
const ADMIN_HEADERS = { 'X-Admin-Key': process.env.ADMIN_PASSWORD };

try {
  // 1. GET /api/v1/mandates
  const listRes = await fetch(`${baseUrl}/api/v1/mandates?merchant=Valmont%20Electricals`, { headers: ADMIN_HEADERS });
  const listData = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(listData.status, true);
  assert.ok(listData.count >= 1);
  assert.equal(listData.data[0].authorization_code, 'AUTH_API_MTN_001');
  pass('GET /api/v1/mandates lists active standing mandates');

  // 2. GET /api/v1/mandates/:code
  const getRes = await fetch(`${baseUrl}/api/v1/mandates/AUTH_API_MTN_001`, { headers: ADMIN_HEADERS });
  const getData = await getRes.json();
  assert.equal(getRes.status, 200);
  assert.equal(getData.status, true);
  assert.equal(getData.data.customer_email, 'api_customer@example.com');
  pass('GET /api/v1/mandates/:code returns mandate details');

  // 3. POST /api/v1/mandates/charge
  const chargeRes = await fetch(`${baseUrl}/api/v1/mandates/charge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS },
    body: JSON.stringify({
      authorization_code: 'AUTH_API_MTN_001',
      amount: 45,
      reference: 'VP-MANDATE-RECURRING-001'
    })
  });
  const chargeData = await chargeRes.json();
  assert.equal(chargeRes.status, 200);
  assert.equal(chargeData.status, true);
  assert.equal(chargeData.data.reference, 'VP-MANDATE-RECURRING-001');
  assert.equal(chargeData.data.status, 'SUCCESS');
  pass('POST /api/v1/mandates/charge executes recurring charge and records transaction');

  // 4. POST /api/v1/mandates/revoke
  const revokeRes = await fetch(`${baseUrl}/api/v1/mandates/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS },
    body: JSON.stringify({ authorization_code: 'AUTH_API_MTN_001' })
  });
  const revokeData = await revokeRes.json();
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeData.status, true);
  assert.equal(revokeData.data.status, 'REVOKED');
  pass('POST /api/v1/mandates/revoke marks mandate as REVOKED');

  // 5. Attempting to charge a REVOKED mandate returns 400
  const failChargeRes = await fetch(`${baseUrl}/api/v1/mandates/charge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS },
    body: JSON.stringify({
      authorization_code: 'AUTH_API_MTN_001',
      amount: 45
    })
  });
  const failChargeData = await failChargeRes.json();
  assert.equal(failChargeRes.status, 400);
  assert.equal(failChargeData.status, false);
  assert.match(failChargeData.message, /REVOKED/);
  pass('POST /api/v1/mandates/charge rejects charging a REVOKED mandate (Act 987 opt-out compliance)');

} finally {
  globalThis.fetch = origFetch;
  console.log(`\n✓ server.js Mandate API: all ${passed} tests passed.\n`);
  process.exit(passed === 5 ? 0 : 1);
}

