#!/usr/bin/env node

/**
 * Behavioural tests for the retirement of the unsigned amount-in-URL flow.
 *
 * ── What this protects ──────────────────────────────────────────────────
 * A customer must not be able to change what they pay by editing the URL.
 * Before this suite the only guard was `validateAmountUrl`, which catches
 * a pesewas/cedis mix-up (`amount=140000`) but happily accepts a
 * tampered-but-plausible cedis amount — change `1400` to `1` and the
 * gateway charged one cedi.
 *
 * Unlike the sibling suite (pay-html-amount-validation.test.mjs, which
 * greps pay.html for the right wiring), this one EXECUTES pay.html's
 * script against a stub DOM and asserts on what the customer actually
 * sees and what the page actually POSTs.
 *
 * Covered:
 *   1. pay.html?amount=1400&merchant=Valmont+Web+Services renders NO pay
 *      form — it renders the "Payment Link Invalid" card with the agreed
 *      copy, and beacons reason=legacy-unsigned.
 *   2. pay.html?access_code=ac_valid still renders the stored amount.
 *   3. Adding/changing ?amount= on an access-code URL changes nothing:
 *      neither the rendered amount nor the amount that reaches the API.
 *   4. The server (both server.js and api/initialize-payment.js) ignores
 *      body.amount when an access_code is present, and refuses a request
 *      that came from a legacy pay.html URL.
 *   5. The escape hatch (ALLOW_LEGACY_AMOUNT_URL=1) works and is
 *      server-side only — and pay.html fails CLOSED if it can't ask.
 *   6. The Valmont Web Services catalogue prices SKUs server-side and an
 *      anonymous caller cannot name its own price.
 *
 *   node scripts/pay-html-legacy-link-test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadPayHtml } from './lib/pay-html-harness.mjs';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  \u2713 ${label}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  \u2717 ${label}\n`);
    const detail = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err;
    process.stdout.write(`      ${detail}\n`);
  }
}

const LEGACY_COPY = 'This link is missing a locked payment code. Ask the merchant for a new link.';

// ─── Stub server responses ────────────────────────────────────────────

const STORED_INTENT = {
  access_code: 'ac_valid',
  amount: 1400,
  reference: 'WEB-LITE-STG1-TEST',
  currency: 'GHS',
  email: 'client@example.com',
  phone: '',
  callback_url: '',
  merchant: 'valmont-web-services',
  merchant_display_name: 'Valmont Web Services',
  merchant_brand_color: '#f68b1e',
  merchant_logo_url: '/logo.svg',
  paystack_authorization_url: '',
  paystack_access_code: ''
};

/**
 * @param {object} options
 * @param {boolean} [options.allowLegacy]  - what /api/config/pay reports.
 * @param {boolean} [options.configFails]  - make /api/config/pay error.
 */
function makeFetchStub({ allowLegacy = false, configFails = false } = {}) {
  return async (url) => {
    if (url.includes('/api/config/pay')) {
      if (configFails) throw new Error('network down');
      return json({ status: true, data: { allow_legacy_amount_url: allowLegacy } });
    }
    if (url.includes('/api/transaction/access/')) {
      const code = decodeURIComponent(url.split('/api/transaction/access/')[1]);
      if (code !== 'ac_valid') return json({ status: false, message: 'Invalid or expired access code' });
      return json({ status: true, data: STORED_INTENT });
    }
    if (url.includes('/api/tenants/')) {
      return json({ status: true, data: { display_name: 'Valmont Web Services', brand_color: '#f68b1e' } });
    }
    if (url.includes('/api/initialize-payment')) {
      return json({ success: true, accessCode: 'ps_access_code', reference: STORED_INTENT.reference });
    }
    if (url.includes('/api/log/bad-amount')) {
      return json({ success: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

// ─── 1. The legacy link is dead ───────────────────────────────────────

process.stdout.write('\npay.html: unsigned legacy links are rejected\n');

await check('pay.html?amount=1400&merchant=Valmont+Web+Services does NOT render a pay form', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?amount=1400&merchant=Valmont+Web+Services',
    fetch: makeFetchStub()
  });
  await page.load();

  assert.equal(page.showsPayForm, false, 'the payment form must NOT be rendered');
  assert.equal(page.showsError, true, 'the error card must be rendered');
  assert.equal(page.errorTitle, 'Payment Link Invalid');
  assert.equal(page.errorMessage, LEGACY_COPY);
  assert.equal(page.initializeCall, null, 'nothing may be sent to /api/initialize-payment');
});

await check('the tampered link (amount=1) is rejected too — and charges nothing', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?amount=1&merchant=Valmont+Web+Services',
    fetch: makeFetchStub()
  });
  await page.load();

  assert.equal(page.showsPayForm, false);
  assert.equal(page.errorMessage, LEGACY_COPY);
  assert.equal(page.initializeCall, null, 'a rejected link must never initialize a payment');
});

