/**
 * End-to-end test for the merchant payment API.
 *
 * Runs a real Express server on a random port and a real merchant webhook
 * receiver, with no network access and no Paystack key needed.
 *
 *   node scripts/merchant-api-test.mjs
 *
 * Covers the four deliverables:
 *   1. server-side initialize + the tampered-amount attack
 *   2. signed, idempotent, retrying webhooks
 *   3. verify
 *   4. return redirect
 * plus keys, opaque references, and the dashboard endpoints.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Isolate this run from any real .data directory.
process.env.VALMONTPAY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'valmontpay-test-'));
process.env.VALMONTPAY_MERCHANT_NAME = 'Valmont Electricals';
process.env.VALMONTPAY_WEBHOOK_TICK_MS = '50';
process.env.CHARGE_SETTLEMENT_DELAY_MS = '1';

const require = createRequire(import.meta.url);
const express = require('express');

const merchants = require('../lib/merchants.js');
const payments = require('../lib/payments.js');
const webhookDelivery = require('../lib/webhook-delivery.js');
const gateway = require('../lib/gateway.js');
const merchantApi = require('../lib/merchant-api.js');
const keys = require('../lib/keys.js');
const money = require('../lib/money.js');

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${msg}`);
  if (!cond) failures++;
};
const section = title => console.log(`\n# ${title}`);

// --------------------------------------------------------------- gateway app
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.baseOrigin = `http://127.0.0.1:${gatewayPort}`; next(); });
app.use('/api', merchantApi.router);
const gatewayServer = http.createServer(app);
await new Promise(resolve => gatewayServer.listen(0, '127.0.0.1', resolve));
const gatewayPort = gatewayServer.address().port;
const BASE = `http://127.0.0.1:${gatewayPort}`;

// ----------------------------------------------------- merchant's own server
/** Everything the merchant's endpoint received. */
const received = [];
/** Queue of status codes to return; defaults to 200 when empty. */
let responseQueue = [];

const merchantServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    received.push({ headers: req.headers, raw, body: JSON.parse(raw || '{}') });
    const status = responseQueue.length ? responseQueue.shift() : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{"received":true}');
  });
});
await new Promise(resolve => merchantServer.listen(0, '127.0.0.1', resolve));
const MERCHANT_URL = `http://127.0.0.1:${merchantServer.address().port}/valmontpay/webhook`;

// ------------------------------------------------------------------- helpers
async function call(method, path, { key, body } = {}) {
  const response = await fetch(BASE + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle(20);
  }
  return false;
}

// =============================================================== 0. Keypairs
section('0. Keypairs');
const merchant = merchants.getDefaultMerchant();
const TEST_SK = merchant.keys.test.secret_key;
const LIVE_SK = merchant.keys.live.secret_key;

check(/^pk_test_[0-9a-f]{48}$/.test(merchant.keys.test.public_key), 'test public key looks like pk_test_…');
check(/^sk_test_[0-9a-f]{48}$/.test(TEST_SK), 'test secret key looks like sk_test_…');
check(/^pk_live_[0-9a-f]{48}$/.test(merchant.keys.live.public_key), 'live public key looks like pk_live_…');
check(/^sk_live_[0-9a-f]{48}$/.test(LIVE_SK), 'live secret key looks like sk_live_…');
check(TEST_SK !== LIVE_SK, 'test and live secrets differ');
check(!keys.redact(LIVE_SK).includes(LIVE_SK.slice(12, 40)), 'redact() hides the body of a secret key');
check(merchants.authenticateSecretKey(TEST_SK).mode === 'test', 'a test secret authenticates in test mode');
check(merchants.authenticateSecretKey(LIVE_SK).mode === 'live', 'a live secret authenticates in live mode');
check(merchants.authenticateSecretKey(merchant.keys.live.public_key) === null, 'a PUBLIC key cannot authenticate');
check(merchants.authenticateSecretKey('sk_live_' + 'f'.repeat(48)) === null, 'a forged secret is rejected');
check(
  merchants.toSafeJSON(merchant).keys.live.secret_key === undefined,
  'the browser-safe merchant JSON contains no secret key'
);

// ========================================= 1. Server-side initialize + attack
section('1. POST /api/transaction/initialize');

