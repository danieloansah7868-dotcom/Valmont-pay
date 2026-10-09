#!/usr/bin/env node
/**
 * Regression test for the dependency-free Supabase transport.
 *
 * WHY THIS TEST EXISTS
 *
 * On 2026-10-09 the deployed gateway had every Supabase environment variable
 * set — /api/health even reported ok:true — yet the dashboard rendered an
 * empty ledger with GH₵0.00. The cause: `require('@supabase/supabase-js')`
 * failed inside the serverless bundle, `getSupabaseClient()` returned null,
 * `GET /api/transactions` answered 500, and dashboard.html swallowed the error
 * and painted "no transactions yet". A real GH₵55.00 ledger looked like it
 * had been wiped.
 *
 * This suite pins the three behaviours that must never regress:
 *
 *   1. lib/postgrest-client.js speaks enough PostgREST for every query this
 *      codebase issues (select/order/limit/eq/in, upsert+onConflict+select,
 *      insert, update, delete, single, maybeSingle, head+count).
 *   2. When the SDK is MISSING, lib/supabase.js still returns a working
 *      client — via the fallback — instead of null (proved in a child process
 *      that makes the require throw).
 *   3. lib/transaction-store.js (the dashboard's own read/write path) round
 *      trips a transaction through that fallback client.
 *
 *   node scripts/postgrest-fallback-test.mjs
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${msg}`);
  if (!cond) failures++;
};

/**
 * A tiny PostgREST stand-in: records every request so the test can assert the
 * exact query the fallback produced, and replays canned responses.
 */
function startPostgrestStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      const entry = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body: raw ? raw : null
      };
      requests.push(entry);
      handler(entry, res, url);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

// ─────────────────────────────────────────────── 1. the client, unit-tested
console.log('\n# PostgREST fallback — query surface');

const rows = [
  { reference: 'VP-A', merchant_name: 'Valmont Electricals', amount: 23, status: 'SUCCESS', paid_at: '2026-08-03T09:09:12.000Z' },
  { reference: 'VP-B', merchant_name: 'Valmont Electricals', amount: 32, status: 'PENDING', paid_at: null }
];

const stub = await startPostgrestStub((entry, res) => {
  if (entry.method === 'GET' && entry.path === '/rest/v1/transactions') {
    return json(res, 200, rows, { 'content-range': '0-1/2' });
  }
  if (entry.method === 'HEAD') {
    return json(res, 200, null, { 'content-range': '0-24/25' });
  }
  if (entry.method === 'POST') {
    return json(res, 201, [{ reference: 'VP-A', amount: 23, status: 'SUCCESS' }]);
  }
  if (entry.method === 'PATCH') return json(res, 200, [rows[0]]);
  if (entry.method === 'DELETE') return json(res, 204, null);
  return json(res, 404, { message: 'relation "public.unknown" does not exist', code: '42P01' });
});

const { createPostgrestClient } = require(path.join(root, 'lib/postgrest-client.js'));
const client = createPostgrestClient({
  url: `http://127.0.0.1:${stub.port}`,
  key: 'service-role-key',
  timeoutMs: 5000
});

check(typeof client.from === 'function', 'the fallback exposes .from(table)');
check(client.transport === 'rest-fallback', 'the fallback reports its transport');

// select + order + limit
const list = await client.from('transactions').select('*').order('created_at', { ascending: false }).limit(50);
check(list.error === null, 'select() resolves without an error');
check(Array.isArray(list.data) && list.data.length === 2, 'select() returns the parsed rows');
check(stub.requests[0].query.order === 'created_at.desc', 'order(ascending:false) becomes order=created_at.desc');
check(stub.requests[0].query.limit === '50', 'limit(n) becomes limit=n');
check(stub.requests[0].query.select === '*', 'select("*") becomes select=*');
check(stub.requests[0].headers.authorization === 'Bearer service-role-key',
  'every request carries the API key as a bearer token');
check(stub.requests[0].headers.apikey === 'service-role-key',
  'every request carries the apikey header PostgREST expects');

// eq + in filters
await client.from('transactions').select('reference').eq('reference', 'VP-A');
check(stub.requests[1].query.reference === 'eq.VP-A', 'eq(col, val) becomes col=eq.val');
await client.from('transactions').select('reference').in('reference', ['VP-A', 'VP-B']);
check(stub.requests[2].query.reference === 'in.(VP-A,VP-B)', 'in(col, [a,b]) becomes col=in.(a,b)');

