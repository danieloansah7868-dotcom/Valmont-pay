/**
 * End-to-end test for the dashboard ledger.
 *
 * Proves that:
 *   1. The ledger starts EMPTY and the balance is exactly 0 (no test data).
 *   2. /api/transactions exists and returns the live ledger.
 *   3. dashboard.html contains no hardcoded transactions or balance.
 *   4. A real payment (charge, and Paystack webhook) shows up on the dashboard.
 *   5. The balance is derived from SUCCESSFUL transactions only.
 *   6. Webhook signatures are verified.
 *
 *   node scripts/dashboard-ledger-test.mjs
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// This suite deliberately exercises the empty in-memory ledger. CI provides
// Supabase secrets for the persistence-specific suites that run afterwards, so
// remove them before loading server.js to prevent live reads or writes here.
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${msg}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- static files
const dashboardHtml = readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const serverJs = readFileSync(path.join(root, 'server.js'), 'utf8');

console.log('\n# Static checks (no hardcoded test data)');
for (const ref of ['VP-849201', 'VP-582910', 'VP-128491']) {
  check(!dashboardHtml.includes(ref), `dashboard.html no longer contains ${ref}`);
  check(!serverJs.includes(ref), `server.js no longer contains ${ref}`);
}
check(!dashboardHtml.includes('12,450') && !dashboardHtml.includes('12450'),
  'dashboard.html no longer contains the hardcoded GH\u20b5 12,450.00 balance');
check(!serverJs.includes('12450'), 'server.js no longer seeds a 12450 starting balance');
check(/let transactions = \[\];/.test(dashboardHtml),
  'dashboard.html declares an empty transactions array: let transactions = [];');
check(dashboardHtml.includes('No transactions yet. Real payments will appear here.'),
  'dashboard.html shows "No transactions yet. Real payments will appear here."');
check(dashboardHtml.includes("fetch('/api/transactions'"),
  'dashboard.html fetches real transactions from /api/transactions');
check(serverJs.includes("app.get('/api/transactions'"), 'server.js exposes GET /api/transactions');
check(serverJs.includes("app.post('/api/webhook'"), 'server.js exposes POST /api/webhook');

// ---------------------------------------------------------------- ledger unit
console.log('\n# Ledger module');
const ledger = require('../lib/ledger.js');
const webhook = require('../lib/webhook.js');
ledger.resetLedger();

check(ledger.listTransactions().length === 0, 'ledger starts empty');
check(ledger.getBalance() === 0, 'balance of an empty ledger is exactly 0');

ledger.addTransaction({ reference: 'VP-1', customer: 'a@b.com', amount: 100, status: 'PENDING' });
check(ledger.getBalance() === 0, 'a PENDING transaction does not count towards the balance');

ledger.upsertTransaction({ reference: 'VP-1', status: 'SUCCESS' });
check(ledger.getBalance() === 100, 'a SUCCESS transaction adds to the balance');

ledger.addTransaction({ reference: 'VP-2', customer: 'c@d.com', amount: 50, status: 'FAILED' });
check(ledger.getBalance() === 100, 'a FAILED transaction does not add to the balance');

ledger.addTransaction({ reference: 'VP-3', customer: 'e@f.com', amount: 0.1, status: 'SUCCESS' });
ledger.addTransaction({ reference: 'VP-4', customer: 'g@h.com', amount: 0.2, status: 'SUCCESS' });
check(ledger.getBalance() === 100.3, 'balance sums cleanly to 2dp (0.1 + 0.2 = 0.3, not 0.30000000000000004)');
check(ledger.listTransactions().length === 4, 'ledger holds every transaction, successful or not');

// ---------------------------------------------------------------- webhook unit
console.log('\n# Webhook signature verification');
ledger.resetLedger();
const secret = 'sk_test_secret';
process.env.PAYSTACK_SECRET_KEY = secret;

const event = {
  event: 'charge.success',
  data: {
    reference: 'VP-REAL-1',
    amount: 25000, // pesewas
    currency: 'GHS',
    channel: 'mobile_money',
    status: 'success',
    paid_at: '2026-07-25T12:00:00Z',
    customer: { email: 'real@customer.com' },
    authorization: { bank: 'MTN' },
    metadata: { merchant: 'Valmont Electricals' }
  }
};
const raw = JSON.stringify(event);
const sign = body => crypto.createHmac('sha512', secret).update(body).digest('hex');

let out = webhook.handleWebhookEvent(event, 'not-a-real-signature', raw);
check(out.statusCode === 401, 'webhook with a bad signature is rejected with 401');
check(ledger.listTransactions().length === 0, 'a rejected webhook writes nothing to the ledger');

out = webhook.handleWebhookEvent(event, sign(raw), raw);
check(out.statusCode === 200, 'webhook with a valid signature returns 200');
check(ledger.listTransactions().length === 1, 'a real payment lands on the ledger');
check(ledger.getBalance() === 250, 'webhook converts 25000 pesewas to GH\u20b5 250 in the balance');
check(ledger.listTransactions()[0].channel === 'Mobile Money (MTN)', 'channel is humanised for the dashboard');
check(ledger.listTransactions()[0].customer === 'real@customer.com', 'customer email is captured');

webhook.handleWebhookEvent(event, sign(raw), raw);
check(ledger.listTransactions().length === 1, 'a replayed webhook is idempotent (no duplicate row)');
check(ledger.getBalance() === 250, 'a replayed webhook does not double-count the balance');

const failedRaw = JSON.stringify({ ...event, event: 'charge.failed', data: { ...event.data, reference: 'VP-REAL-2', status: 'failed' } });
out = webhook.handleWebhookEvent(JSON.parse(failedRaw), sign(failedRaw), failedRaw);
check(out.statusCode === 200 && ledger.getBalance() === 250, 'a failed payment is logged but never added to the balance');

// ---------------------------------------------------------------- HTTP e2e
console.log('\n# Live HTTP end-to-end');
delete process.env.PAYSTACK_SECRET_KEY; // charge flow needs no Paystack key
ledger.resetLedger();

process.env.PORT = '4321';
await import('../server.js');
await new Promise(r => setTimeout(r, 400));
const base = 'http://127.0.0.1:4321';
const get = async url => (await fetch(base + url)).json();
const post = async (url, body) =>
  (await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })).json();

let snapshot = await get('/api/transactions');
check(Array.isArray(snapshot.transactions) && snapshot.transactions.length === 0,
  'GET /api/transactions returns an empty array on a fresh gateway');
check(snapshot.balance === 0, 'GET /api/transactions reports balance 0 on a fresh gateway');

const init = await post('/api/v1/transaction/initialize', {
  email: 'buyer@example.com',
  amount: 75.5,
  merchant: 'Valmont Electricals'
});
const reference = init.data.reference;
snapshot = await get('/api/transactions');
check(snapshot.transactions.length === 1 && snapshot.transactions[0].status === 'PENDING',
  'an initialized payment appears as PENDING');
check(snapshot.balance === 0, 'a PENDING payment leaves the balance at 0');

const charge = await post('/api/v1/transaction/charge', {
  reference,
  channel: 'Mobile Money (MTN)',
  wallet_number: '0000000000',
  amount: 75.5
});
check(charge.trx_status === 'SUCCESS', 'a valid charge clears');

snapshot = await get('/api/transactions');
check(snapshot.transactions.length === 1, 'the real transaction is on the dashboard ledger');
check(snapshot.transactions[0].reference === reference, 'the ledger row carries the real reference');
check(snapshot.balance === 75.5, 'the balance is calculated from the real successful payment');

const legacy = await get('/api/v1/merchant/dashboard');
check(legacy.data.balance === 75.5 && legacy.data.transactions.length === 1,
  'the legacy dashboard endpoint reads from the same single ledger');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