let res = await call('POST', '/transaction/initialize', {
  body: { amount: 1500, reference: 'VE-MFA1B2C3' }
});
check(res.status === 401, 'initialize without a key -> 401');

res = await call('POST', '/transaction/initialize', {
  key: merchant.keys.live.public_key,
  body: { amount: 1500, reference: 'VE-X' }
});
check(res.status === 401, 'initialize with the PUBLIC key -> 401');

// Ghana Cedis, minor units: GH₵ 15.00 = 1500 pesewas.
res = await call('POST', '/transaction/initialize', {
  key: LIVE_SK,
  body: {
    amount: 1500,
    reference: 'VE-MFA1B2C3',
    email: 'kwame@example.com',
    phone: '0244000000',
    callback_url: 'https://valmontelectricals.com/order/complete?order=9912'
  }
});
check(res.status === 201, 'initialize -> 201');
check(res.body.data.access_code.startsWith('ac_'), 'returns an opaque access_code');
check(res.body.data.amount === 1500, 'echoes the amount in minor units (pesewas)');
check(res.body.data.currency === 'GHS', 'currency is GHS, not NGN');
check(
  !res.body.data.access_code.includes('1500') &&
    !res.body.data.authorization_url.includes('amount'),
  'neither the access code nor the authorization_url carries the amount'
);
const ACCESS_CODE = res.body.data.access_code;

res = await call('POST', '/transaction/initialize', { key: LIVE_SK, body: { amount: 15.5, reference: 'VE-BAD' } });
check(res.status === 400 && res.body.code === 'invalid_amount', 'a fractional minor amount is rejected');
res = await call('POST', '/transaction/initialize', { key: LIVE_SK, body: { amount: -100, reference: 'VE-BAD' } });
check(res.status === 400, 'a negative amount is rejected');
res = await call('POST', '/transaction/initialize', { key: LIVE_SK, body: { amount: 1000 } });
check(res.status === 400 && res.body.code === 'invalid_reference', 'a missing reference is rejected');

// Idempotency of initialize
res = await call('POST', '/transaction/initialize', { key: LIVE_SK, body: { amount: 1500, reference: 'VE-MFA1B2C3' } });
check(res.status === 200, 're-initializing the same reference+amount -> 200, not a duplicate');
check(payments.list({ mode: 'live' }).filter(p => p.reference === 'VE-MFA1B2C3').length === 1, 'still exactly one payment record');
const REISSUED_CODE = res.body.data.access_code;
check(REISSUED_CODE !== ACCESS_CODE, 're-initializing issues a fresh access code');

res = await call('POST', '/transaction/initialize', { key: LIVE_SK, body: { amount: 999999, reference: 'VE-MFA1B2C3' } });
check(res.status === 409 && res.body.code === 'reference_conflict', 're-initializing with a DIFFERENT amount -> 409');

// --- THE ATTACK ---
section('1b. The tampered-amount attack');
let resolve = await call('POST', '/checkout/resolve', { body: { access_code: REISSUED_CODE } });
check(resolve.status === 200 && resolve.body.data.amount === 1500, 'access_code resolves to the real amount server-side');
check(resolve.body.data.amount_display === 'GH\u20b5 15.00', 'amount renders as GH₵ 15.00');
check(resolve.body.data.amount_verified === true, 'the amount is flagged as verified');

// A customer editing the URL has nothing to edit — but try the legacy form for
// the SAME reference, claiming 1 pesewa.
resolve = await call('POST', '/checkout/resolve', {
  body: { ref: 'VE-MFA1B2C3', amount: 1, merchant: 'Valmont Electricals' }
});
check(resolve.status === 200, 'the legacy query-string form still works');
check(resolve.body.data.amount === 1500, 'a query string claiming 1 pesewa is IGNORED — the initialized 1500 wins');
check(
  (resolve.body.warnings || []).some(w => /did not match/i.test(w)),
  'the mismatch is reported as a warning'
);
check(payments.get('VE-MFA1B2C3').amount_claim.rejected === true, 'the rejected claim is recorded on the payment');