// upsert with a conflict target, returning the row
const upsert = await client.from('transactions').upsert(rows[0], { onConflict: 'reference' }).select();
check(stub.requests[3].method === 'POST', 'upsert() issues POST');
check(stub.requests[3].query.on_conflict === 'reference', 'upsert() sends on_conflict=reference');
check(/resolution=merge-duplicates/.test(stub.requests[3].headers.prefer || ''),
  'upsert() sends Prefer: resolution=merge-duplicates');
check(/return=representation/.test(stub.requests[3].headers.prefer || ''),
  'upsert().select() sends Prefer: return=representation');
check(Array.isArray(upsert.data) && upsert.data[0] && upsert.data[0].reference === 'VP-A',
  'upsert().select() returns the written rows (same array shape as the SDK)');

// update / delete
await client.from('transactions').update({ status: 'PAID' }).eq('reference', 'VP-A').select();
check(stub.requests[4].method === 'PATCH', 'update() issues PATCH');
check(stub.requests[4].query.reference === 'eq.VP-A', 'update() keeps its filter');
await client.from('transactions').delete().eq('reference', 'VP-A');
check(stub.requests[5].method === 'DELETE', 'delete() issues DELETE');
check(!/return=representation/.test(stub.requests[5].headers.prefer || ''),
  'a write without .select() does not ask for a representation');

// head + count (what /api/webhook-debug uses for its connectivity probe)
const counted = await client.from('transactions').select('*', { count: 'exact', head: true });
check(stub.requests[6].method === 'HEAD', 'select({ head: true }) issues HEAD');
check(counted.count === 25, 'count=exact is parsed out of the Content-Range header');
check(counted.error === null, 'a healthy HEAD reports no error');

stub.server.close();

// ─────────────────────────────────────────────── single() / maybeSingle()
console.log('\n# PostgREST fallback — single() and errors');

const emptyStub = await startPostgrestStub((entry, res) => json(res, 200, []));
const emptyClient = createPostgrestClient({ url: `http://127.0.0.1:${emptyStub.port}`, key: 'k' });

const missing = await emptyClient.from('transactions').select('*').eq('reference', 'nope').single();
check(missing.data === null, 'single() on 0 rows returns null data');
check(missing.error && missing.error.code === 'PGRST116',
  'single() on 0 rows raises PGRST116 (what payment-link-store treats as a plain miss)');
check(/JSON object requested/.test(missing.error.message),
  'the PGRST116 message matches PostgREST wording, so existing error checks still fire');

const maybe = await emptyClient.from('tenants').select('key').eq('key', 'nope').maybeSingle();
check(maybe.data === null && maybe.error === null, 'maybeSingle() on 0 rows is data:null, no error');
emptyStub.server.close();

const errorStub = await startPostgrestStub((entry, res) => json(res, 404, {
  message: 'relation "public.payment_links" does not exist',
  code: '42P01',
  details: null,
  hint: null
}));
const errorClient = createPostgrestClient({ url: `http://127.0.0.1:${errorStub.port}`, key: 'k' });
const failed = await errorClient.from('payment_links').select('*');
check(failed.error && failed.error.code === '42P01',
  'a PostgREST error is surfaced with its code (42P01 → "table missing" checks still work)');
check(failed.data === null, 'a failed read returns null data, never an empty array');
errorStub.server.close();

// ──────────────────────────────────── 2. the ledger path through the fallback
console.log('\n# lib/transaction-store round trip over the fallback transport');

let upsertBody = null;
const storeStub = await startPostgrestStub((entry, res) => {
  if (entry.method === 'POST') {
    upsertBody = JSON.parse(entry.body);
    return json(res, 201, [{ ...upsertBody }]);
  }
  return json(res, 200, [{
    reference: 'VP-55',
    merchant_name: 'Valmont Electricals',
    customer_email: 'buyer@example.com',
    amount: 55,
    payment_method: 'mobile_money',
    status: 'SUCCESS',
    paid_at: '2026-08-04T10:01:15.000Z'
  }]);
});

