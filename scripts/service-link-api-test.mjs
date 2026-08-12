#!/usr/bin/env node

/**
 * HTTP tests for the Valmont Web Services link-minting endpoints in
 * server.js:
 *
 *   GET  /api/v1/payment-link/catalogue  — the public price list
 *   POST /api/v1/payment-link/sku        — anonymous, SKU-only
 *   POST /api/v1/payment-link            — admin-authed, SKU-only
 *   GET  /api/config/pay                 — the legacy-flow posture flag
 *
 * The property under test is the one that matters: an anonymous caller
 * cannot name its own price. It may only say "WEB-LITE-STG1" and the
 * server decides that means GH₵1,400 — and hands back a
 * pay.html?access_code=… link with nothing tamperable in it.
 *
 *   node scripts/service-link-api-test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}
delete process.env.ALLOW_LEGACY_AMOUNT_URL;
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_fake_service_link';
process.env.PORT = '4331';

// Stub Paystack so nothing leaves the machine.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('paystack.co')) {
    const body = JSON.parse(opts.body || '{}');
    return {
      json: async () => ({
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/stub',
          access_code: 'ps_stub_code',
          reference: body.reference
        }
      })
    };
  }
  return realFetch(url, opts);
};

const catalogue = require('../lib/service-catalogue.js');

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${label}`);
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

await import('../server.js');
await new Promise(r => setTimeout(r, 400));
const base = 'http://127.0.0.1:4331';

console.log('\n# Valmont Web Services link minting');

try {
  await check('GET /api/config/pay reports the legacy flow as CLOSED by default', async () => {
    const res = await realFetch(`${base}/api/config/pay`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.allow_legacy_amount_url, false);
  });

  await check('GET /api/v1/payment-link/catalogue publishes all eight SKUs with their prices', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link/catalogue`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.status, true);
    assert.equal(json.data.merchant, 'Valmont Web Services');

    const prices = Object.fromEntries(json.data.items.map(i => [i.sku, i.amount]));
    assert.deepEqual(prices, {
      'WEB-LITE-STG1': 1400,
      'WEB-LITE-FULL': 3500,
      'WEB-STARTER-STG1': 2000,
      'WEB-STARTER-FULL': 5000,
      'WEB-BUSINESS-STG1': 2600,
      'WEB-BUSINESS-FULL': 6500,
      'WEB-EMPIRE-STG1': 3200,
      'WEB-EMPIRE-FULL': 8000
    });
  });

  await check('POST /api/v1/payment-link/sku mints a locked access-code link for WEB-LITE-STG1', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link/sku`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'WEB-LITE-STG1', email: 'client@example.com' })
    });
    const json = await res.json();

    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.status, true);
    assert.equal(json.data.amount, 1400, 'the catalogue price must be used');
    assert.equal(json.data.sku, 'WEB-LITE-STG1');
    assert.ok(json.data.reference.startsWith('WEB-LITE-STG1-'), `unexpected ref ${json.data.reference}`);
    assert.ok(json.data.access_code.startsWith('ac_'), 'an access_code must be minted');

    // The whole point: the link carries a code, not a price.
    assert.ok(json.data.pay_url.includes('/pay.html?access_code='), `unexpected pay_url ${json.data.pay_url}`);
    assert.ok(!json.data.pay_url.includes('amount='), 'the pay_url must NOT contain an amount');
    assert.ok(!json.data.pay_url.includes('1400'), 'the pay_url must not leak the price');
  });

  await check('an anonymous caller CANNOT name its own price — body.amount is ignored', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link/sku`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'WEB-EMPIRE-FULL', email: 'client@example.com', amount: 1 })
    });
    const json = await res.json();

    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.data.amount, 8000, 'the catalogue price must win over the request body');
  });

  await check('the minted access_code resolves to the catalogue amount, not the requested one', async () => {
    const mint = await realFetch(`${base}/api/v1/payment-link/sku`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'WEB-BUSINESS-STG1', email: 'client@example.com', amount: 5 })
    }).then(r => r.json());

    const resolved = await realFetch(
      `${base}/api/transaction/access/${encodeURIComponent(mint.data.access_code)}`
    ).then(r => r.json());

    assert.equal(resolved.status, true);
    assert.equal(resolved.data.amount, 2600, 'the stored intent must hold the catalogue price');
    assert.equal(resolved.data.merchant, 'valmont-web-services');
  });

  await check('an unknown SKU is rejected with the list of valid ones', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link/sku`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'WEB-FREE-PLEASE', email: 'client@example.com', amount: 1 })
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.equal(json.code, 'UNKNOWN_SKU');
    assert.deepEqual(json.data.valid_skus, Object.keys(catalogue.CATALOGUE));
  });

  await check('a mint request without a usable email is rejected', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link/sku`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'WEB-LITE-STG1' })
    });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.code, 'EMAIL_REQUIRED');
  });

  await check('POST /api/v1/payment-link (the dashboard path) mints the same locked link', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'WEB-STARTER-FULL', email: 'ops@valmontpay.app' })
    });
    const json = await res.json();

    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.data.amount, 5000);
    assert.ok(json.data.pay_url.includes('access_code='));
  });

  await check('the SKU endpoints never echo a secret key', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link/sku`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'WEB-LITE-FULL', email: 'client@example.com' })
    });
    const text = await res.text();
    assert.ok(!/sk_(test|live)_/.test(text), 'a Paystack secret key must never appear in the response');
    assert.ok(!/secret/i.test(text), 'nothing secret-shaped may be echoed');
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
