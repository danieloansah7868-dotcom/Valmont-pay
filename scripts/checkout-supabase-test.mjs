#!/usr/bin/env node

/**
 * Offline test for the DASHBOARD CHECKOUT persistence path.
 *
 * The dashboard's own checkout posts to /api/v1/transaction/charge. That route
 * never touches Paystack, so NO WEBHOOK EVER FIRES for it — if the route does
 * not write to Supabase itself, the dashboard shows zero transactions forever.
 * That is the bug this file guards against.
 *
 * Everything runs against an injected Supabase stub: no credentials, no network.
 *
 * Covers:
 *   1. The exact Supabase column mapping (reference, merchant_name,
 *      customer_email, amount, payment_method, status, paid_at).
 *   2. That NO `updated_at` field is ever sent (the deployed table has no such
 *      column; sending it makes PostgREST reject the whole write).
 *   3. A successful charge is persisted, and reappears through /api/transactions.
 *   4. A returned Supabase `{ error }` (e.g. an RLS denial) is NOT ignored.
 *   5. /api/transactions surfaces read errors and missing configuration.
 *   6. The webhook prefers WEBHOOK_SECRET and falls back to PAYSTACK_SECRET_KEY.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://offline-checkout-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-checkout-service-role-key';
delete process.env.SUPABASE_ANON_KEY;
// Keep the simulated USSD delay out of the test runtime.
process.env.CHARGE_SETTLEMENT_DELAY_MS = '10';
process.env.PORT = '4322';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${msg}`);
  if (!cond) failures++;
};

// --------------------------------------------------------------- Supabase stub
const upsertedRows = [];
let nextWriteResult = null; // { data, error }
let nextReadResult = null; // { data, error }
const storedRows = [];

const fakeSupabase = {
  from(table) {
    assert.equal(table, 'transactions', 'writes must target the transactions table');
    return {
      upsert(row, options) {
        assert.deepEqual(options, { onConflict: 'reference' }, 'must upsert on reference');
        upsertedRows.push(row);
        return {
          async select() {
            if (nextWriteResult) return nextWriteResult;
            const index = storedRows.findIndex(r => r.reference === row.reference);
            if (index >= 0) storedRows[index] = { ...row };
            else storedRows.push({ ...row });
            return { data: [row], error: null };
          }
        };
      },
      select() {
        return {
          async order() {
            return nextReadResult || { data: [...storedRows], error: null };
          }
        };
      }
    };
  }
};

const store = require('../lib/transaction-store.js');
store.setSupabaseClient(fakeSupabase);

// -------------------------------------------------- 1. exact column mapping
console.log('\n# Supabase column mapping');

const record = store.buildTransactionRecord({
  reference: 'VP-CHECKOUT-1',
  merchant: 'Valmont Electricals',
  customer: 'buyer@example.com',
  amount: 75.5,
  channel: 'Momo (MTN)',
  status: 'SUCCESS',
  timestamp: '2026-07-28T09:00:00.000Z'
});

check(
  Object.keys(record).sort().join(',') ===
    ['reference', 'merchant_name', 'customer_email', 'amount', 'payment_method', 'status', 'paid_at']
      .sort()
      .join(','),
  'the record contains EXACTLY the 7 required transactions columns'
);
check(!('updated_at' in record), 'the record does NOT contain updated_at');
check(
  store.TRANSACTION_COLUMNS.join(',') ===
    'reference,merchant_name,customer_email,amount,payment_method,status,paid_at',
  'TRANSACTION_COLUMNS lists the required columns in order'
);
check(record.reference === 'VP-CHECKOUT-1', 'reference is mapped');
check(record.merchant_name === 'Valmont Electricals', 'merchant -> merchant_name');
check(record.customer_email === 'buyer@example.com', 'customer -> customer_email');
check(record.amount === 75.5, 'amount is a rounded number');
check(record.payment_method === 'Momo (MTN)', 'channel -> payment_method');
check(record.status === 'SUCCESS', 'status is upper-cased');
check(record.paid_at === '2026-07-28T09:00:00.000Z', 'timestamp -> paid_at for a success');

const failedRecord = store.buildTransactionRecord({
  reference: 'VP-CHECKOUT-FAILED',
  amount: '20',
  status: 'failed'
});
check(failedRecord.paid_at === null, 'a FAILED transaction has paid_at = null');
check(failedRecord.amount === 20, 'a string amount is coerced to a number');
check(failedRecord.merchant_name === 'Valmont-Pay', 'merchant_name falls back to Valmont-Pay');
check(
  failedRecord.customer_email === 'unknown@customer',
  'customer_email falls back to unknown@customer'
);
check(!('updated_at' in failedRecord), 'the failed record does NOT contain updated_at either');

// ------------------------------------------------------- 2. successful write
console.log('\n# saveTransaction');
let result = await store.saveTransaction(record, { context: 'TEST' });
check(result.ok === true, 'a healthy Supabase upsert reports ok');
check(result.error === null, 'a healthy upsert has no error');
check(upsertedRows.length === 1, 'exactly one row was written');
assert.deepEqual(upsertedRows[0], {
  reference: 'VP-CHECKOUT-1',
  merchant_name: 'Valmont Electricals',
  customer_email: 'buyer@example.com',
  amount: 75.5,
  payment_method: 'Momo (MTN)',
  status: 'SUCCESS',
  paid_at: '2026-07-28T09:00:00.000Z'
});
check(true, 'the written row matches the exact expected column payload');
check(!('updated_at' in upsertedRows[0]), 'the written row omits updated_at');

// ------------------------------------- 3. Supabase / RLS errors are surfaced
console.log('\n# Supabase errors are never ignored');
nextWriteResult = {
  data: null,
  error: {
    code: '42501',
    message: 'new row violates row-level security policy for table "transactions"'
  }
};
result = await store.saveTransaction(
  { reference: 'VP-RLS-DENIED', amount: 10, status: 'SUCCESS' },
  { context: 'TEST' }
);
check(result.ok === false, 'an RLS denial is reported as a failure, not swallowed');
check(
  String(result.reason).includes('row-level security'),
  'the RLS error message is surfaced to the caller'
);
check(result.error && result.error.code === '42501', 'the raw Supabase error object is returned');
nextWriteResult = null;

result = await store.saveTransaction({ amount: 10, status: 'SUCCESS' }, { context: 'TEST' });
check(result.ok === false, 'a transaction without a reference is rejected');

// ---------------------------------------- 4. missing environment is reported
console.log('\n# Missing Supabase configuration');
const supabaseModule = require('../lib/supabase.js');
const savedUrl = process.env.SUPABASE_URL;
const savedServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
supabaseModule.resetSupabaseClient();
check(supabaseModule.isSupabaseConfigured() === false, 'no env vars -> not configured');
check(
  String(supabaseModule.missingSupabaseEnvMessage()).includes('SUPABASE_URL'),
  'the missing-env message names SUPABASE_URL'
);

process.env.SUPABASE_URL = savedUrl;
process.env.SUPABASE_ANON_KEY = 'offline-anon-key';
supabaseModule.resetSupabaseClient();
check(
  supabaseModule.isSupabaseConfigured() === true,
  'SUPABASE_ANON_KEY alone is enough to initialize Supabase'
);
check(
  supabaseModule.supabaseConfigState().credentialType === 'anon',
  'anon key is reported as the credential type when it is the only key'
);

process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceKey;
supabaseModule.resetSupabaseClient();
check(
  supabaseModule.supabaseConfigState().credentialType === 'service-role',
  'SUPABASE_SERVICE_ROLE_KEY is PREFERRED over SUPABASE_ANON_KEY'
);
delete process.env.SUPABASE_ANON_KEY;
supabaseModule.resetSupabaseClient();

// ------------------------------------------------------------- 5. read path
console.log('\n# fetchTransactions');
const read = await store.fetchTransactions({ context: 'TEST' });
check(read.ok === true, 'reads succeed against a healthy Supabase');
check(read.transactions.length === 1, 'the persisted transaction is read back');
const dashboardRow = read.transactions[0];
check(dashboardRow.reference === 'VP-CHECKOUT-1', 'the row carries the reference');
check(dashboardRow.customer === 'buyer@example.com', 'customer_email -> customer for the dashboard');
check(dashboardRow.channel === 'Momo (MTN)', 'payment_method -> channel for the dashboard');
check(dashboardRow.merchant === 'Valmont Electricals', 'merchant_name -> merchant for the dashboard');
check(dashboardRow.amount === 75.5, 'the amount survives the round trip');
check(store.calculateBalance(read.transactions) === 75.5, 'balance sums SUCCESS rows only');

nextReadResult = { data: null, error: { message: 'permission denied for table transactions' } };
const failedRead = await store.fetchTransactions({ context: 'TEST' });
check(failedRead.ok === false, 'a Supabase read error is reported, not hidden as an empty list');
check(
  String(failedRead.reason).includes('permission denied'),
  'the read error message is surfaced'
);
nextReadResult = null;

// ---------------------------------- 6. end-to-end: charge -> /api/transactions
console.log('\n# End-to-end: dashboard checkout -> Supabase -> /api/transactions');
const ledger = require('../lib/ledger.js');
ledger.resetLedger();
storedRows.length = 0;
upsertedRows.length = 0;

await import('../server.js');
await new Promise(r => setTimeout(r, 400));
const base = 'http://127.0.0.1:4322';
const get = async url => (await fetch(base + url)).json();
const post = async (url, body) =>
  (await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })).json();

// The dashboard checkout flow: initialize, then charge.
const init = await post('/api/v1/transaction/initialize', {
  email: 'dashboard-buyer@example.com',
  amount: 120.25,
  merchant: 'Valmont Electricals'
});
const reference = init.data.reference;

const charge = await post('/api/v1/transaction/charge', {
  reference,
  amount: 120.25,
  merchant: 'Valmont Electricals',
  email: 'dashboard-buyer@example.com',
  channel: 'Momo (MTN)',
  wallet_number: '0244000000'
});
check(charge.trx_status === 'SUCCESS', 'the dashboard checkout charge clears');
check(charge.persisted === true, 'the charge response reports the transaction was persisted');

const chargeRow = upsertedRows.find(r => r.reference === reference);
check(Boolean(chargeRow), 'the charge wrote a row to Supabase (no webhook involved)');
check(
  chargeRow && Object.keys(chargeRow).sort().join(',') ===
    ['amount', 'customer_email', 'merchant_name', 'paid_at', 'payment_method', 'reference', 'status'].join(','),
  'the charge row uses EXACTLY the 7 required columns'
);
check(chargeRow && !('updated_at' in chargeRow), 'the charge row does NOT include updated_at');
check(chargeRow && chargeRow.status === 'SUCCESS', 'the charge row is marked SUCCESS');
check(chargeRow && chargeRow.amount === 120.25, 'the charge row carries the confirmed amount');
check(
  chargeRow && chargeRow.customer_email === 'dashboard-buyer@example.com',
  'the charge row carries the customer email'
);
check(
  chargeRow && chargeRow.merchant_name === 'Valmont Electricals',
  'the charge row carries the merchant name'
);
check(chargeRow && typeof chargeRow.paid_at === 'string', 'the charge row has a paid_at timestamp');

// THE ACTUAL BUG: does it come back out through /api/transactions?
const feed = await get('/api/transactions');
check(feed.success === true, 'GET /api/transactions succeeds');
check(feed.source === 'supabase', '/api/transactions reads from Supabase when configured');
const listed = feed.transactions.find(t => t.reference === reference);
check(Boolean(listed), 'the dashboard checkout transaction APPEARS in /api/transactions');
check(listed && listed.status === 'SUCCESS', 'it is listed as SUCCESS');
check(listed && listed.amount === 120.25, 'it is listed with the right amount');
check(listed && listed.customer === 'dashboard-buyer@example.com', 'it is listed with the customer');
check(listed && listed.channel === 'Momo (MTN)', 'it is listed with the payment channel');
check(feed.balance === 120.25, 'the dashboard balance reflects the checkout payment');
check(feed.count >= 1, 'the dashboard no longer shows zero transactions');

// A declined charge is recorded too.
const declined = await post('/api/v1/transaction/charge', {
  reference: 'VP-DECLINED-1',
  amount: 40,
  merchant: 'Valmont Electricals',
  email: 'declined@example.com',
  channel: 'Card',
  card_number: '4084080000000409'
});
check(declined.trx_status === 'FAILED', 'a declined card is reported as FAILED');
const declinedRow = upsertedRows.find(r => r.reference === 'VP-DECLINED-1');
check(Boolean(declinedRow), 'the declined charge is persisted for the record');
check(declinedRow && declinedRow.status === 'FAILED', 'the declined row is marked FAILED');
check(declinedRow && declinedRow.paid_at === null, 'the declined row has paid_at = null');
check(
  declinedRow && !('updated_at' in declinedRow),
  'the declined row does NOT include updated_at'
);

const feedAfterDecline = await get('/api/transactions');
check(
  feedAfterDecline.balance === 120.25,
  'a declined payment never inflates the dashboard balance'
);

// A Supabase read failure must surface through the endpoint, not look empty.
nextReadResult = { data: null, error: { message: 'permission denied for table transactions' } };
const errorResponse = await fetch(base + '/api/transactions');
const errorBody = await errorResponse.json();
check(errorResponse.status === 500, '/api/transactions returns 500 on a Supabase read error');
check(errorBody.success === false, 'the error response is not dressed up as a success');
check(
  String(errorBody.message).includes('permission denied'),
  'the Supabase read error reaches the client'
);
nextReadResult = null;

// Ensure simulated checkout is blocked when PAYSTACK_SECRET_KEY is a live key
const savedPaystackKeyForCharge = process.env.PAYSTACK_SECRET_KEY;
process.env.PAYSTACK_SECRET_KEY = 'sk_live_test_key_abc';
const liveBlockedRes = await fetch(base + '/api/v1/transaction/charge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reference: 'VP-LIVE-BLOCK', amount: '50.00', channel: 'mobile_money', wallet_number: '0244123456' })
});
check(liveBlockedRes.status === 403, 'POST /api/v1/transaction/charge returns 403 in live production mode (sk_live_)');
const liveBlockedBody = await liveBlockedRes.json();
check(liveBlockedBody.status === false && liveBlockedBody.message.includes('live production mode'), 'blocked charge reports helpful live production mode error message');
if (savedPaystackKeyForCharge === undefined) delete process.env.PAYSTACK_SECRET_KEY;
else process.env.PAYSTACK_SECRET_KEY = savedPaystackKeyForCharge;

// ----------------------------------------------------- 6b. deployment health
console.log('\n# /api/health environment verification');
const savedPaystackForHealth = process.env.PAYSTACK_SECRET_KEY;
process.env.PAYSTACK_SECRET_KEY = 'sk_test_health';
const health = await get('/api/health');
check(health.required.SUPABASE_URL === true, '/api/health reports SUPABASE_URL is set');
check(
  health.required.SUPABASE_SERVICE_ROLE_KEY === true,
  '/api/health reports SUPABASE_SERVICE_ROLE_KEY is set'
);
check(health.required.PAYSTACK_SECRET_KEY === true, '/api/health reports PAYSTACK_SECRET_KEY is set');
check('WEBHOOK_SECRET' in health.optional, '/api/health lists WEBHOOK_SECRET as optional');
check(health.ok === true, '/api/health is ok when every required variable is present');
check(health.supabase.credentialType === 'service-role', '/api/health reports the credential type');
check(!JSON.stringify(health).includes('offline-checkout-service-role-key'),
  '/api/health never leaks secret VALUES');
if (savedPaystackForHealth === undefined) delete process.env.PAYSTACK_SECRET_KEY;
else process.env.PAYSTACK_SECRET_KEY = savedPaystackForHealth;

// ------------------------------------------------- 7. webhook secret fallback
console.log('\n# Webhook signing secret preference');
const { getWebhookSecret, verifySignature } = await import('../api/webhook.js');
const savedWebhookSecret = process.env.WEBHOOK_SECRET;
const savedPaystackKey = process.env.PAYSTACK_SECRET_KEY;

process.env.WEBHOOK_SECRET = 'explicit-webhook-secret';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack';
check(getWebhookSecret() === 'explicit-webhook-secret', 'WEBHOOK_SECRET is preferred');

delete process.env.WEBHOOK_SECRET;
check(
  getWebhookSecret() === 'sk_test_paystack',
  'PAYSTACK_SECRET_KEY is the fallback (Paystack signs with the secret key)'
);

const body = JSON.stringify({ event: 'charge.success', data: { reference: 'VP-SIG' } });
const paystackSignature = crypto
  .createHmac('sha512', 'sk_test_paystack')
  .update(body)
  .digest('hex');
check(
  verifySignature(Buffer.from(body), paystackSignature) === true,
  'a signature made with PAYSTACK_SECRET_KEY verifies when WEBHOOK_SECRET is unset'
);
check(
  verifySignature(Buffer.from(body + ' '), paystackSignature) === false,
  'the EXACT raw bytes are verified — a single extra byte fails'
);

delete process.env.PAYSTACK_SECRET_KEY;
check(getWebhookSecret() === '', 'no secret configured yields an empty secret');

if (savedWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
else process.env.WEBHOOK_SECRET = savedWebhookSecret;
if (savedPaystackKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
else process.env.PAYSTACK_SECRET_KEY = savedPaystackKey;

// -------------------------------------------- 8. static guard against regress
console.log('\n# Static guards');
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const path = (await import('node:path')).default;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Strip comments first: lib/transaction-store.js documents WHY updated_at is
// never written, and that explanation must not itself trip the guard.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
for (const file of ['server.js', 'api/transactions.js', 'lib/transaction-store.js', 'api/webhook.js']) {
  const code = stripComments(readFileSync(path.join(root, file), 'utf8'));
  check(
    !/updated_at/.test(code),
    `${file} never writes an updated_at field (outside of comments)`
  );
}
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8');
check(
  serverSource.includes("require('./lib/transaction-store')"),
  'server.js uses the shared transaction persistence helper'
);
check(
  !/SUPABASE_URL && process\.env\.SUPABASE_ANON_KEY/.test(serverSource),
  'server.js no longer requires SUPABASE_ANON_KEY specifically to enable Supabase'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
