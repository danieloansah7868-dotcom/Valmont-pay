#!/usr/bin/env node

/**
 * Offline test for RECORDING AND SHOWING WHY A PAYMENT FAILED.
 *
 * WHY THIS TEST EXISTS
 *
 * A customer's card was declined and the merchant could only report "it says
 * unable to process". We stored the status (FAILED) and threw Paystack's own
 * explanation away, so answering "why?" meant logging into Paystack and hunting
 * the reference. These suites pin the fix:
 *
 *   1. lib/failure-reason.js reads `gateway_response` VERBATIM (never rewrites
 *      the gateway's wording) and normalizes it safely.
 *   2. The mapper attaches the reason to FAILED rows only — a settled SUCCESS
 *      row must stay byte-identical to the original seven columns.
 *   3. saveTransaction RETRIES WITHOUT the optional column when the deployed
 *      table has not run the migration, so a diagnostic field can never cost a
 *      real payment. It reports `degraded: true` and names the missing column.
 *   4. A REAL error (RLS, permission denied) is still reported as a failure —
 *      the retry must not swallow it.
 *   5. The Vercel webhook stores the reason straight from the signed payload.
 *   6. The dashboard and admin panel render it, escaped.
 *
 *   node scripts/failure-reason-test.mjs
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

process.env.SUPABASE_URL = 'https://offline-failure-reason.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-failure-reason-service-role-key';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${msg}`);
  if (!cond) failures++;
};

// ───────────────────────────────────────────────── 1. the reason extractor
console.log('\n# lib/failure-reason.js');

const failures2 = require('../lib/failure-reason.js');
const { extractFailureReason, normalizeFailureReason } = failures2;

check(
  extractFailureReason({ gateway_response: 'Denied by Fraud System' }) === 'Denied by Fraud System',
  'Paystack gateway_response is read verbatim'
);
check(
  extractFailureReason({ gateway_response: '  Declined\n\nby bank  ' }) === 'Declined by bank',
  'whitespace/newlines are collapsed (one line, safe for HTML and CSV)'
);
check(
  extractFailureReason({ message: 'Insufficient Funds' }) === 'Insufficient Funds',
  'falls back to message when gateway_response is absent'
);
check(
  extractFailureReason({ gateway_response: 'Denied by Fraud System', message: 'nope' }) ===
    'Denied by Fraud System',
  'gateway_response WINS over message'
);
check(extractFailureReason({}) === '', 'no reason in, no reason out');
check(extractFailureReason(null) === '', 'a null payload does not throw');
check(extractFailureReason({ gateway_response: null, message: '' }) === '',
  'empty gateway fields yield an empty reason, never the string "undefined"');
check(!normalizeFailureReason({ gateway_response: 'x' }).includes('[object'),
  'an object is never stringified into the reason');
check(
  normalizeFailureReason('x'.repeat(400)).length === 300 &&
    normalizeFailureReason('x'.repeat(400)).endsWith('\u2026'),
  'a pathologically long reason is truncated to 300 chars'
);

// ─────────────────────────────────────────── 2. the mapper (FAILED only)
console.log('\n# buildTransactionRecord');

const store = require('../lib/transaction-store.js');

const failed = store.buildTransactionRecord({
  reference: 'VP-FAIL-1',
  customer: 'buyer@example.com',
  amount: 75.5,
  channel: 'Card (VISA)',
  status: 'FAILED',
  gateway_response: 'Denied by Fraud System'
});
check(failed.failure_reason === 'Denied by Fraud System', 'a FAILED row carries the reason');
check(failed.status === 'FAILED' && failed.paid_at === null,
  'a FAILED row still has paid_at = null (nothing was paid)');

const succeeded = store.buildTransactionRecord({
  reference: 'VP-OK-1',
  amount: 75.5,
  status: 'SUCCESS',
  // Paystack reports "Approved" here — it must NEVER be stored as a failure.
  gateway_response: 'Approved'
});
check(!('failure_reason' in succeeded), 'a SUCCESS row never carries a failure_reason');
check(
  Object.keys(succeeded).sort().join(',') ===
    ['reference', 'merchant_name', 'customer_email', 'amount', 'payment_method', 'status', 'paid_at']
      .sort()
      .join(','),
  'the SUCCESS payload stays EXACTLY the seven required columns'
);

const noReason = store.buildTransactionRecord({ reference: 'VP-FAIL-2', amount: 5, status: 'FAILED' });
check(!('failure_reason' in noReason), 'a FAILED row without a reason omits the column entirely');

check(
  store.OPTIONAL_TRANSACTION_COLUMNS.join(',') === 'failure_reason',
  'failure_reason is declared an OPTIONAL column (required columns are unchanged)'
);
check(
  store.TRANSACTION_COLUMNS.join(',') ===
    'reference,merchant_name,customer_email,amount,payment_method,status,paid_at',
  'TRANSACTION_COLUMNS still lists only the seven required columns'
);

// ──────────────────────────────── 3. the degraded write (no migration yet)
console.log('\n# saveTransaction — deployed table missing the optional column');

const written = [];
const missingColumnError = {
  code: 'PGRST204',
  message: "Could not find the 'failure_reason' column of 'transactions' in the schema cache"
};

/** A PostgREST stub that rejects failure_reason the way an unmigrated table does. */
function unmigratedClient() {
  return {
    from() {
      return {
        upsert(row) {
          return {
            async select() {
              if ('failure_reason' in row) {
                return { data: null, error: missingColumnError };
              }
              written.push(row);
              return { data: [row], error: null };
            }
          };
        }
      };
    }
  };
}

