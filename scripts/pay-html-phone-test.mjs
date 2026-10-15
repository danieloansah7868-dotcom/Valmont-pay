#!/usr/bin/env node
// The method is selected in Paystack, so a Ghanaian number must not gate checkout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPayHtml, PAY_HTML_PATH } from './lib/pay-html-harness.mjs';

const html = readFileSync(PAY_HTML_PATH, 'utf8');
const phoneTag = html.match(/<input\b[^>]*id="customerPhone"[^>]*>/)[0];
assert.doesNotMatch(phoneTag, /\srequired\b|aria-required="true"/);
assert.match(html, /Paying by card\? Leave this blank/);

async function openPage({ phone = '', resumed = false } = {}) {
  const opened = [];
  const page = loadPayHtml({
    url: 'https://valmontpay.app/pay.html?access_code=ac_phone_test',
    paystack: class {
      resumeTransaction(code) { opened.push(code); }
    },
    fetch: async url => {
      if (url.includes('/api/transaction/access/')) {
        return { ok: true, json: async () => ({ status: true, data: {
          amount: 100, reference: 'VP-PHONE-TEST', merchant: 'test',
          email: 'buyer@example.com', phone,
          ...(resumed ? { paystack_access_code: 'ac_existing' } : {})
        } }) };
      }
      if (url === '/api/initialize-payment') {
        return { ok: true, json: async () => ({ status: true, accessCode: 'ac_new' }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });
  await page.load();
  return { page, opened };
}

for (const resumed of [false, true]) {
  for (const phone of ['', '   ', '0241234567', '+233 24 123 4567']) {
    const { page, opened } = await openPage({ phone, resumed });
    await page.call('payWithValmontPay()');
    assert.equal(opened.length, 1, `checkout opens for ${JSON.stringify(phone)}, resumed=${resumed}`);
    assert.equal(page.document.getElementById('phoneError').hidden, true);
    if (resumed) {
      assert.equal(page.initializeCall, null, 'reuse the existing gateway code');
    } else {
      assert.equal(page.initializeCall.body.phone, phone.trim() || undefined);
      assert.equal(page.initializeCall.body.access_code, 'ac_phone_test');
    }
  }
}

// Invalid optional MoMo input remains actionable; clearing it permits card checkout.
for (const phone of ['123', '+1 202 555 0123']) {
  const { page, opened } = await openPage({ phone });
  await page.call('payWithValmontPay()');
  assert.equal(opened.length, 0);
  assert.equal(page.initializeCall, null);
  assert.equal(page.document.getElementById('phoneError').visible, true);
  assert.equal(page.document.getElementById('customerPhone').focused, true);
  page.document.getElementById('customerPhone').value = '';
  await page.call('payWithValmontPay()');
  assert.equal(opened.length, 1);
  assert.equal(page.document.getElementById('phoneError').hidden, true);
  assert.equal(page.document.getElementById('customerPhone').classList.contains('border-red-400'), false);
}

const { page, opened } = await openPage();
page.document.getElementById('customerEmail').value = '';
await page.call('payWithValmontPay()');
assert.equal(opened.length, 0, 'email is still required');
assert.equal(page.initializeCall, null);
console.log('PASS - optional MoMo phone: new/resumed checkout, validation, recovery, and required email');