// A legacy merchant that never initialized: amount cannot be verified.
resolve = await call('POST', '/checkout/resolve', {
  body: { ref: 'VE-BK-123456', amount: 7500, merchant: 'Valmont Electricals', callback_url: 'https://valmontelectricals.com/thanks' }
});
check(resolve.status === 200 && resolve.body.data.amount === 7500, 'an un-initialized legacy link still checks out');
check(resolve.body.data.amount_verified === false, 'but its amount is explicitly marked UNVERIFIED');
check(payments.get('VE-BK-123456').source === 'legacy', 'and the payment is tagged source=legacy');

// ============================================ 2. Webhook (signed, idempotent)
section('2. Webhooks');
let hook = await call('PUT', '/merchant/webhook', { key: LIVE_SK, body: { mode: 'live', url: MERCHANT_URL } });
check(hook.status === 400, 'a live webhook URL over plain http is rejected');
// Test mode allows http so integrations can point at localhost.
hook = await call('PUT', '/merchant/webhook', { key: TEST_SK, body: { mode: 'test', url: MERCHANT_URL } });
check(hook.status === 200, 'a test webhook URL over http is accepted');
hook = await call('PUT', '/merchant/webhook', { key: LIVE_SK, body: { mode: 'live', url: 'not a url' } });
check(hook.status === 400, 'a malformed webhook URL is rejected');

// Point live mode at the test server by writing the record directly (the HTTPS
// rule is a policy on the API surface, not on the delivery engine).
merchant.webhooks.live = { url: MERCHANT_URL, updated_at: new Date().toISOString() };
merchants.store.set(merchant.id, merchant);

received.length = 0;
let done = await call('POST', '/checkout/complete', {
  body: { access_code: REISSUED_CODE, status: 'success', channel: 'mobile_money', email: 'kwame@example.com' }
});
check(done.status === 200 && done.body.data.status === 'success', 'checkout/complete settles the payment');
check(await waitFor(() => received.length >= 1), 'the merchant endpoint received a webhook');

const delivery = received[0];
check(delivery.body.event === 'charge.success', 'event is charge.success');
const data = delivery.body.data;
check(
  JSON.stringify(Object.keys(data).sort()) ===
    JSON.stringify(['amount', 'channel', 'currency', 'gateway_reference', 'merchant', 'paid_at', 'reference', 'status'].sort()),
  'data has exactly the documented keys'
);
check(data.reference === 'VE-MFA1B2C3', 'data.reference is the merchant reference, verbatim');
check(data.amount === 1500, 'data.amount is minor units — the INITIALIZED amount, not the tampered one');
check(data.currency === 'GHS', 'data.currency is GHS');
check(data.channel === 'mobile_money', 'data.channel is set');
check(data.merchant === 'Valmont Electricals', 'data.merchant is set');
check(typeof data.paid_at === 'string', 'data.paid_at is set');

// Signature: exactly Paystack's scheme, so merchant code ports over.
const signature = delivery.headers['x-valmontpay-signature'];
const expected = crypto.createHmac('sha512', LIVE_SK).update(delivery.raw).digest('hex');
check(signature === expected, 'x-valmontpay-signature = HMAC-SHA512(raw body, secret key), hex');
check(signature.length === 128, 'the signature is a 128-char hex SHA-512 digest');
check(
  crypto.createHmac('sha512', TEST_SK).update(delivery.raw).digest('hex') !== signature,
  'the signature does NOT verify against the other mode\u2019s key'
);
check(
  webhookDelivery.verifySignature(delivery.raw, signature, LIVE_SK) &&
    !webhookDelivery.verifySignature(delivery.raw + ' ', signature, LIVE_SK),
  'verifySignature accepts the exact bytes and rejects modified ones'
);

// Exactly one webhook per payment.
section('2b. Exactly one webhook per payment');
const before = received.length;
await call('POST', '/checkout/complete', { body: { ref: 'VE-MFA1B2C3', status: 'success', channel: 'card' } });
gateway.settle('VE-MFA1B2C3', { status: 'success', channel: 'card' });
gateway.settle('VE-MFA1B2C3', { status: 'failed' });
await settle(200);
check(received.length === before, 'repeated settlement of the same reference sends NO further webhook');
check(payments.get('VE-MFA1B2C3').channel === 'mobile_money', 'the first terminal write wins; later ones cannot mutate it');
check(
  webhookDelivery.list({ reference: 'VE-MFA1B2C3' }).length === 1,
  'exactly one delivery record exists for the payment'
);

