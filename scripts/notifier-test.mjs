#!/usr/bin/env node

/**
 * Offline integration test for lib/notifier.js — the SMS/WhatsApp receipt bot.
 * Stubs global fetch and env vars, so no provider credentials or network are
 * needed. Verifies contact extraction, receipt formatting, per-channel
 * dispatch, duplicate suppression and the "never throws" guarantee.
 *
 *   node scripts/notifier-test.mjs
 */

import assert from 'node:assert/strict';

const notifier = (await import('../lib/notifier.js')).default;
const {
  sendOrderReceiptNotification,
  extractCustomerPhone,
  formatReceiptMessage,
  normalizeGhanaPhone,
  notificationConfigState
} = notifier;

// ─── Env + network stubs ────────────────────────────────────────────────────

const NOTIFIER_ENV_VARS = [
  'WHATSAPP_WEBHOOK_URL',
  'SMS_WEBHOOK_URL',
  'ARKESEL_API_KEY',
  'ARKESEL_SENDER_ID',
  'MNOTIFY_API_KEY',
  'MNOTIFY_SENDER_ID',
  'MERCHANT_NOTIFICATION_PHONE',
  'ADMIN_NOTIFICATION_PHONE',
  'MERCHANT_NOTIFICATION_EMAIL',
  'ADMIN_NOTIFICATION_EMAIL',
  'ADMIN_EMAIL'
];

function clearNotifierEnv() {
  for (const key of NOTIFIER_ENV_VARS) delete process.env[key];
}

const outbound = [];
let fetchBehavior = async () => ({
  ok: true,
  status: 200,
  text: async () => '{"status":"success"}'
});

globalThis.fetch = async (url, opts = {}) => {
  outbound.push({ url: String(url), opts });
  return fetchBehavior(url, opts);
};

function resetOutbound(behavior) {
  outbound.length = 0;
  fetchBehavior =
    behavior ||
    (async () => ({
      ok: true,
      status: 200,
      text: async () => '{"status":"success"}'
    }));
}

function samplePayload(reference) {
  return {
    event: 'charge.success',
    data: {
      reference,
      amount: 5000, // pesewas
      channel: 'mobile_money',
      status: 'success',
      paid_at: '2026-07-31T12:00:00Z',
      customer: { email: 'ada@example.com', phone: '0555000111' },
      authorization: { bank: 'MTN' },
      metadata: {
        merchant: 'Valmont Electricals',
        momo_number: '0544 00 22 33',
        custom_fields: [
          { display_name: 'Merchant', variable_name: 'merchant', value: 'Valmont Electricals' },
          { display_name: 'Mobile Money Number', variable_name: 'momo_number', value: '0244 99 88 77' }
        ]
      }
    }
  };
}

function sampleTrx(reference) {
  // The transaction row shape api/webhook.js persists.
  return {
    reference,
    merchant_name: 'Valmont Electricals',
    customer_email: 'ada@example.com',
    amount: 50,
    payment_method: 'Mobile Money (MTN)',
    status: 'SUCCESS',
    paid_at: '2026-07-31T12:00:00Z'
  };
}