// The store gates on the environment being configured even when a client is
// injected, so stand up dummy credentials (the injected client is what serves
// the requests — nothing here touches a real database).
process.env.SUPABASE_URL = 'https://fallback-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fallback-test-service-role-key';
const transactionStore = require(path.join(root, 'lib/transaction-store.js'));
const fallbackForStore = createPostgrestClient({ url: `http://127.0.0.1:${storeStub.port}`, key: 'k' });

const saved = await transactionStore.saveTransaction(
  { reference: 'VP-55', merchant: 'Valmont Electricals', customer: 'buyer@example.com', amount: 55, channel: 'mobile_money', status: 'SUCCESS' },
  { client: fallbackForStore, context: 'FALLBACK-TEST' }
);
check(saved.ok === true, 'saveTransaction() succeeds through the fallback client');
check(upsertBody && upsertBody.amount === 55 && upsertBody.status === 'SUCCESS',
  'the fallback sends the seven-column record (amount in cedis, status upper-cased)');

const read = await transactionStore.fetchTransactions({ client: fallbackForStore, context: 'FALLBACK-TEST' });
check(read.ok === true, 'fetchTransactions() succeeds through the fallback client');
check(read.transactions.length === 1 && read.transactions[0].reference === 'VP-55',
  'the dashboard row shape (reference/merchant/customer/amount/channel/status) comes back');
check(transactionStore.calculateBalance(read.transactions) === 55,
  'the balance derived from a fallback read is GH₵55.00 — the exact figure that went missing');
storeStub.server.close();

// ──────────────────────────── 3. lib/supabase.js falls back when the SDK is gone
console.log('\n# lib/supabase.js — the SDK is missing from the bundle');

// A child process with a Module._load hook that makes the require throw, which
// is exactly what a deployment with a broken bundle does.
const childSource = `
const Module = require('module');
const original = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@supabase/supabase-js') {
    const error = new Error("Cannot find module '@supabase/supabase-js'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return original.call(this, request, ...rest);
};
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key';
const supabase = require(${JSON.stringify(path.join(root, 'lib/supabase.js'))});
const client = supabase.getSupabaseClient();
const diagnostics = supabase.clientDiagnostics();
process.stdout.write(JSON.stringify({
  hasClient: Boolean(client),
  fromIsFunction: Boolean(client) && typeof client.from === 'function',
  transport: diagnostics.transport,
  clientReady: diagnostics.clientReady,
  configured: diagnostics.configured
}));
`;
const childFile = path.join(mkdtempSync(path.join(tmpdir(), 'vp-')), 'missing-sdk.cjs');
writeFileSync(childFile, childSource);
const childOutput = execFileSync(process.execPath, [childFile], { encoding: 'utf8' });
const child = JSON.parse(childOutput);

check(child.hasClient === true,
  'a deployment WITHOUT @supabase/supabase-js still gets a client instead of null');
check(child.fromIsFunction === true, 'the fallback client exposes .from()');
check(child.transport === 'rest-fallback', 'the diagnostics report transport=rest-fallback');
check(child.clientReady === true, 'clientReady is true, so /api/health no longer reports a broken deployment as ok');
check(child.configured === true, 'the environment is still reported as configured');

// ────────────────────────────────────────────── 4. the dashboard says so too
console.log('\n# dashboard.html — a failed read is never an empty ledger');

const dashboardHtml = readFileSync(path.join(root, 'dashboard.html'), 'utf8');
check(dashboardHtml.includes('id="ledgerErrorBanner"'),
  'dashboard.html has a ledger error banner');
check(/showLedgerError\(/.test(dashboardHtml),
  'a non-OK /api/transactions response calls showLedgerError()');
check(dashboardHtml.includes("'GH\\u20b5 —'"),
  'a failed read shows GH₵ — instead of a confident GH₵0.00');
check(/ledgerLoadFailed/.test(dashboardHtml),
  'renderDashboard() keeps the unavailable state instead of rendering an empty ledger');

const serverJs = readFileSync(path.join(root, 'server.js'), 'utf8');
check(/supabase:\s*\{[^}]*transport/.test(serverJs),
  '/api/health reports which Supabase transport answered');
check(/supabase\.configured && !clientReady/.test(serverJs),
  '/api/health fails (503) when Supabase is configured but no client could be built');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