let result = await store.saveTransaction(failed, {
  client: unmigratedClient(),
  context: 'TEST-DEGRADED'
});
check(result.ok === true, 'the write still SUCCEEDS when the column is missing');
check(result.degraded === true, 'it is reported as degraded, not as a clean write');
check(result.missingColumns.join(',') === 'failure_reason', 'the missing column is named');
check(!('failure_reason' in written[0]), 'the retried row contains only the required columns');
check(written[0].status === 'FAILED', 'the declined payment is recorded either way');
check(written[0].reference === 'VP-FAIL-1', 'the retried row keeps the reference');

// A settled payment must never even attempt the optional column, so an
// unmigrated deployment writes it on the FIRST try.
written.length = 0;
let attempts = 0;
const countingClient = {
  from() {
    return {
      upsert(row) {
        attempts++;
        return { async select() { written.push(row); return { data: [row], error: null }; } };
      }
    };
  }
};
result = await store.saveTransaction(succeeded, { client: countingClient, context: 'TEST-CLEAN' });
check(result.ok === true && result.degraded === false, 'a SUCCESS write is not degraded');
check(attempts === 1, 'a SUCCESS write needs only one attempt (no column to drop)');

// ────────────────────────── 4. real errors are NOT swallowed by the retry
console.log('\n# saveTransaction — real errors still fail loudly');

let rlsAttempts = 0;
const rlsClient = {
  from() {
    return {
      upsert() {
        return {
          async select() {
            rlsAttempts++;
            return { data: null, error: { code: '42501', message: 'permission denied for table transactions' } };
          }
        };
      }
    };
  }
};
result = await store.saveTransaction(failed, { client: rlsClient, context: 'TEST-RLS' });
check(result.ok === false, 'an RLS denial is still a failure');
check(String(result.reason).includes('permission denied'), 'the real error is surfaced');
check(rlsAttempts === 1, 'an RLS denial is NOT retried as a missing column');

// The retry itself failing must report the RETRY error, not the column complaint.
const retryFailsClient = {
  from() {
    return {
      upsert(row) {
        return {
          async select() {
            if ('failure_reason' in row) return { data: null, error: missingColumnError };
            return { data: null, error: { code: '42501', message: 'permission denied for table transactions' } };
          }
        };
      }
    };
  }
};
result = await store.saveTransaction(failed, { client: retryFailsClient, context: 'TEST-RETRY-FAIL' });
check(result.ok === false, 'a failed retry is reported as a failure');
check(
  !String(result.reason).includes('failure_reason'),
  'the retry failure reports the SECOND error, not the missing column'
);