let passed = 0;
async function test(name, fn) {
  clearNotifierEnv();
  resetOutbound();
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('[notifier-test] running…\n');

// ─── Pure helpers ───────────────────────────────────────────────────────────

await test('extractCustomerPhone prefers metadata.momo_number', () => {
  assert.equal(extractCustomerPhone(sampleTrx('R1'), samplePayload('R1')), '0544 00 22 33');
});

await test('extractCustomerPhone falls back through custom_fields, customer.phone and trx', () => {
  const payload = samplePayload('R2');
  delete payload.data.metadata.momo_number;
  assert.equal(extractCustomerPhone(sampleTrx('R2'), payload), '0244 99 88 77');

  const payload2 = samplePayload('R3');
  delete payload2.data.metadata.momo_number;
  payload2.data.metadata.custom_fields = [
    { display_name: 'MoMo', variable_name: 'momo_phone', value: '0201 23 45 67' }
  ];
  assert.equal(extractCustomerPhone(sampleTrx('R3'), payload2), '0201 23 45 67');

  const payload3 = samplePayload('R4');
  payload3.data.metadata = {};
  assert.equal(extractCustomerPhone(sampleTrx('R4'), payload3), '0555000111');

  assert.equal(extractCustomerPhone({ customer_phone: '0277 66 55 44' }, { data: {} }), '0277 66 55 44');
  assert.equal(extractCustomerPhone({}, { data: {} }), null);
});

await test('receipt message matches the Ghanaian receipt format', () => {
  const message = formatReceiptMessage(sampleTrx('VP-ABC123'), samplePayload('VP-ABC123'));
  assert.ok(message.startsWith('*VALMONT-PAY INSTANT RECEIPT* 🔒'), 'receipt header');
  assert.ok(message.includes('Ref: #VP-ABC123'), 'reference line');
  assert.ok(message.includes('Merchant: Valmont Electricals'), 'merchant line');
  assert.ok(message.includes('Amount Paid: GH₵ 50.00'), 'amount line in GH₵ major units');
  assert.ok(message.includes('Payment Method: Mobile Money (MTN)'), 'channel line');
  assert.ok(message.includes('Status: PAID ✅'), 'status line');
  assert.ok(message.includes('Paid at:'), 'paid at line');
  assert.ok(message.trim().endsWith('Thank you for your payment!'), 'thank-you line');
});

await test('receipt falls back to pesewas conversion and ledger field names', () => {
  // The lib/webhook.js ledger record shape (merchant/channel/timestamp).
  const trx = { reference: 'VP-9', merchant: 'Valmont Web Services', channel: 'card', status: 'SUCCESS', timestamp: '' };
  const message = formatReceiptMessage(trx, samplePayload('VP-9'));
  assert.ok(message.includes('Merchant: Valmont Web Services'), 'ledger merchant name used');
  assert.ok(message.includes('Amount Paid: GH₵ 50.00'), 'pesewas converted when trx.amount missing');
  assert.ok(message.includes('Payment Method: card'));
});

await test('normalizeGhanaPhone handles local and international formats', () => {
  assert.equal(normalizeGhanaPhone('0544000000'), '233544000000');
  assert.equal(normalizeGhanaPhone('+233 54 400 0000'), '233544000000');
  assert.equal(normalizeGhanaPhone('233 54 400 0000'), '233544000000');
  assert.equal(normalizeGhanaPhone('544 000 000'), '233544000000');
  assert.equal(normalizeGhanaPhone('00233-54-400-0000'), '233544000000');
  assert.equal(normalizeGhanaPhone('abc'), null);
  assert.equal(normalizeGhanaPhone(''), null);
  assert.equal(normalizeGhanaPhone(null), null);
});

// ─── Dispatch behaviour ─────────────────────────────────────────────────────

await test('no providers configured → log-only, no network, still ok', async () => {
  const result = await sendOrderReceiptNotification(sampleTrx('NP-1'), samplePayload('NP-1'));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no-provider-configured');
  assert.equal(outbound.length, 0, 'no HTTP calls without providers');
});

await test('WHATSAPP_WEBHOOK_URL receives the spec payload for customer AND merchant', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  process.env.MERCHANT_NOTIFICATION_PHONE = '0501112223';

  const result = await sendOrderReceiptNotification(sampleTrx('WA-1'), samplePayload('WA-1'));

  assert.equal(result.ok, true);
  assert.equal(result.delivered, 2, 'customer + merchant deliveries');
  assert.equal(outbound.length, 2);

  const [customerCall, merchantCall] = outbound;
  assert.equal(customerCall.url, 'https://wa.example.test/send');
  assert.equal(customerCall.opts.method, 'POST');

  const customerBody = JSON.parse(customerCall.opts.body);
  // Exact spec payload shape: { phone, message, reference } — nothing else.
  assert.deepEqual(Object.keys(customerBody).sort(), ['message', 'phone', 'reference']);
  assert.equal(customerBody.phone, '233544002233', 'momo_number normalised to 233 format');
  assert.equal(customerBody.reference, 'WA-1');
  assert.ok(customerBody.message.includes('Ref: #WA-1'));

  const merchantBody = JSON.parse(merchantCall.opts.body);
  assert.equal(merchantBody.phone, '233501112223', 'merchant phone normalised');
  assert.equal(merchantBody.message, customerBody.message, 'merchant sees the same receipt');
});

await test('SMS_WEBHOOK_URL receives the same JSON shape', async () => {
  process.env.SMS_WEBHOOK_URL = 'https://sms.example.test/hook';
  const result = await sendOrderReceiptNotification(sampleTrx('SMS-1'), samplePayload('SMS-1'));
  assert.equal(result.ok, true);
  assert.equal(outbound.length, 1);
  const body = JSON.parse(outbound[0].opts.body);
  assert.deepEqual(Object.keys(body).sort(), ['message', 'phone', 'reference']);
  assert.equal(body.reference, 'SMS-1');
});

await test('ARKESEL_API_KEY dispatches via the Arkesel v2 API with api-key header', async () => {
  process.env.ARKESEL_API_KEY = 'arkesel-secret-key';
  const result = await sendOrderReceiptNotification(sampleTrx('ARK-1'), samplePayload('ARK-1'));
  assert.equal(result.ok, true);
  assert.equal(outbound.length, 1);
  const call = outbound[0];
  assert.equal(call.url, 'https://sms.arkesel.com/api/v2/sms/send');
  assert.equal(call.opts.headers['api-key'], 'arkesel-secret-key');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.sender, 'VALMONT-PAY');
  assert.deepEqual(body.recipients, ['233544002233']);
  assert.ok(body.message.includes('Status: PAID ✅'));
});

