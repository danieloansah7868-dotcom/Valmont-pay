#!/usr/bin/env node

/**
 * Offline tests for the webhook debugging tools:
 *   - /api/test-webhook accepts POST, logs, and always returns 200
 *   - /api/webhook-status reports checks + env status WITHOUT leaking values
 *   - the ring buffer records inbound hits and redacts sensitive headers
 *
 * No network and no real credentials: the Paystack fetch is stubbed.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.PAYSTACK_SECRET_KEY = 'sk_test_offline_diagnostics_key';
process.env.SUPABASE_URL = 'https://offline-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-test-service-role-key';
delete process.env.WEBHOOK_SECRET;
delete process.env.PUBLIC_BASE_URL;

// Silence the (very verbose, deliberately) handler logging.
const realLog = console.log;
const realWarn = console.warn;
console.log = () => {};
console.warn = () => {};

// Stub Paystack's transaction list.
globalThis.fetch = async url => {
  assert.ok(String(url).includes('api.paystack.co/transaction'), 'must query the Paystack transaction list');
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      data: [
        {
          reference: 'VP-PS-SAVED',
          status: 'success',
          amount: 12500,
          currency: 'GHS',
          channel: 'mobile_money',
          created_at: '2026-07-28T08:00:00.000Z',
          paid_at: '2026-07-28T08:00:05.000Z',
          customer: { email: 'saved@example.com' }
        },
        {
          reference: 'VP-PS-MISSING',
          status: 'success',
          amount: 4000,
          currency: 'GHS',
          channel: 'card',
          created_at: '2026-07-28T09:00:00.000Z',
          customer: { email: 'missing@example.com' }
        }
      ]
    })
  };
};

const webhookLog = (await import('../lib/webhook-log.js')).default;
const diagnostics = (await import('../lib/webhook-diagnostics.js')).default;
const testWebhook = (await import('../api/test-webhook.js')).default;

function request(method, rawBody = '', headers = {}) {
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
  req.method = method;
  req.url = '/api/test-webhook';
  req.headers = { 'content-type': 'application/json', host: 'valmont-pay.vercel.app', ...headers };
  return req;
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

let failures = 0;
const check = (condition, message) => {
  realLog(`${condition ? 'PASS' : 'FAIL'} - ${message}`);
  if (!condition) failures++;
};

// ---------------------------------------------------------------- test-webhook
webhookLog.resetWebhookLog();

const payload = JSON.stringify({ event: 'charge.success', data: { reference: 'VP-TEST-ABC' } });
let res = response();
await testWebhook(request('POST', payload, { 'x-paystack-signature': 'a'.repeat(128), authorization: 'Bearer super-secret' }), res);

check(res.statusCode === 200, 'test-webhook returns 200 for a POST');
check(res.body.received === true, 'test-webhook confirms receipt');
check(res.body.bodyBytes === Buffer.byteLength(payload), 'test-webhook reports the body size');
check(res.body.body.data.reference === 'VP-TEST-ABC', 'test-webhook echoes the parsed body');
check(res.body.signaturePresent === true, 'test-webhook reports the signature header');
check(res.body.headers['content-type'] === 'application/json', 'test-webhook echoes the headers');

// Malformed bodies must still succeed — this endpoint can never be the failure.
res = response();
await testWebhook(request('POST', 'this is not json'), res);
check(res.statusCode === 200, 'test-webhook still returns 200 for a non-JSON body');
check(typeof res.body.bodyParseError === 'string', 'test-webhook reports the JSON parse error');

// Empty body.
res = response();
await testWebhook(request('POST', ''), res);
check(res.statusCode === 200, 'test-webhook returns 200 for an empty body');

// GET probe.
res = response();
await testWebhook(request('GET'), res);
check(res.statusCode === 200, 'test-webhook answers a GET probe');

res = response();
await testWebhook(request('DELETE'), res);
check(res.statusCode === 405, 'test-webhook rejects other methods');

// ------------------------------------------------------------------- ring log
const hits = webhookLog.getRecentWebhookHits(10);
check(hits.length === 3, 'the ring buffer recorded the three POSTs');
check(hits[0].endpoint === '/api/test-webhook', 'hits record the endpoint');
check(hits[2].reference === 'VP-TEST-ABC', 'hits record the transaction reference');
check(hits[2].headers.authorization === '[redacted]', 'the authorization header is redacted');
check(
  hits[2].headers['x-paystack-signature'].includes('…'),
  'the signature header is truncated rather than dumped in full'
);

// --------------------------------------------------------------- diagnostics
// NOTE: the request host below is the CANONICAL production domain. It used to
// be an arbitrary `*.vercel.app` hostname, which passed only because the host
// allowlist carried a `.vercel.app` wildcard — anyone can register a Vercel
// project, so that wildcard let a forged Host header mint payment links and
// Paystack callback URLs on an attacker's domain. The wildcard is gone
// (lib/base-url.js); untrusted hosts now fall back to the canonical domain.
const report = await diagnostics.buildDiagnostics(
  { headers: { host: 'valmontpay.app', 'x-forwarded-proto': 'https' } },
  { includePaystack: false }
);

check(report.webhookConfiguration.canonicalUrl === 'https://valmontpay.app/api/webhook',
  'diagnostics report the canonical webhook URL');
check(report.webhookConfiguration.liveUrl === 'https://valmontpay.app/api/webhook',
  'diagnostics derive the live URL from the request host');

// An untrusted host must NOT be reflected into the recommended webhook URL.
const forged = await diagnostics.buildDiagnostics(
  { headers: { host: 'attacker-phish.vercel.app', 'x-forwarded-proto': 'https' } },
  { includePaystack: false }
);
check(!forged.webhookConfiguration.canonicalUrl.includes('attacker-phish'),
  'a forged .vercel.app host is not reflected into the recommended webhook URL');
check(report.webhookConfiguration.paystackMode === 'test', 'diagnostics detect Paystack TEST mode from sk_test_');
check(report.webhookConfiguration.signingSecretSource === 'PAYSTACK_SECRET_KEY',
  'diagnostics report the signing secret source');

// The critical guarantee: no secret VALUE may appear anywhere in the payload.
const serialized = JSON.stringify(report);
check(!serialized.includes(process.env.PAYSTACK_SECRET_KEY), 'the Paystack secret key value is never exposed');
check(!serialized.includes(process.env.SUPABASE_SERVICE_ROLE_KEY), 'the Supabase service role key value is never exposed');
check(report.environment.PAYSTACK_SECRET_KEY.configured === true, 'env status reports PAYSTACK_SECRET_KEY as set');
check(report.environment.WEBHOOK_SECRET.configured === false, 'env status reports WEBHOOK_SECRET as unset');
check(report.environment.SUPABASE_SERVICE_ROLE_KEY.configured === true, 'env status reports the service role key as set');
check(typeof report.environment.PAYSTACK_SECRET_KEY.fingerprint === 'string',
  'env status exposes a fingerprint instead of the value');

const byId = Object.fromEntries(report.checks.map(c => [c.id, c]));
check(byId['signing-secret-present'].status === 'pass', 'check: a signing secret is configured');
check(byId['webhook-secret-matches-paystack-key'].status === 'pass',
  'check: an unset WEBHOOK_SECRET passes (PAYSTACK_SECRET_KEY is used)');
check(byId['webhook-url'].status === 'pass', 'check: the webhook URL matches the canonical URL');
check(byId['paystack-mode'].mode === 'test', 'check: Paystack mode is reported');
check(byId['events-selected'].status === 'pass', 'check: charge.success and charge.failed are handled');
check(byId['supabase-configured'].status === 'pass', 'check: Supabase is configured with the service role key');
check(report.summary.failures === 0, 'a correctly configured deployment reports no blocking failures');

// A stale WEBHOOK_SECRET must never override the Paystack credential. This is
// the exact production combination that previously rejected live callbacks.
process.env.WEBHOOK_SECRET = 'something-completely-different';
const mismatched = diagnostics.configurationChecks({ headers: { host: 'valmontpay.app' } });
const mismatchCheck = mismatched.find(c => c.id === 'webhook-secret-matches-paystack-key');
check(mismatchCheck.status === 'pass', 'check: a differing WEBHOOK_SECRET is safely ignored');
check(mismatchCheck.fix === null, 'the authoritative Paystack key needs no remediation');
delete process.env.WEBHOOK_SECRET;

// A live key must be reported as live so test-mode payments are not expected.
process.env.PAYSTACK_SECRET_KEY = 'sk_live_offline_diagnostics_key';
check(diagnostics.paystackKeyMode(process.env.PAYSTACK_SECRET_KEY) === 'live', 'sk_live_ keys are detected as LIVE mode');
check(diagnostics.paystackKeyMode('pk_test_abc') === 'public-key-misconfigured', 'a public key is flagged as misconfigured');
process.env.PAYSTACK_SECRET_KEY = 'sk_test_offline_diagnostics_key';

// The cross-reference below only stubs Paystack. Disable the fake Supabase
// configuration before it runs so this offline test does not construct a live
// client (which also requires a WebSocket transport under the CI Node version).
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

// ------------------------------------------- Paystack cross-reference (stubbed)
const deliveries = await diagnostics.getRecentPaystackDeliveries(10);
check(deliveries.available === true, 'the Paystack transaction list is fetched');
check(deliveries.deliveries.length === 2, 'both stubbed Paystack transactions are listed');
check(deliveries.deliveries[0].amount === 125, 'Paystack subunits are converted to major units');

console.log = realLog;
console.warn = realWarn;

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\n✓ Webhook diagnostics, test endpoint, and secret redaction all passed.');