await check('the rejected URL is POSTed to /api/log/bad-amount with reason=legacy-unsigned', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?amount=1400&merchant=Valmont+Web+Services&reference=WEB-LITE-STG1',
    fetch: makeFetchStub()
  });
  await page.load();

  const reports = page.badAmountReports;
  assert.equal(reports.length, 1, `expected exactly one audit beacon, got ${reports.length}`);
  const body = reports[0].body;
  assert.equal(body.reason, 'legacy-unsigned');
  assert.equal(body.rawAmount, '1400');
  assert.equal(body.merchant, 'Valmont Web Services');
  assert.equal(body.ref, 'WEB-LITE-STG1');
  assert.ok(body.url.includes('amount=1400'), 'the full offending URL must be reported');
});

await check('a partial legacy link (?amount= with no merchant) is rejected with the same copy', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?amount=1400',
    fetch: makeFetchStub()
  });
  await page.load();

  assert.equal(page.showsPayForm, false);
  assert.equal(page.errorMessage, LEGACY_COPY);
  assert.equal(page.badAmountReports.length, 1);
  assert.equal(page.badAmountReports[0].body.reason, 'legacy-unsigned');
});

await check('pay.html fails CLOSED when it cannot reach /api/config/pay', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?amount=1400&merchant=Valmont+Web+Services',
    fetch: makeFetchStub({ configFails: true })
  });
  await page.load();

  assert.equal(page.showsPayForm, false, 'an unreachable config endpoint must not re-open the legacy flow');
  assert.equal(page.errorMessage, LEGACY_COPY);
});

await check('the escape hatch (ALLOW_LEGACY_AMOUNT_URL=1) re-opens the legacy flow', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?amount=23.50&merchant=valmont-electricals',
    fetch: makeFetchStub({ allowLegacy: true })
  });
  await page.load();

  assert.equal(page.showsPayForm, true, 'with the flag on, a valid legacy link still renders');
  assert.equal(page.amountDisplayed, 'GH\u20b5 23.50');
});

await check('even with the escape hatch on, the pesewas guard still fires', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?amount=2300&merchant=valmont-electricals',
    fetch: makeFetchStub({ allowLegacy: true })
  });
  await page.load();

  assert.equal(page.showsPayForm, false);
  assert.equal(page.errorTitle, 'Payment Link Unavailable');
  assert.equal(page.badAmountReports[0].body.reason, 'looks-like-pesewas');
});

// ─── 2 & 3. The access-code flow still works, and is untamperable ─────

process.stdout.write('\npay.html: the access-code flow is the only public path\n');

await check('pay.html?access_code=ac_valid renders the stored amount', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?access_code=ac_valid',
    fetch: makeFetchStub()
  });
  await page.load();

  assert.equal(page.showsPayForm, true, 'the payment form must render');
  assert.equal(page.showsError, false);
  assert.equal(page.amountDisplayed, 'GH\u20b5 1400.00', 'the stored GH\u20b51,400 must be displayed');
  assert.equal(page.badAmountReports.length, 0, 'a valid access-code link is not an audit event');
});

await check('an access-code URL never asks /api/config/pay — the legacy gate does not apply', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?access_code=ac_valid',
    fetch: makeFetchStub()
  });
  await page.load();

  assert.ok(
    !page.requests.some(r => r.url.includes('/api/config/pay')),
    'the access-code path must not depend on the legacy flag'
  );
});