await test('MNOTIFY_API_KEY dispatches via the mNotify quick SMS API', async () => {
  process.env.MNOTIFY_API_KEY = 'mnotify-secret-key';
  const result = await sendOrderReceiptNotification(sampleTrx('MNO-1'), samplePayload('MNO-1'));
  assert.equal(result.ok, true);
  assert.equal(outbound.length, 1);
  assert.ok(outbound[0].url.startsWith('https://api.mnotify.com/api/sms/quick?key='), 'key in query per mNotify docs');
  assert.ok(outbound[0].url.includes('key=mnotify-secret-key'));
  const body = JSON.parse(outbound[0].opts.body);
  assert.deepEqual(body.recipient, ['233544002233']);
  assert.equal(body.sender, 'VALMONT-PAY');
  assert.ok(Array.isArray(body.recipient));
});

await test('all configured channels fire for one payment', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  process.env.SMS_WEBHOOK_URL = 'https://sms.example.test/hook';
  process.env.ARKESEL_API_KEY = 'ark';
  process.env.MNOTIFY_API_KEY = 'mno';
  const result = await sendOrderReceiptNotification(sampleTrx('ALL-1'), samplePayload('ALL-1'));
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 4, 'one customer phone x four channels');
  assert.equal(outbound.length, 4);
});

await test('FAILED transactions never produce a receipt or an HTTP call', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  const trx = { ...sampleTrx('FAIL-1'), status: 'FAILED' };
  const payload = { event: 'charge.failed', data: { ...samplePayload('FAIL-1').data, status: 'failed' } };
  const result = await sendOrderReceiptNotification(trx, payload);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(outbound.length, 0);
});

await test('a successful reference is not re-notified on Paystack redelivery', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  const first = await sendOrderReceiptNotification(sampleTrx('DUP-1'), samplePayload('DUP-1'));
  assert.equal(first.delivered, 1);
  assert.equal(outbound.length, 1);

  const second = await sendOrderReceiptNotification(sampleTrx('DUP-1'), samplePayload('DUP-1'));
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'duplicate');
  assert.equal(outbound.length, 1, 'still exactly one external call');
});

await test('provider 500 → resolves ok:false, never throws, and stays retryable', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  resetOutbound(async () => ({
    ok: false,
    status: 500,
    text: async () => 'provider exploded'
  }));

  const failed = await sendOrderReceiptNotification(sampleTrx('RETRY-1'), samplePayload('RETRY-1'));
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, 1);
  assert.equal(failed.delivered, 0);

  // Nothing was delivered, so the next webhook hit must try again (recovery).
  resetOutbound();
  const recovered = await sendOrderReceiptNotification(sampleTrx('RETRY-1'), samplePayload('RETRY-1'));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.delivered, 1);
});

await test('network throw inside fetch → still resolves, webhook unaffected', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  resetOutbound(async () => {
    throw new Error('ECONNREFUSED');
  });
  const result = await sendOrderReceiptNotification(sampleTrx('NET-1'), samplePayload('NET-1'));
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.ok(result.results[0].detail.includes('ECONNREFUSED'));
});

await test('missing reference is reported, never thrown', async () => {
  const result = await sendOrderReceiptNotification({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-reference');
});

await test('no customer phone → merchant still gets the alert, no crash', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  process.env.ADMIN_NOTIFICATION_PHONE = '0544000001';
  const payload = samplePayload('NOPHONE-1');
  payload.data.metadata = { merchant: 'Valmont Electricals' };
  payload.data.customer = { email: 'ada@example.com' };
  const trx = { ...sampleTrx('NOPHONE-1') };
  delete trx.customer_phone;

  const result = await sendOrderReceiptNotification(trx, payload);
  assert.equal(result.ok, true);
  assert.equal(outbound.length, 1, 'merchant-only delivery');
  assert.equal(JSON.parse(outbound[0].opts.body).phone, '233544000001');
});

await test('email-only merchant contact is logged, not dispatched', async () => {
  process.env.WHATSAPP_WEBHOOK_URL = 'https://wa.example.test/send';
  process.env.ADMIN_EMAIL = 'support@valmontpay.com';
  const result = await sendOrderReceiptNotification(sampleTrx('EMAIL-1'), samplePayload('EMAIL-1'));
  assert.equal(result.ok, true);
  assert.equal(outbound.length, 1, 'customer only — email cannot receive SMS/WhatsApp');
});

await test('notificationConfigState reports booleans only, never secrets', () => {
  process.env.ARKESEL_API_KEY = 'super-secret-arkesel-key';
  const state = notificationConfigState();
  assert.equal(state.arkeselConfigured, true);
  assert.equal(state.whatsappWebhookConfigured, false);
  assert.ok(!JSON.stringify(state).includes('super-secret-arkesel-key'), 'no secret leakage');
});

console.log(`\n✓ notifier: all ${passed} tests passed.`);