// Retry with identical payload.
section('2c. Retries are byte-identical');
await call('POST', '/transaction/initialize', { key: LIVE_SK, body: { amount: 2500, reference: 'VE-BK-RETRY-1' } });
received.length = 0;
responseQueue = [500, 503]; // fail twice, then succeed
webhookDelivery.setFetch((url, options) => globalThis.fetch(url, options));
gateway.settle('VE-BK-RETRY-1', { status: 'failed', channel: 'card', failure_reason: 'insufficient funds' });
check(await waitFor(() => received.length >= 1), 'first attempt made');

const retryDelivery = webhookDelivery.list({ reference: 'VE-BK-RETRY-1' })[0];
// Force the retries to be due immediately instead of waiting out the backoff.
for (let i = 0; i < 2; i++) {
  const record = webhookDelivery.get(retryDelivery.id);
  if (record.state !== 'pending') break;
  record.next_attempt_at = new Date(0).toISOString();
  webhookDelivery.deliveries.set(record.id, record);
  await webhookDelivery.processDue();
}
check(received.length === 3, 'retried until a 2xx (3 attempts: 500, 503, 200)');
check(
  received[0].raw === received[1].raw && received[1].raw === received[2].raw,
  'every retry sent a BYTE-IDENTICAL body'
);
check(
  received[0].headers['x-valmontpay-signature'] === received[2].headers['x-valmontpay-signature'],
  'every retry sent the same signature'
);
check(
  received[0].headers['x-valmontpay-event-id'] === received[2].headers['x-valmontpay-event-id'],
  'every retry sent the same x-valmontpay-event-id (the de-duplication key)'
);
check(
  received.map(r => r.headers['x-valmontpay-attempt']).join(',') === '1,2,3',
  'x-valmontpay-attempt counts up so the merchant can tell retries apart'
);
check(received[0].body.event === 'charge.failed', 'a failed payment emits charge.failed');
check(webhookDelivery.get(retryDelivery.id).state === 'delivered', 'the delivery is marked delivered');

// Backoff shape / 24h window.
section('2d. Backoff covers ~24h');
const totalSeconds = webhookDelivery.BACKOFF_SECONDS.reduce((a, b) => a + b, 0);
check(totalSeconds >= 23 * 3600, `the retry schedule spans ~24h (${(totalSeconds / 3600).toFixed(1)}h)`);
check(
  webhookDelivery.BACKOFF_SECONDS.every((v, i, arr) => i === 0 || v >= arr[i - 1]),
  'the backoff is non-decreasing (exponential, then capped)'
);
check(webhookDelivery.MAX_WINDOW_MS === 24 * 60 * 60 * 1000, 'the hard give-up window is 24h');

// Refunds.
section('2e. refund.processed');
received.length = 0;
responseQueue = [];
const refundResult = gateway.refund('VE-MFA1B2C3', {});
check(refundResult.changed === true, 'a successful payment can be refunded');
check(await waitFor(() => received.length >= 1), 'the refund produced a webhook');
check(received[0].body.event === 'refund.processed', 'event is refund.processed');
check(received[0].body.data.status === 'refunded', 'data.status is refunded');
check(gateway.refund('VE-BK-RETRY-1', {}).ok === false, 'a FAILED payment cannot be refunded');

// No webhook URL configured.
section('2f. No webhook URL configured');
const noHookMerchant = merchants.createMerchant({ name: 'No Hook Ltd' });
payments.initialize({ merchant: noHookMerchant, mode: 'live', amount: 500, reference: 'NH-1' });
const queued = gateway.settle('NH-1', { status: 'success' });
check(queued.delivery.state === 'disabled', 'the delivery is recorded as disabled, not lost');
check(
  webhookDelivery.get(queued.delivery.id).body.includes('"NH-1"'),
  'its payload is stored, ready to replay once a URL is configured'
);

