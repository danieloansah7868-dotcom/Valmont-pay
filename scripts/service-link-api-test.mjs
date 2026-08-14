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
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}
delete process.env.ALLOW_LEGACY_AMOUNT_URL;
// The isolated HTTP suite exercises the dashboard endpoint directly; avoid
// inheriting a deployment-only admin password from the test runner.
delete process.env.ADMIN_PASSWORD;
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
const accessCodeStore = require('../lib/access-code-store.js');

const EXPECTED_SKU_PRICES = {
  'WEB-LITE-STG1': 1400,
  'WEB-LITE-FULL': 3500,
  'WEB-STARTER-STG1': 2000,
  'WEB-STARTER-FULL': 5000,
  'WEB-BUSINESS-STG1': 2600,
  'WEB-BUSINESS-FULL': 6500,
  'WEB-EMPIRE-STG1': 3200,
  'WEB-EMPIRE-FULL': 8000
};

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

  await check('tenant reads resolve valmontweb to one canonical public identity', async () => {
    const list = await realFetch(`${base}/api/tenants`).then(r => r.json());
    const catalogueTenants = list.data.filter(tenant =>
      tenant.key === catalogue.SERVICE_MERCHANT_KEY || tenant.display_name === catalogue.SERVICE_MERCHANT_NAME
    );
    assert.equal(catalogueTenants.length, 1, 'only one Valmont Web Services tenant is listed');
    assert.equal(list.data.some(tenant => tenant.key === 'valmontweb'), false, 'legacy key is not listed as a second tenant');

    const legacyLookup = await realFetch(`${base}/api/tenants/valmontweb`);
    const legacyJson = await legacyLookup.json();
    assert.equal(legacyLookup.status, 200);
    assert.equal(legacyJson.data.key, catalogue.SERVICE_MERCHANT_KEY);
    assert.equal(legacyJson.data.display_name, catalogue.SERVICE_MERCHANT_NAME);
  });

  await check('admin tenant creation rejects a third Valmont Web Services identity', async () => {
    const res = await realFetch(`${base}/api/admin/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'valmont-web-services-copy', display_name: 'Valmont Web Services' })
    });
    const json = await res.json();
    assert.equal(res.status, 409);
    assert.equal(json.code, 'CATALOGUE_MERCHANT_RESERVED');
  });

  await check('GET /api/v1/payment-link/catalogue publishes all eight SKUs with their prices', async () => {
    const res = await realFetch(`${base}/api/v1/payment-link/catalogue`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.status, true);
    assert.equal(json.data.merchant, 'Valmont Web Services');
    assert.equal(json.data.merchant_key, catalogue.SERVICE_MERCHANT_KEY);

    const prices = Object.fromEntries(json.data.items.map(i => [i.sku, i.amount]));
    assert.deepEqual(prices, EXPECTED_SKU_PRICES);
    // A catalogue can never silently acquire a second merchant identity.
    assert.deepEqual([...new Set(json.data.items.map(i => i.merchant_key))], [catalogue.SERVICE_MERCHANT_KEY]);
    assert.deepEqual([...new Set(json.data.items.map(i => i.merchant))], [catalogue.SERVICE_MERCHANT_NAME]);
  });

  await check('POST /api/v1/payment-link/sku mints locked links at the catalogue price for all eight SKUs', async () => {
    for (const [sku, amount] of Object.entries(EXPECTED_SKU_PRICES)) {
      const res = await realFetch(`${base}/api/v1/payment-link/sku`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, email: 'all-skus@example.com', amount: 1 })
      });
      const json = await res.json();
      assert.equal(res.status, 200, `${sku}: ${JSON.stringify(json)}`);
      assert.equal(json.status, true, `${sku} should mint`);
      assert.equal(json.data.amount, amount, `${sku} price is server-owned`);
      assert.equal(json.data.merchant_key, catalogue.SERVICE_MERCHANT_KEY, `${sku} uses canonical merchant key`);
      assert.ok(json.data.pay_url.includes('/pay.html?access_code='), `${sku} returns a locked pay URL`);
      assert.ok(!/[?&]amount=/.test(json.data.pay_url), `${sku} URL contains no editable amount`);

      const resolved = await realFetch(
        `${base}/api/transaction/access/${encodeURIComponent(json.data.access_code)}`
      ).then(r => r.json());
      assert.equal(resolved.status, true, `${sku} access code resolves`);
      assert.equal(resolved.data.amount, amount, `${sku} stored amount stays locked`);
      assert.equal(resolved.data.merchant, catalogue.SERVICE_MERCHANT_KEY, `${sku} resolves to canonical merchant`);
    }
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

  await check('a locked legacy valmontweb access code stays payable under the canonical identity', async () => {
    const legacy = accessCodeStore.createAccessCode({
      amount: 1400,
      reference: 'LEGACY-VALMONTWEB-LINK',
      currency: 'GHS',
      email: 'legacy-client@example.com',
      tenant_key: 'valmontweb',
      merchant_display_name: 'Valmont Web',
      merchant_brand_color: '#2563eb',
      merchant_logo_url: '/logo.svg'
    });

    const res = await realFetch(
      `${base}/api/transaction/access/${encodeURIComponent(legacy.access_code)}`
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.status, true);
    assert.equal(json.data.amount, 1400, 'the historical locked amount is unchanged');
    assert.equal(json.data.reference, 'LEGACY-VALMONTWEB-LINK', 'the historical reference is unchanged');
    assert.equal(json.data.merchant, catalogue.SERVICE_MERCHANT_KEY, 'old key resolves to canonical merchant');
    assert.equal(json.data.merchant_display_name, catalogue.SERVICE_MERCHANT_NAME, 'old branding is not republished');

    // The payment initializer must still honour the historical lock. A caller
    // cannot substitute amount=1 while the old key is canonicalised for
    // Paystack metadata/routing.
    const initialize = await realFetch(`${base}/api/initialize-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_code: legacy.access_code,
        amount: 1,
        email: 'legacy-client@example.com',
        merchant: 'valmontweb'
      })
    });
    const initialized = await initialize.json();
    assert.equal(initialize.status, 200);
    assert.equal(initialized.success, true);
    assert.equal(initialized.amount, 1400, 'payment initialization keeps the historical locked amount');
    assert.equal(initialized.reference, 'LEGACY-VALMONTWEB-LINK');
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
    assert.equal(json.data.merchant_key, catalogue.SERVICE_MERCHANT_KEY);
    assert.ok(json.data.pay_url.includes('access_code='));
    assert.ok(!/[?&]amount=/.test(json.data.pay_url));
  });

  await check('the dashboard Stage 1 / Full Link panel stays wired to the admin SKU endpoint', async () => {
    const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
    assert.match(dashboard, /Valmont Web Services — Issue Stage 1 \/ Full Link/);
    // adminFetch() is the session-aware fetch wrapper (sends the httpOnly
    // admin cookie, redirects to login on 401). Either spelling is fine —
    // what matters is that the panel calls the ADMIN endpoint.
    assert.match(dashboard, /(?:admin)?[Ff]etch\('\/api\/v1\/payment-link'/);
    assert.match(dashboard, /body: JSON\.stringify\(\{ sku, email \}\)/);
    assert.doesNotMatch(dashboard, /body: JSON\.stringify\(\{ sku, email, amount/);
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
