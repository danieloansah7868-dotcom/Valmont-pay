#!/usr/bin/env node

/**
 * Offline test for the audit fixes:
 *   - lib/payment-link-store.js — durable payment links (row mapping,
 *     persist/resolve contracts, expiry, memory↔supabase layering).
 *   - lib/base-url.js — host-first public URL derivation with an allowlist
 *     (the fix that keeps stale PUBLIC_BASE_URL from breaking links).
 *   - lib/admin-auth.js — X-Admin-Key enforcement posture.
 *
 * Supabase is replaced with a tiny in-memory stub client — no network, no
 * credentials needed.
 *
 *   node scripts/payment-link-store-test.mjs
 */

import assert from 'node:assert/strict';

const linkStore = (await import('../lib/payment-link-store.js')).default;
const baseUrl = (await import('../lib/base-url.js')).default;
const adminAuth = (await import('../lib/admin-auth.js')).default;
const accessCodeStore = (await import('../lib/access-code-store.js')).default;

const {
  paymentToRow,
  rowToPayment,
  persistPaymentLink,
  resolvePaymentLink,
  linkTtlMs,
  DEFAULT_LINK_TTL_HOURS
} = linkStore;

// ─── In-memory Supabase stub ────────────────────────────────────────────────
function makeStubClient() {
  const table = new Map();
  const calls = [];
  return {
    table,
    calls,
    from(name) {
      return {
        async upsert(row, opts) {
          calls.push({ op: 'upsert', name, row, opts });
          table.set(row.access_code, row);
          return { data: row, error: null };
        },
        select() {
          const filters = [];
          return {
            eq(column, value) {
              filters.push([column, value]);
              return this;
            },
            async single() {
              const row = [...table.values()].find(r =>
                filters.every(([c, v]) => r[c] === v)
              );
              if (!row) {
                return { data: null, error: { code: 'PGRST116', message: '0 rows' } };
              }
              return { data: row, error: null };
            }
          };
        }
      };
    }
  };
}

const SAMPLE_PAYMENT = {
  amount: 150.25,
  reference: 'VP-TEST-1',
  currency: 'GHS',
  email: 'client@example.com',
  phone: '0244000000',
  callback_url: '',
  tenant_key: 'valmont-electricals',
  merchant_display_name: 'Valmont Electricals',
  merchant_brand_color: '#f68b1e',
  merchant_logo_url: '/logo.svg',
  paystack_authorization_url: '',
  paystack_access_code: ''
};

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log('  ✓', label);
}

console.log('\n# lib/payment-link-store.js');

// Row mapping: whitelist columns, 2dp rounding, expiry derived from TTL.
{
  const now = new Date().toISOString();
  const row = paymentToRow('ac_test123', SAMPLE_PAYMENT, 3600_000, now);
  check(row.access_code === 'ac_test123', 'row carries the access code');
  check(row.amount === 150.25, 'amount kept in cedis (2dp)');
  check(row.status === 'PENDING', 'rows start PENDING');
  check(!('evil_column' in row), 'unknown columns are excluded');
  check(Date.parse(row.expires_at) - Date.parse(row.created_at) === 3600_000, 'expiry = created + ttl');
  const payment = rowToPayment(row);
  check(payment.reference === 'VP-TEST-1' && Number(payment.amount) === 150.25, 'rowToPayment round-trips');
  check(paymentToRow('ac_x', { ...SAMPLE_PAYMENT, amount: -5 }, 1000, now) === null, 'non-positive amounts are refused');
  check(paymentToRow('', SAMPLE_PAYMENT, 1000, now) === null, 'missing access code is refused');
}

// Persist: durable on stub client; never throws.
{
  const stub = makeStubClient();
  const result = await persistPaymentLink({
    accessCode: 'ac_persist1',
    payment: SAMPLE_PAYMENT,
    ttlMs: linkTtlMs(),
    client: stub
  });
  check(result.ok && result.durable, 'persist succeeds against Supabase');
  check(stub.table.get('ac_persist1').reference === 'VP-TEST-1', 'row landed in the table');

  const failClient = { from: () => ({ async upsert() { return { data: null, error: { message: 'relation "public.payment_links" does not exist' } }; } }) };
  const failure = await persistPaymentLink({ accessCode: 'ac_x', payment: SAMPLE_PAYMENT, ttlMs: 1000, client: failClient });
  check(!failure.ok && failure.reason === 'payment_links-table-missing', 'missing-table error is classified, not thrown');
}