// ================================================================= 3. Verify
section('3. GET /api/transaction/verify/{reference}');
res = await call('GET', '/transaction/verify/VE-BK-RETRY-1');
check(res.status === 401, 'verify without a key -> 401');
res = await call('GET', '/transaction/verify/VE-BK-RETRY-1', { key: TEST_SK });
check(res.status === 404, 'a TEST key cannot see a LIVE transaction');
res = await call('GET', '/transaction/verify/DOES-NOT-EXIST', { key: LIVE_SK });
check(res.status === 404, 'an unknown reference -> 404');

res = await call('GET', '/transaction/verify/VE-BK-RETRY-1', { key: LIVE_SK });
check(res.status === 200 && res.body.status === true, 'verify -> 200');
check(
  JSON.stringify(res.body.data) === JSON.stringify(received.length ? payments.toPublicData(payments.get('VE-BK-RETRY-1')) : null),
  'verify returns the canonical data object'
);
const verified = res.body.data;
check(
  JSON.stringify(Object.keys(verified).sort()) ===
    JSON.stringify(['amount', 'channel', 'currency', 'gateway_reference', 'merchant', 'paid_at', 'reference', 'status'].sort()),
  'verify data has EXACTLY the same keys as the webhook data'
);
check(verified.amount === 2500 && verified.currency === 'GHS', 'verify reports the amount in pesewas and GHS');
check(verified.status === 'failed', 'verify reflects the terminal status');