await check('changing ?amount= on an access-code URL does not change the displayed amount', async () => {
  const page = loadPayHtml({
    // The customer appended &amount=1 by hand.
    url: 'https://valmontpay.app/pay.html?access_code=ac_valid&amount=1',
    fetch: makeFetchStub()
  });
  await page.load();

  assert.equal(page.showsPayForm, true);
  assert.equal(page.amountDisplayed, 'GH\u20b5 1400.00', 'the URL amount must be ignored entirely');
});

await check('changing ?amount= on an access-code URL does not change the charged amount', async () => {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?access_code=ac_valid&amount=1&merchant=Attacker',
    fetch: makeFetchStub(),
    paystack: class PaystackPop { resumeTransaction() {} }
  });
  await page.load();

  // Fill the form the way a customer would and press Pay.
  page.document.getElementById('customerEmail').value = 'client@example.com';
  page.document.getElementById('customerPhone').value = '0241234567';
  await page.call('payWithValmontPay()');

  const call = page.initializeCall;
  assert.ok(call, 'expected a POST to /api/initialize-payment');
  assert.equal(call.body.amount, 1400, `expected the stored 1400, got ${call.body.amount}`);
  assert.equal(call.body.access_code, 'ac_valid', 'the access_code must be forwarded so the server can re-resolve');
  assert.notEqual(call.body.merchant, 'Attacker', 'the URL merchant must not override the stored one');
});

await check('pay.html never reads the amount back out of the URL when building the API call', async () => {
  const { readFileSync } = await import('node:fs');
  const payHtml = readFileSync(new URL('../pay.html', import.meta.url), 'utf8');
  const payFn = payHtml.slice(payHtml.indexOf('async function payWithValmontPay'));
  const body = payFn.slice(0, payFn.indexOf('openEmbeddedCheckout(accessCode, reference)'));
  assert.ok(
    !/get\(\s*['"]amount['"]\s*\)/.test(body),
    'payWithValmontPay() must not fall back to the URL ?amount= parameter'
  );
});

// ─── 4. Server side: body.amount is not gospel ────────────────────────

process.stdout.write('\nserver: body.amount is never gospel\n');

const legacyPolicy = require('../lib/legacy-link-policy.js');

await check('refererIsLegacyAmountUrl() spots a legacy pay.html referer', () => {
  assert.equal(
    legacyPolicy.refererIsLegacyAmountUrl('https://valmontpay.app/pay.html?amount=1400&merchant=X'),
    true
  );
  assert.equal(legacyPolicy.refererIsLegacyAmountUrl('https://valmontpay.app/pay?amount=1400'), true);
});

await check('an access-code referer is NOT treated as legacy, even with a stray ?amount=', () => {
  assert.equal(
    legacyPolicy.refererIsLegacyAmountUrl('https://valmontpay.app/pay.html?access_code=ac_x&amount=1'),
    false
  );
});

await check('unrelated referers and junk are not treated as legacy', () => {
  assert.equal(legacyPolicy.refererIsLegacyAmountUrl('https://valmontpay.app/checkout.html?amount=5'), false);
  assert.equal(legacyPolicy.refererIsLegacyAmountUrl('https://valmontpay.app/pay.html'), false);
  assert.equal(legacyPolicy.refererIsLegacyAmountUrl('not a url'), false);
  assert.equal(legacyPolicy.refererIsLegacyAmountUrl(''), false);
  assert.equal(legacyPolicy.refererIsLegacyAmountUrl(undefined), false);
});

await check('legacyAmountUrlAllowed() is off by default and only 1/true/yes/on turn it on', () => {
  const original = process.env.ALLOW_LEGACY_AMOUNT_URL;
  try {
    delete process.env.ALLOW_LEGACY_AMOUNT_URL;
    assert.equal(legacyPolicy.legacyAmountUrlAllowed(), false, 'must default to OFF');
    for (const value of ['0', 'false', 'no', '', 'maybe']) {
      process.env.ALLOW_LEGACY_AMOUNT_URL = value;
      assert.equal(legacyPolicy.legacyAmountUrlAllowed(), false, `"${value}" must not enable the legacy flow`);
    }
    for (const value of ['1', 'true', 'YES', 'On']) {
      process.env.ALLOW_LEGACY_AMOUNT_URL = value;
      assert.equal(legacyPolicy.legacyAmountUrlAllowed(), true, `"${value}" should enable the legacy flow`);
    }
  } finally {
    if (original === undefined) delete process.env.ALLOW_LEGACY_AMOUNT_URL;
    else process.env.ALLOW_LEGACY_AMOUNT_URL = original;
  }
});

// The serverless handler, exercised directly with a stubbed Paystack.
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_fake_legacy_suite';
delete process.env.ALLOW_LEGACY_AMOUNT_URL;
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}

const paystackCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('paystack.co')) {
    const body = JSON.parse(opts.body || '{}');
    paystackCalls.push(body);
    return {
      json: async () => ({
        status: true,
        data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'ps_x', reference: body.reference }
      })
    };
  }
  return realFetch(url, opts);
};