// TTL: env override works, default is 30 days.
{
  delete process.env.PAYMENT_LINK_TTL_HOURS;
  check(linkTtlMs() === DEFAULT_LINK_TTL_HOURS * 3600 * 1000, 'default link TTL is 30 days');
  process.env.PAYMENT_LINK_TTL_HOURS = '48';
  check(linkTtlMs() === 48 * 3600 * 1000, 'PAYMENT_LINK_TTL_HOURS overrides the TTL');
  delete process.env.PAYMENT_LINK_TTL_HOURS;
}

// Resolve: supabase fallback + expiry + hot-cache rehydration.
{
  accessCodeStore.reset();
  const stub = makeStubClient();
  await persistPaymentLink({
    accessCode: 'ac_resolve1',
    payment: SAMPLE_PAYMENT,
    ttlMs: linkTtlMs(),
    client: stub
  });
  check(accessCodeStore.peekAccessCode('ac_resolve1') === null, 'nothing in memory before resolve');

  const resolved = await resolvePaymentLink('ac_resolve1', { client: stub });
  check(resolved.payment && resolved.source === 'supabase', 'resolve falls back to Supabase');
  check(resolved.payment.email === 'client@example.com', 'resolved payment is complete');
  check(accessCodeStore.peekAccessCode('ac_resolve1') !== null, 'resolve rehydrates the hot cache');

  const missing = await resolvePaymentLink('ac_nope', { client: stub });
  check(missing.payment === null, 'unknown codes resolve to null');

  // Expired row → null + expired flag.
  const now = new Date().toISOString();
  stub.table.set('ac_expired', paymentToRow('ac_expired', SAMPLE_PAYMENT, -1000, now));
  const expired = await resolvePaymentLink('ac_expired', { client: stub });
  check(expired.payment === null && expired.expired === true, 'expired links resolve to null (expired=true)');
}

console.log('\n# lib/base-url.js');
{
  delete process.env.PUBLIC_BASE_URL;
  const req = host => ({ headers: { host, 'x-forwarded-proto': 'https' } });

  check(baseUrl.publicBaseUrl(req('valmontpay.app')) === 'https://valmontpay.app', 'request host wins');
  check(baseUrl.publicBaseUrl(req('my-preview.vercel.app')) === 'https://my-preview.vercel.app', 'vercel previews are allowed');
  check(baseUrl.publicBaseUrl(req('evil-phish.example.com')) === 'https://valmontpay.app', 'untrusted hosts fall back to the default domain');

  process.env.PUBLIC_BASE_URL = 'https://stale-env.example.com/';
  check(baseUrl.publicBaseUrl(req('valmontpay.app')) === 'https://valmontpay.app', 'request host beats a stale PUBLIC_BASE_URL');
  check(baseUrl.publicBaseUrl(req('evil-phish.example.com')) === 'https://stale-env.example.com', 'env is the fallback for untrusted/no hosts');
  delete process.env.PUBLIC_BASE_URL;

  const localReq = { headers: { host: 'localhost:3000' } };
  check(baseUrl.publicBaseUrl(localReq) === 'http://localhost:3000', 'localhost defaults to http and keeps the port');
  check(baseUrl.canonicalWebhookUrl(req('valmontpay.app')) === 'https://valmontpay.app/api/webhook', 'canonical webhook URL is host-derived');
}

console.log('\n# lib/admin-auth.js');
{
  delete process.env.ADMIN_PASSWORD;
  check(!adminAuth.adminAuthEnforced(), 'open posture when ADMIN_PASSWORD is unset (local dev)');
  check(adminAuth.isAuthorizedAdmin({ headers: {} }), 'unset password allows local calls');

  process.env.ADMIN_PASSWORD = 's3cret';
  check(adminAuth.adminAuthEnforced(), 'enforced when ADMIN_PASSWORD is set');
  check(adminAuth.isAuthorizedAdmin({ headers: { 'x-admin-key': 's3cret' } }), 'right key passes');
  check(!adminAuth.isAuthorizedAdmin({ headers: { 'x-admin-key': 'wrong' } }), 'wrong key rejected');
  check(!adminAuth.isAuthorizedAdmin({ headers: { 'x-admin-key': 's3cret-but-longer' } }), 'different-length key rejected safely');
  check(!adminAuth.isAuthorizedAdmin({ headers: {} }), 'missing key rejected');
  delete process.env.ADMIN_PASSWORD;
}

console.log(`\n${passed} passed, 0 failed\n`);