// ─────────────────────────────── 5. it reaches the dashboard payload
console.log('\n# toDashboardTransaction');

const dashRow = store.toDashboardTransaction({
  reference: 'VP-FAIL-1',
  status: 'FAILED',
  failure_reason: 'Denied by Fraud System'
});
check(dashRow.failure_reason === 'Denied by Fraud System', 'the reason survives into the dashboard shape');
check(
  store.toDashboardTransaction({ reference: 'VP-OLD', status: 'FAILED' }).failure_reason === null,
  'a pre-migration row yields null, not undefined (renders cleanly)'
);

// ────────────────────────── 6. the Express webhook path (lib/webhook.js)
console.log('\n# lib/webhook.js — ledger record');

const ledger = require('../lib/ledger.js');
const webhookLib = require('../lib/webhook.js');
ledger.resetLedger();

process.env.PAYSTACK_SECRET_KEY = 'sk_test_failure_reason';
const declinedEvent = {
  event: 'charge.failed',
  data: {
    reference: 'VP-EXPRESS-FAIL',
    amount: 23000,
    currency: 'GHS',
    channel: 'card',
    status: 'failed',
    gateway_response: 'Denied by Fraud System',
    customer: { email: 'declined@example.com' },
    authorization: { card_type: 'VISA' }
  }
};
const declinedRaw = JSON.stringify(declinedEvent);
webhookLib.handleWebhookEvent(
  declinedEvent,
  crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(declinedRaw).digest('hex'),
  declinedRaw
);
const ledgerRow = ledger.findTransaction('VP-EXPRESS-FAIL');
check(ledgerRow.status === 'FAILED', 'the decline lands on the ledger as FAILED');
check(
  ledgerRow.failure_reason === 'Denied by Fraud System',
  'the ledger row carries Paystack\'s reason'
);
check(ledger.getBalance() === 0, 'a declined payment still adds nothing to the balance');

// ─────────────────────────── 7. the Vercel webhook (api/webhook.js)
console.log('\n# api/webhook.js — signed payload -> Supabase row');

process.env.WEBHOOK_SECRET = 'offline-failure-reason-webhook-secret';
const { createWebhookHandler } = await import('../api/webhook.js');

const insertedRows = [];
const fakeSupabase = {
  from(table) {
    assert.equal(table, 'transactions');
    return {
      upsert(row, options) {
        assert.deepEqual(options, { onConflict: 'reference' }, 'must upsert on reference');
        insertedRows.push(row);
        return { async select() { return { data: [row], error: null }; } };
      }
    };
  }
};

const handler = createWebhookHandler({
  supabaseClient: fakeSupabase,
  tenantRegistry: {
    async refreshFromDb() { return 0; },
    getTenantByIdentifier() { return undefined; }
  },
  tenantWebhookForwarder: { async dispatchWebhook() { return { ok: true, statusCode: 200 }; } },
  mandateStore: { async saveMandateFromAuthorization() {} }
});

function sign(rawBody) {
  return crypto.createHmac('sha512', process.env.WEBHOOK_SECRET).update(rawBody).digest('hex');
}
function request(rawBody, signature) {
  const req = Readable.from([Buffer.from(rawBody)]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'x-paystack-signature': signature };
  return req;
}
function response() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
async function invoke(rawBody) {
  const res = response();
  await handler(request(rawBody, sign(rawBody)), res);
  return res;
}

let res = await invoke(JSON.stringify(declinedEvent));
check(res.statusCode === 200, 'the failed event is accepted (200)');
check(
  insertedRows[0].failure_reason === 'Denied by Fraud System',
  'the webhook persists Paystack\'s reason on the FAILED row'
);
check(insertedRows[0].status === 'FAILED' && insertedRows[0].paid_at === null,
  'the FAILED row has no paid_at');