const initHandler = (await import('../api/initialize-payment.js')).default;
const accessCodeStore = require('../lib/access-code-store.js');

function mkRes() {
  const r = { _headers: {} };
  r.status = c => { r._code = c; return r; };
  r.json = b => { r._body = b; return r; };
  r.set = (k, v) => { r._headers[k] = v; return r; };
  return r;
}

await check('POST /api/initialize-payment charges the STORED amount, not body.amount', async () => {
  const { access_code } = accessCodeStore.createAccessCode({
    amount: 1400,
    reference: 'WEB-LITE-STG1-SRV',
    currency: 'GHS',
    email: 'client@example.com',
    tenant_key: 'valmont-web-services'
  });

  paystackCalls.length = 0;
  const res = mkRes();
  await initHandler({
    method: 'POST',
    headers: { referer: `https://valmontpay.app/pay.html?access_code=${access_code}&amount=1` },
    body: { email: 'client@example.com', access_code, amount: 1, merchant: 'Attacker', reference: 'ATTACK-1' },
    query: {}
  }, res);

  assert.equal(res._code, 200, `expected 200, got ${res._code}: ${JSON.stringify(res._body)}`);
  assert.equal(paystackCalls.length, 1);
  // Paystack is billed in pesewas: GH₵1,400 → 140000. A charge of 100
  // (GH₵1) here would be the tampering bug.
  assert.equal(paystackCalls[0].amount, 140000, 'Paystack must be billed the stored GH\u20b51,400');
  assert.equal(paystackCalls[0].reference, 'WEB-LITE-STG1-SRV', 'the stored reference wins over the body');
  assert.equal(res._body.amount, 1400);
});

await check('POST /api/initialize-payment 404s an unknown/expired access_code instead of trusting body.amount', async () => {
  paystackCalls.length = 0;
  const res = mkRes();
  await initHandler({
    method: 'POST',
    headers: {},
    body: { email: 'a@b.com', access_code: 'ac_does_not_exist', amount: 1 },
    query: {}
  }, res);

  assert.equal(res._code, 404);
  assert.equal(res._body.code, 'ACCESS_CODE_INVALID');
  assert.equal(paystackCalls.length, 0, 'nothing may reach Paystack');
});

await check('POST /api/initialize-payment refuses a request from a legacy pay.html URL', async () => {
  paystackCalls.length = 0;
  const res = mkRes();
  await initHandler({
    method: 'POST',
    headers: { referer: 'https://valmontpay.app/pay.html?amount=1&merchant=Valmont+Web+Services' },
    body: { email: 'a@b.com', amount: 1, merchant: 'Valmont Web Services', reference: 'LEGACY-1' },
    query: {}
  }, res);

  assert.equal(res._code, 403, `expected 403, got ${res._code}`);
  assert.equal(res._body.code, 'LEGACY_URL_RETIRED');
  assert.equal(res._body.error, LEGACY_COPY);
  assert.equal(paystackCalls.length, 0, 'a retired legacy request must never reach Paystack');
});

