#!/usr/bin/env node
// A popup callback is not a server-verified receipt. No real charges or network.
import assert from 'node:assert/strict';
import { loadPayHtml } from './lib/pay-html-harness.mjs';

const reference = 'VP-VERIFY-TEST';
const payment = { amount: 50, reference, merchant: 'own-account-shop', email: 'buyer@example.com' };
const verified = { status: true, success: true, summary: { reference, status: 'success' } };

async function openPage(response, callback = false) {
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?access_code=ac_verify_test',
    fetch: async url => {
      if (url.includes('/api/transaction/access/')) return { ok: true, json: async () => ({ status: true, data: {
        ...payment, ...(callback ? { callback_url: 'https://shop.example/receipt' } : {})
      } }) };
      if (url.startsWith('/api/verify-payment?')) return response(url);
      throw new Error(`Unexpected request: ${url}`);
    }
  });
  await page.load();
  return page;
}

const outcomes = [
  ['failed', { status: true, success: false, summary: { reference, status: 'failed' } }],
  ['pending', { status: true, summary: { reference, status: 'pending' } }],
  ['abandoned', { status: true, summary: { reference, status: 'abandoned' } }],
  ['lookup-success-only', { status: true }],
  ['wrong-reference', { status: true, summary: { reference: 'OTHER', status: 'success' } }],
  ['provider-error', { status: false, summary: { reference, status: 'success' } }],
  ['empty', null]
];
for (const callback of [false, true]) {
  for (const [name, body] of outcomes) {
    const page = await openPage(async () => ({ ok: true, json: async () => body }), callback);
    await page.call(`confirmPaymentOnPage('${reference}')`);
    assert.equal(page.document.getElementById('successState').visible, false, name);
    assert.equal(page.document.getElementById('verificationState').visible, true, name);
    assert.equal(page.document.getElementById('paymentCard').visible, false, 'do not invite another charge');
    assert.equal(page.document.getElementById('btnRetryVerification').disabled, false);
    assert.equal(page.context.location.href.includes('shop.example'), false, 'no success callback before verification');
  }
}

for (const failure of ['http500', 'network', 'invalid-json', 'timeout']) {
  const page = await openPage(async () => {
    if (failure === 'network' || failure === 'timeout') throw new Error(failure);
    return { ok: failure !== 'http500', json: async () => { throw new Error('bad JSON'); } };
  });
  await page.call(`confirmPaymentOnPage('${reference}')`);
  assert.equal(page.document.getElementById('successState').visible, false, failure);
  assert.match(page.document.getElementById('verificationMessage').textContent, /could not confirm/i);
}

for (const body of [verified, { status: true, data: { reference, status: 'success' } }]) {
  for (const callback of [false, true]) {
    let confirmed = false;
    const page = await openPage(async url => {
      const params = new URL(url, 'https://valmontpay.app').searchParams;
      assert.equal(params.get('reference'), reference);
      assert.equal(params.get('merchant'), 'own-account-shop', 'verification routes to the charging merchant');
      return { ok: true, json: async () => confirmed ? body : outcomes[1][1] };
    }, callback);
    await page.call(`confirmPaymentOnPage('${reference}')`);
    assert.equal(page.document.getElementById('successState').visible, false);
    confirmed = true;
    await page.call('retryPaymentVerification()');
    assert.equal(page.initializeCall, null, 'checking status must never initiate a payment');
    assert.equal(page.document.getElementById('verificationState').visible, false);
    if (callback) {
      const target = new URL(page.context.location.href);
      assert.equal(target.origin, 'https://shop.example');
      assert.equal(target.searchParams.get('status'), 'success');
      assert.equal(target.searchParams.get('reference'), reference);
    } else {
      assert.equal(page.document.getElementById('successState').visible, true);
      assert.equal(page.document.getElementById('successRef').textContent, reference);
    }
  }
}

// Concurrent taps on Check status must not duplicate requests.
let release;
let requests = 0;
const page = await openPage(async () => {
  requests++;
  await new Promise(resolve => { release = resolve; });
  return { ok: true, json: async () => verified };
});
const first = page.call(`confirmPaymentOnPage('${reference}')`);
await page.call(`confirmPaymentOnPage('${reference}')`);
assert.equal(requests, 1);
release();
await first;
console.log('PASS - verification: pending, failure, outage, mismatched reference, retry, merchant routing, callback and duplicate-tap safety');