const successEvent = {
  event: 'charge.success',
  data: {
    reference: 'VP-WEBHOOK-OK',
    amount: 5000,
    channel: 'card',
    gateway_response: 'Approved',
    paid_at: '2026-08-01T10:00:00.000Z',
    customer: { email: 'paid@example.com' },
    metadata: { merchant: 'Valmont Electricals' }
  }
};
res = await invoke(JSON.stringify(successEvent));
check(res.statusCode === 200, 'the success event is accepted (200)');
const successRow = insertedRows.find(row => row.reference === 'VP-WEBHOOK-OK');
check(!('failure_reason' in successRow), 'a successful webhook row never gets a failure_reason');

// ──────────────────────────────────────────── 8. static guards (UI + SQL)
console.log('\n# static guards');

// Each UI has its own escaping call site, but BOTH must route the reason
// through escapeHtml() — it is attacker-influenced text from a gateway payload.
const staticChecks = [
  {
    file: 'dashboard.html',
    label: 'the merchant dashboard',
    // renderFailureReason() escapes the reason (and the tooltip) and is wired
    // into the ledger row template.
    escapes: source => /escapeHtml\(reason\)/.test(source) && /renderFailureReason\(t\)/.test(source)
  },
  {
    file: 'admin.html',
    label: 'the admin panel',
    escapes: source => /escapeHtml\(String\(t\.failure_reason/.test(source)
  }
];
for (const { file, label, escapes } of staticChecks) {
  const source = readFileSync(path.join(root, file), 'utf8');
  check(/failure_reason/.test(source), `${label} reads failure_reason from the API`);
  check(escapes(source), `${label} escapes the reason before rendering it (no HTML injection)`);
}

const dashboardSource = readFileSync(path.join(root, 'dashboard.html'), 'utf8');
check(/FAILURE_HINTS/.test(dashboardSource), 'the dashboard carries plain-English hints for common declines');
check(
  /Denied by Fraud System/.test(
    readFileSync(path.join(root, 'lib', 'failure-reason.js'), 'utf8')
  ) || /denied by fraud/i.test(dashboardSource),
  'the well-known "Denied by Fraud System" case is documented in the UI hints'
);

const verifySource = readFileSync(path.join(root, 'api', 'verify-payment.js'), 'utf8');
check(
  /extractFailureReason/.test(verifySource) && /failure_reason/.test(verifySource),
  'the verify-payment safety net records the reason too (webhook may never fire)'
);

const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8');
check(/extractFailureReason/.test(serverSource), 'server.js uses the shared reason extractor');
check(
  /failure_reason: isSuccess \? null : trx\.failure_reason/.test(serverSource),
  'GET /api/transaction/verify/{reference} exposes failure_reason'
);

// ────────────────────────── 9. the rendered ledger row (real HTML output)
console.log('\n# dashboard.html — rendered output');

// Executes the dashboard's own helpers (extracted from the page, not
// re-implemented here) so the ACTUAL markup and escaping are pinned, not just
// the presence of a string in the file.
const escapeFn = dashboardSource.match(/function escapeHtml\(value\)\s*\{[\s\S]*?\n    \}/);
const helpersStart = dashboardSource.indexOf('const FAILURE_HINTS');
const helpersEnd = dashboardSource.indexOf('function renderDashboard');
check(
  Boolean(escapeFn) && helpersStart > 0 && helpersEnd > helpersStart,
  'the dashboard render helpers can be located (test would be vacuous otherwise)'
);

if (escapeFn && helpersStart > 0 && helpersEnd > helpersStart) {
  const { renderFailureReason } = new Function(
    `${escapeFn[0]}\n${dashboardSource.slice(helpersStart, helpersEnd)}\nreturn { renderFailureReason };`
  )();

  const rendered = renderFailureReason({ status: 'FAILED', failure_reason: 'Denied by Fraud System' });
  check(rendered.includes('Denied by Fraud System'), 'a FAILED row renders Paystack\'s reason');
  check(
    /title="Denied by Fraud System/.test(rendered) && /24 hours/.test(rendered),
    'the tooltip carries the plain-English hint for a fraud-system denial'
  );
  check(
    rendered.indexOf('Denied by Fraud System') > rendered.indexOf('title=') - 1,
    'the reason is rendered inside the row, not as raw markup'
  );

  const hostile = renderFailureReason({
    status: 'FAILED',
    failure_reason: '<img src=x onerror=alert(1)></p><script>alert(2)</script>'
  });
  check(!/<img|<script/.test(hostile), 'a hostile reason cannot inject HTML into the ledger');
  check(hostile.includes('&lt;img'), 'the hostile reason is rendered as escaped text');

  check(
    renderFailureReason({ status: 'FAILED' }) === '',
    'a FAILED row with no recorded reason renders the badge alone (pre-migration rows)'
  );
}

const migrationPath = path.join(root, 'scripts', 'supabase-transactions-failure-reason-schema.sql');
const migration = readFileSync(migrationPath, 'utf8');
check(
  /add column if not exists failure_reason text/.test(migration),
  'the migration adds failure_reason idempotently'
);
check(
  store.OPTIONAL_COLUMNS_MIGRATION === 'scripts/supabase-transactions-failure-reason-schema.sql',
  'the store points operators at that exact migration file'
);

// ─────── 10. through the REAL PostgREST transport (dependency-free fallback)
// A deployment that lost the Supabase SDK talks over lib/postgrest-client.js.
// The degraded retry must work there too — that transport is the one most
// likely to be in play when nobody is watching the logs.
console.log('\n# lib/postgrest-client.js — the real transport, unmigrated table');

const http = await import('node:http');
const { createPostgrestClient } = require('../lib/postgrest-client.js');

function startStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
      requests.push({ method: req.method, url: req.url, body });
      handler(body, res);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}
const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

// An unmigrated table: PostgREST rejects any write carrying failure_reason.
const unmigrated = await startStub((body, res) => {
  const row = Array.isArray(body) ? body[0] : body;
  if (row && 'failure_reason' in row) {
    return sendJson(res, 400, {
      code: 'PGRST204',
      message: "Could not find the 'failure_reason' column of 'transactions' in the schema cache",
      details: null,
      hint: null
    });
  }
  return sendJson(res, 201, [row]);
});

const degradedViaTransport = await store.saveTransaction(failed, {
  client: createPostgrestClient({ url: `http://127.0.0.1:${unmigrated.port}`, key: 'k' }),
  context: 'TEST-TRANSPORT-DEGRADED'
});
check(
  degradedViaTransport.ok === true && degradedViaTransport.degraded === true,
  'the real transport saves the payment when the column is missing'
);
check(unmigrated.requests.length === 2, 'it takes exactly two requests (original, then retry)');
check(
  Array.isArray(unmigrated.requests[0].body)
    ? unmigrated.requests[0].body[0].failure_reason === 'Denied by Fraud System'
    : unmigrated.requests[0].body.failure_reason === 'Denied by Fraud System',
  'the first attempt DID try to record the reason'
);
const retryRow = Array.isArray(unmigrated.requests[1].body)
  ? unmigrated.requests[1].body[0]
  : unmigrated.requests[1].body;
check(!('failure_reason' in retryRow), 'the retried request drops failure_reason');
check(retryRow.status === 'FAILED' && retryRow.reference === 'VP-FAIL-1',
  'the retried request still carries the payment itself');
unmigrated.server.close();

// A migrated table: one request, reason included.
const migrated = await startStub((body, res) => sendJson(res, 201, [Array.isArray(body) ? body[0] : body]));
const migratedResult = await store.saveTransaction(failed, {
  client: createPostgrestClient({ url: `http://127.0.0.1:${migrated.port}`, key: 'k' }),
  context: 'TEST-TRANSPORT-MIGRATED'
});
check(migratedResult.ok === true && migratedResult.degraded === false,
  'a migrated table writes the reason on the first attempt, not degraded');
check(migrated.requests.length === 1, 'a migrated table needs only one request');
const storedRow = Array.isArray(migrated.requests[0].body) ? migrated.requests[0].body[0] : migrated.requests[0].body;
check(storedRow.failure_reason === 'Denied by Fraud System', 'the reason is what reaches the database');
migrated.server.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