await check('a normal server-to-server call (no legacy referer) still works', async () => {
  paystackCalls.length = 0;
  const res = mkRes();
  await initHandler({
    method: 'POST',
    headers: {},
    body: { email: 'a@b.com', amount: 23.5, merchant: 'valmont-electricals', reference: 'S2S-1' },
    query: {}
  }, res);

  assert.equal(res._code, 200, `expected 200, got ${res._code}: ${JSON.stringify(res._body)}`);
  assert.equal(paystackCalls[0].amount, 2350);
});

await check('the escape hatch also re-opens the server-side legacy path', async () => {
  process.env.ALLOW_LEGACY_AMOUNT_URL = '1';
  try {
    paystackCalls.length = 0;
    const res = mkRes();
    await initHandler({
      method: 'POST',
      headers: { referer: 'https://valmontpay.app/pay.html?amount=23.50&merchant=valmont-electricals' },
      body: { email: 'a@b.com', amount: 23.5, merchant: 'valmont-electricals', reference: 'LEGACY-OK' },
      query: {}
    }, res);
    assert.equal(res._code, 200, `expected 200 with the flag on, got ${res._code}`);
    assert.equal(paystackCalls[0].amount, 2350);
  } finally {
    delete process.env.ALLOW_LEGACY_AMOUNT_URL;
  }
});

// ─── 5. The Valmont Web Services catalogue ────────────────────────────

process.stdout.write('\ncatalogue: prices live on the server\n');

const catalogue = require('../lib/service-catalogue.js');

await check('every published SKU has the agreed cedis price', () => {
  const expected = {
    'WEB-LITE-STG1': 1400,
    'WEB-LITE-FULL': 3500,
    'WEB-STARTER-STG1': 2000,
    'WEB-STARTER-FULL': 5000,
    'WEB-BUSINESS-STG1': 2600,
    'WEB-BUSINESS-FULL': 6500,
    'WEB-EMPIRE-STG1': 3200,
    'WEB-EMPIRE-FULL': 8000
  };
  for (const [sku, amount] of Object.entries(expected)) {
    const item = catalogue.lookupSku(sku);
    assert.ok(item, `expected ${sku} in the catalogue`);
    assert.equal(item.amount, amount, `${sku} must be GH\u20b5${amount}`);
    assert.equal(item.merchant, 'Valmont Web Services');
    assert.equal(item.currency, 'GHS');
  }
  assert.equal(catalogue.listCatalogue().length, Object.keys(expected).length, 'no extra SKUs');
});

await check('an unknown SKU is refused, never priced by the caller', () => {
  assert.equal(catalogue.lookupSku('WEB-FREE-STG1'), null);
  assert.equal(catalogue.lookupSku(''), null);
  assert.equal(catalogue.lookupSku(null), null);
  assert.equal(catalogue.lookupSku('../../etc/passwd'), null);
  assert.equal(catalogue.isValidSku('WEB-LITE-STG1'), true);
  assert.equal(catalogue.isValidSku('web-lite-stg1'), true, 'SKUs are case-insensitive');
});

await check('references built from a SKU keep the SKU as their prefix', () => {
  const ref = catalogue.buildReference('WEB-EMPIRE-FULL');
  assert.ok(ref.startsWith('WEB-EMPIRE-FULL-'), `unexpected reference: ${ref}`);
  assert.equal(catalogue.referenceSku(ref), 'WEB-EMPIRE-FULL');
  assert.equal(catalogue.referenceSku('WEB-LITE-STG1'), 'WEB-LITE-STG1');
  assert.equal(catalogue.referenceSku('SOMETHING-ELSE'), null);
});

await check('a SKU price can be overridden by the operator, but never by a request', () => {
  process.env.SERVICE_PRICE__WEB_LITE_STG1 = '1500';
  try {
    assert.equal(catalogue.lookupSku('WEB-LITE-STG1').amount, 1500);
  } finally {
    delete process.env.SERVICE_PRICE__WEB_LITE_STG1;
  }
  assert.equal(catalogue.lookupSku('WEB-LITE-STG1').amount, 1400, 'back to the catalogue price');
});

// ─── Summary ──────────────────────────────────────────────────────────

globalThis.fetch = realFetch;
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