// The reference is opaque, whatever shape it takes.
section('3b. References are opaque');
for (const reference of ['VE-MFA1B2C3', 'VE-BK-123456', 'VE-BK-1-2-3', 'plain', 'a/b?c=d', 'VE_2026#7']) {
  await call('POST', '/transaction/initialize', { key: TEST_SK, body: { amount: 100, reference } });
  const check1 = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`, { key: TEST_SK });
  check(
    check1.status === 200 && check1.body.data.reference === reference,
    `reference ${JSON.stringify(reference)} round-trips unparsed`
  );
}

// ======================================================== 4. Return redirect
section('4. Return redirect');
await call('POST', '/transaction/initialize', {
  key: LIVE_SK,
  body: {
    amount: 4200,
    reference: 'VE-REDIR-1',
    callback_url: 'https://valmontelectricals.com/checkout/done?order=551&utm=email'
  }
});
const redirect = gateway.settle('VE-REDIR-1', { status: 'success', channel: 'card' });
const url = new URL(redirect.redirect_url);
check(url.origin + url.pathname === 'https://valmontelectricals.com/checkout/done', 'redirects to the supplied callback_url');
check(url.searchParams.get('ref') === 'VE-REDIR-1', '?ref= is appended');
check(url.searchParams.get('status') === 'success', '?status=success is appended');
check(url.searchParams.get('order') === '551' && url.searchParams.get('utm') === 'email', 'the merchant\u2019s own params survive');

payments.initialize({ merchant, mode: 'live', amount: 100, reference: 'VE-REDIR-2', callback_url: 'https://shop.test/done' });
check(
  new URL(gateway.settle('VE-REDIR-2', { status: 'failed' }).redirect_url).searchParams.get('status') === 'failed',
  'a failed payment redirects with status=failed'
);
payments.initialize({ merchant, mode: 'live', amount: 100, reference: 'VE-REDIR-3', callback_url: 'https://shop.test/done' });
check(
  new URL(gateway.settle('VE-REDIR-3', { status: 'cancelled' }).redirect_url).searchParams.get('status') === 'cancelled',
  'a cancelled payment redirects with status=cancelled'
);
payments.initialize({ merchant, mode: 'live', amount: 100, reference: 'VE-REDIR-4' });
check(gateway.settle('VE-REDIR-4', { status: 'success' }).redirect_url === null, 'no callback_url -> no redirect, and no error');
check(gateway.buildRedirectUrl('javascript:alert(1)', 'X', 'success') === null, 'a javascript: callback_url is refused');

// The redirect is cosmetic: the webhook fires whether or not the customer returns.
const abandoned = webhookDelivery.list({ reference: 'VE-REDIR-1' });
check(abandoned.length === 1, 'the webhook for VE-REDIR-1 was queued without the browser ever following the redirect');

// ====================================================== 5. Dashboard surface
section('5. Dashboard endpoints');
res = await call('GET', '/merchant/keys', { key: LIVE_SK });
check(res.status === 200, 'GET /merchant/keys -> 200');
check(res.body.data.keys.live.secret_key === undefined, 'secret keys are redacted by default');
check(res.body.data.keys.live.public_key.startsWith('pk_live_'), 'public keys are returned in full');
res = await call('GET', '/merchant/keys?reveal=1', { key: LIVE_SK });
check(res.body.data.keys.live.secret_key === LIVE_SK, 'an explicit ?reveal=1 returns the secret');

res = await call('GET', '/merchant/deliveries', { key: LIVE_SK });
check(res.status === 200 && Array.isArray(res.body.data), 'GET /merchant/deliveries lists attempts');
check(res.body.data.every(d => Array.isArray(d.attempts)), 'each delivery carries its attempt log');
check(typeof res.body.summary.delivered === 'number', 'a delivery summary is included');

// Replay.
section('5b. Replay');
received.length = 0;
const replayTarget = webhookDelivery.list({ reference: 'VE-BK-RETRY-1' })[0];
const originalEventId = replayTarget.event_id;
const originalBody = replayTarget.body;
res = await call('POST', `/merchant/deliveries/${encodeURIComponent(replayTarget.id)}/replay`, { key: LIVE_SK });
check(res.status === 200, 'replay -> 200');
check(await waitFor(() => received.length >= 1), 'the merchant received the replayed delivery');
check(received[0].body.event === 'charge.failed', 'the replay carries the original event');
check(received[0].raw === originalBody, 'the replay body is byte-identical to the original');
check(received[0].headers['x-valmontpay-event-id'] === originalEventId, 'the replay reuses the original event id, so it de-duplicates');
check(
  received[0].headers['x-valmontpay-signature'] ===
    crypto.createHmac('sha512', LIVE_SK).update(received[0].raw).digest('hex'),
  'the replay is freshly signed with the current secret'
);

res = await call('GET', '/merchant/payments', { key: LIVE_SK });
check(res.status === 200, 'GET /merchant/payments -> 200');
check(res.body.summary.unverified_amounts >= 1, 'the dashboard counts payments with unverified amounts');
check(res.body.summary.currency === 'GHS', 'the dashboard reports GHS');

// Key rotation invalidates the old secret.
section('5c. Key rotation');
res = await call('POST', '/merchant/keys/rotate', { key: TEST_SK, body: { mode: 'test' } });
check(res.status === 200 && res.body.data.secret_key !== TEST_SK, 'rotation issues a new test secret');
check((await call('GET', '/merchant/keys', { key: TEST_SK })).status === 401, 'the old test secret stops working immediately');

// ================================================================= 6. Money
section('6. Currency handling');
check(money.currency() === 'GHS', 'the default currency is GHS');
check(money.parseMinor('1500') === 1500 && money.parseMinor(0) === null, 'parseMinor accepts positive integers only');
check(money.toMinor(50.1) === 5010, 'toMinor avoids float drift (50.1 -> 5010)');
check(money.formatMinor(1500) === 'GH\u20b5 15.00', 'formatMinor renders cedis');

const sourceFiles = ['lib/money.js', 'lib/payments.js', 'lib/merchant-api.js', 'lib/gateway.js', 'lib/webhook-delivery.js'];
const noNGN = sourceFiles.every(file => {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  return !/['"]NGN['"]/.test(source);
});
check(noNGN, 'no NGN is hardcoded anywhere in the new gateway code');

const payHtml = fs.readFileSync(new URL('../pay.html', import.meta.url), 'utf8');
check(!/parseFloat\(\s*(urlParams|params)\.get\(['"]amount/.test(payHtml), 'pay.html no longer trusts the URL amount');
check(payHtml.includes('/api/checkout/resolve'), 'pay.html resolves its amount server-side');
check(payHtml.includes('access_code'), 'pay.html accepts ?access_code=');

// ------------------------------------------------------------------ teardown
webhookDelivery.stopScheduler();
gatewayServer.close();
merchantServer.close();
fs.rmSync(process.env.VALMONTPAY_DATA_DIR, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
