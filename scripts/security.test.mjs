#!/usr/bin/env node

/**
 * SECURITY REGRESSION SUITE
 *
 * The repository previously had 14 test suites and not one of them asserted
 * an authorization boundary — which is exactly why a set of guards could be
 * added, declared "fixed", and silently defeated by an endpoint that
 * published the guard's own secret.
 *
 * Every test here is written from the ATTACKER's position: an anonymous
 * caller with nothing but the URL. A test that passes means the attack
 * fails. Run offline; no Supabase, no Paystack, no network.
 *
 *   node scripts/security.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Deployed-like posture: admin password configured, Supabase absent.
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'VERCEL', 'VERCEL_ENV']) {
  delete process.env[name];
}
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const ADMIN_EMAIL = 'ops@valmontpay.com';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
process.env.PAYSTACK_SECRET_KEY = 'sk_test_security_suite';
process.env.PORT = '4577';

const BASE = 'http://localhost:4577';

// Neutralise outbound Paystack calls so a charge attempt can never leave
// the machine, and so we can SEE whether one would have fired.
const realFetch = globalThis.fetch;
let paystackChargeAttempts = 0;
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  if (target.includes('api.paystack.co')) {
    if (target.includes('charge_authorization')) paystackChargeAttempts += 1;
    return { json: async () => ({ status: true, data: { status: 'success', reference: 'MOCK', amount: 0 } }) };
  }
  return realFetch(url, opts);
};

const mandateStore = require('../lib/mandate-store.js');
const tenants = require('../lib/tenants.js');

// A victim mandate: a reusable token that can pull money from a customer.
await mandateStore.saveMandate({
  authorization_code: 'AUTH_VICTIM_TEST',
  reference: 'VP-SEED-1',
  customer_email: 'victim@example.com',
  merchant_name: 'Valmont Electricals',
  tenant_key: 'valmont-electricals',
  payment_method: 'Momo (MTN)',
  amount: 45,
  status: 'ACTIVE'
});

require('../server.js');
await new Promise(r => setTimeout(r, 1200));

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const call = async (path, options = {}) => {
  const res = await realFetch(`${BASE}${path}`, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
  return { status: res.status, text, json, headers: res.headers };
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 1. The admin password must never be reachable');

{
  const res = await call('/config/admin.js');
  check(!res.text.includes(ADMIN_PASSWORD),
    '/config/admin.js does not leak ADMIN_PASSWORD');
  check(res.status === 410,
    '/config/admin.js is retired with an explicit 410');
}

{
  // Sweep the whole public surface for the password appearing anywhere.
  const surface = [
    '/', '/api/health', '/api/webhook-debug', '/api/tenants',
    '/api/tenants/valmont-electricals', '/api/config/pay',
    '/admin-login.html', '/dashboard.html', '/admin.html', '/tenants.html',
    '/api/admin/session'
  ];
  let leaked = null;
  for (const path of surface) {
    const res = await call(path);
    if (res.text.includes(ADMIN_PASSWORD)) { leaked = path; break; }
  }
  check(leaked === null,
    `no public endpoint echoes the admin password (checked ${surface.length} paths)`);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Admin endpoints reject anonymous callers');

const GUARDED = [
  ['GET', '/api/admin/tenants'],
  ['POST', '/api/admin/tenants'],
  ['PUT', '/api/admin/tenants/valmont-electricals'],
  ['DELETE', '/api/admin/tenants/valmont-electricals'],
  ['POST', '/api/admin/tenants/valmont-electricals/disable'],
  ['POST', '/api/admin/tenants/valmont-electricals/enable'],
  ['POST', '/api/admin/tenants/valmont-electricals/rotate-keys'],
  ['POST', '/api/tenants/valmont-electricals/rotate-keys'],
  ['PUT', '/api/tenants/valmont-electricals/webhook'],
  ['POST', '/api/manual-transaction'],
  ['POST', '/api/webhook-debug'],
  ['GET', '/api/transactions'],
  ['GET', '/api/webhook-deliveries'],
  ['POST', '/api/webhook-deliveries/VP-1/replay']
];

for (const [method, path] of GUARDED) {
  const res = await call(path, { method, headers: JSON_HEADERS, body: method === 'GET' ? undefined : '{}' });
  check(res.status === 401, `${method} ${path} → 401 for an anonymous caller (got ${res.status})`);
}

{
  const res = await call('/api/admin/tenants', { headers: { 'X-Admin-Key': 'wrong-password' } });
  check(res.status === 401, 'a WRONG X-Admin-Key is rejected');
}

{
  // The key must not be accepted from the query string: query strings leak
  // via access logs, browser history and Referer headers.
  const res = await call(`/api/admin/tenants?admin_key=${encodeURIComponent(ADMIN_PASSWORD)}`);
  check(res.status === 401, 'the admin key is NOT accepted from the query string');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Recurring mandates — the anonymous money-pull is closed');

const MANDATE_ROUTES = [
  ['GET', '/api/v1/mandates', undefined],
  ['GET', '/api/v1/mandates/AUTH_VICTIM_TEST', undefined],
  ['POST', '/api/v1/mandates/charge', JSON.stringify({ authorization_code: 'AUTH_VICTIM_TEST', amount: 5000 })],
  ['POST', '/api/v1/mandates/revoke', JSON.stringify({ authorization_code: 'AUTH_VICTIM_TEST' })]
];

for (const [method, path, body] of MANDATE_ROUTES) {
  const res = await call(path, { method, headers: JSON_HEADERS, body });
  check(res.status === 401, `${method} ${path} → 401 anonymously (got ${res.status})`);
}

{
  const before = paystackChargeAttempts;
  await call('/api/v1/mandates/charge', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ authorization_code: 'AUTH_VICTIM_TEST', amount: 999999 })
  });
  check(paystackChargeAttempts === before,
    'an anonymous charge attempt fires NO Paystack request (no money can move)');
}

{
  const res = await call('/api/v1/mandates');
  check(!res.text.includes('AUTH_VICTIM_TEST'),
    'the mandate list does not leak authorization_codes anonymously');
}

{
  // Mandate still ACTIVE — the anonymous revoke must not have worked.
  const mandate = await mandateStore.getMandate('AUTH_VICTIM_TEST');
  check(mandate && mandate.status === 'ACTIVE',
    'an anonymous revoke did not change the mandate status');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 4. Cross-tenant isolation on mandates');

{
  // Give tenant B a real secret key, then try to touch tenant A's mandate.
  const victimTenant = tenants.getTenant('valmont-electricals');
  const otherKey = 'vmp_test_other_tenant_secret_key_001';
  tenants.registerTenant
    ? tenants.registerTenant({ key: 'other-merchant', display_name: 'Other Merchant', secret_keys: [otherKey] })
    : tenants.applyDbTenant({ key: 'other-merchant', display_name: 'Other Merchant', secret_keys: [otherKey] });

  const auth = { Authorization: `Bearer ${otherKey}`, ...JSON_HEADERS };
  const other = tenants.getTenantBySecretKey(otherKey);

  if (!other) {
    console.log('  … skipped (could not register a second tenant in this build)');
  } else {
    const readRes = await call('/api/v1/mandates/AUTH_VICTIM_TEST', { headers: auth });
    check(readRes.status === 404,
      "tenant B reading tenant A's mandate → 404 (existence not confirmed)");

    const before = paystackChargeAttempts;
    const chargeRes = await call('/api/v1/mandates/charge', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ authorization_code: 'AUTH_VICTIM_TEST', amount: 5000 })
    });
    check(chargeRes.status === 404, "tenant B charging tenant A's mandate → 404");
    check(paystackChargeAttempts === before,
      'the cross-tenant charge fired NO Paystack request');

    const listRes = await call('/api/v1/mandates', { headers: auth });
    check(!listRes.text.includes('AUTH_VICTIM_TEST'),
      "tenant B's mandate list excludes tenant A's mandates");

    const victimAuth = victimTenant && victimTenant.secret_keys && victimTenant.secret_keys[0];
    if (victimAuth) {
      const ownRes = await call('/api/v1/mandates/AUTH_VICTIM_TEST', {
        headers: { Authorization: `Bearer ${victimAuth}` }
      });
      check(ownRes.status === 200, 'the OWNING tenant can still read its own mandate');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 5. Login, sessions, and brute-force resistance');

{
  const res = await call('/api/admin/login', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ email: ADMIN_EMAIL, password: 'wrong' })
  });
  check(res.status === 401, 'login with a wrong password → 401');
  check(!res.text.includes(ADMIN_PASSWORD), 'a failed login does not echo the real password');
}

let sessionCookie = '';
{
  const res = await realFetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const setCookie = res.headers.get('set-cookie') || '';
  sessionCookie = setCookie.split(';')[0];

  check(res.status === 200, 'login with correct credentials → 200');
  check(/HttpOnly/i.test(setCookie), 'the session cookie is HttpOnly (JS cannot read it)');
  check(/SameSite=Strict/i.test(setCookie), 'the session cookie is SameSite=Strict (blocks CSRF)');
  check(!setCookie.includes(ADMIN_PASSWORD), 'the session cookie is NOT the password');

  const body = await res.text();
  check(!body.includes(ADMIN_PASSWORD), 'the login response body does not contain the password');
}

{
  const res = await call('/api/admin/tenants', { headers: { Cookie: sessionCookie } });
  check(res.status === 200, 'the session cookie authorizes an admin request');
}

{
  // LOGIN-LOOP REGRESSION (the serverless bug): the dashboard accepted the
  // correct password, then bounced straight back to login. Sessions were kept
  // in a per-process Map, and Vercel's instance handling the dashboard's first
  // API call was usually NOT the one that handled POST /api/admin/login — it
  // saw no session, returned 401, and the UI redirected back to login. Tokens
  // must therefore be STATELESS: one minted on instance A must verify on a
  // fresh instance B that shares NO memory with A.
  const rawToken = decodeURIComponent(sessionCookie.split('=').slice(1).join('='));
  const adminSessionPath = require.resolve('../lib/admin-session.js');

  // Simulate instance B: a brand-new module copy whose in-memory state is
  // guaranteed to be empty (whatever storage the module uses, B starts blank).
  const freshInstance = (() => {
    const cached = require.cache[adminSessionPath];
    delete require.cache[adminSessionPath];
    try {
      return require('../lib/admin-session.js');
    } finally {
      require.cache[adminSessionPath] = cached;
    }
  })();

  check(freshInstance.isValidSession(rawToken),
    'a session minted on one instance verifies on a FRESH instance (no shared memory)');
  check(freshInstance.hasValidSession({ headers: { cookie: sessionCookie } }),
    'the cookie authorizes an admin request on a fresh instance');

  // The signature must bind every field of issuedAt.expiresAt.nonce: flipping
  // the expiry must invalidate the token.
  const parts = rawToken.split('.');
  const tampered = parts.slice();
  tampered[2] = String(Number(parts[2]) + 24 * 60 * 60 * 1000); // extend by a day
  check(!freshInstance.isValidSession(tampered.join('.')),
    'a token with a tampered expiry is rejected (signature covers issuedAt.expiresAt.nonce)');

  // Instances that disagree on the signing secret must not accept each
  // other's sessions: stateless verification depends on shared config.
  const savedSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = 'a-different-deployment-secret';
  let foreignToken = '';
  try {
    foreignToken = (() => {
      const cached = require.cache[adminSessionPath];
      delete require.cache[adminSessionPath];
      try {
        return require('../lib/admin-session.js').createSession(ADMIN_EMAIL).token;
      } finally {
        require.cache[adminSessionPath] = cached;
      }
    })();
  } finally {
    // Assigning `undefined` to process.env stores the STRING "undefined", so
    // an unset variable must be deleted, not reassigned.
    if (savedSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = savedSecret;
  }
  check(!require('../lib/admin-session.js').isValidSession(foreignToken),
    'a session minted under a different secret is rejected (instances must share config)');
}

{
  const res = await call('/api/transactions', { headers: { Cookie: sessionCookie } });
  check(res.status === 200, 'the dashboard can still read the ledger with a session');
}

{
  const res = await call('/api/admin/tenants', { headers: { Cookie: 'vp_admin_session=forged-token-value' } });
  check(res.status === 401, 'a forged session token is rejected');
}

{
  // Logout must actually invalidate server-side, not just clear the browser.
  await call('/api/admin/logout', { method: 'POST', headers: { Cookie: sessionCookie } });
  const res = await call('/api/admin/tenants', { headers: { Cookie: sessionCookie } });
  check(res.status === 401, 'the session is dead server-side after logout');
}

{
  // Brute force: the limiter must stop us well before exhausting a keyspace.
  let blocked = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await call('/api/admin/login', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ email: ADMIN_EMAIL, password: `guess-${i}` })
    });
    if (res.status === 429) { blocked = true; break; }
  }
  check(blocked, 'repeated failed logins are rate-limited (429)');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 6. Host-header injection cannot mint links on other domains');

{
  const res = await call('/api/v1/transaction/initialize', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'X-Forwarded-Host': 'attacker-phish.vercel.app' },
    body: JSON.stringify({ email: 'a@b.com', amount: 10 })
  });
  check(!res.text.includes('attacker-phish.vercel.app'),
    'a forged .vercel.app host is NOT reflected into payment links');
}

{
  const res = await call('/api/v1/transaction/initialize', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'X-Forwarded-Host': 'evil.example.com' },
    body: JSON.stringify({ email: 'a@b.com', amount: 10 })
  });
  check(!res.text.includes('evil.example.com'),
    'an arbitrary forged host is NOT reflected into payment links');
}

{
  const { isAllowedHost } = require('../lib/base-url.js');
  check(isAllowedHost('valmontpay.app'), 'the production host is allowlisted');
  check(!isAllowedHost('attacker.vercel.app'), 'the .vercel.app wildcard is gone');
  check(!isAllowedHost('valmontpay.app.evil.com'), 'a suffix-confusion host is rejected');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 7. Money integrity');

{
  const res = await call('/api/transactions', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ reference: 'ATTACK-FAKE-1', amount: 999999, status: 'PAID' })
  });
  check(res.status === 401, 'an anonymous caller cannot write a PAID (terminal) row');
}

{
  // The public storefront path must keep working.
  const res = await call('/api/transactions', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ reference: 'STOREFRONT-OK-1', amount: 25, status: 'PENDING_MOMO' })
  });
  check(res.status === 200, 'a public storefront PENDING_MOMO order still succeeds');
}

{
  const ledger = require('../lib/ledger.js');
  check(!ledger.findTransaction('ATTACK-FAKE-1'),
    'the rejected fake payment never reached the ledger');
  check(ledger.getBalance() === 0,
    'the settled balance is still 0 — no fake money was injected');
}

{
  // Server-side pricing: a caller-supplied amount must be ignored.
  const res = await call('/api/v1/payment-link/sku', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ sku: 'WEB-LITE-STG1', amount: 1, email: 'a@b.com' })
  });
  if (res.json && res.json.data) {
    check(Number(res.json.data.amount) !== 1,
      'a caller-supplied SKU price is ignored in favour of the catalogue');
  } else {
    check(res.status !== 200, 'SKU link creation did not accept a forged price');
  }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 8. Webhook signature enforcement');

{
  const res = await call('/api/webhook', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'x-paystack-signature': 'deadbeef' },
    body: JSON.stringify({ event: 'charge.success', data: { reference: 'FORGED-1', amount: 500000, status: 'success' } })
  });
  check(res.status === 401, 'a webhook with a bad signature → 401');

  const ledger = require('../lib/ledger.js');
  check(!ledger.findTransaction('FORGED-1'), 'a forged webhook writes nothing to the ledger');
}

{
  const res = await call('/api/webhook', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ event: 'charge.success', data: { reference: 'UNSIGNED-1', amount: 500000 } })
  });
  check(res.status === 401, 'a webhook with NO signature is rejected');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 9. PII and business-data exposure');

{
  const res = await call('/api/tenants');
  check(!res.text.includes('GCB Bank'),
    'the public tenant list does not expose settlement bank accounts');
  check(!res.text.includes('webhook_url'),
    'the public tenant list does not expose tenant webhook URLs');
  check(res.json && Array.isArray(res.json.data) && res.json.data.length > 0,
    'the public tenant list still returns branding for checkout pages');
}

{
  const res = await call('/api/tenants/valmont-electricals');
  check(!res.text.includes('GCB Bank'),
    'a single public tenant record hides the settlement account');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n# 10. Fail-closed posture when ADMIN_PASSWORD is missing');

{
  const adminAuth = require('../lib/admin-auth.js');
  const saved = process.env.ADMIN_PASSWORD;

  delete process.env.ADMIN_PASSWORD;
  process.env.VERCEL = '1';
  check(adminAuth.isMisconfigured(),
    'a DEPLOYED environment without ADMIN_PASSWORD is flagged misconfigured');
  check(adminAuth.isAuthorizedAdmin({ headers: {} }) === false,
    'a deployed environment without ADMIN_PASSWORD authorizes NOBODY (fails closed)');

  delete process.env.VERCEL;
  check(adminAuth.isAuthorizedAdmin({ headers: {} }) === true,
    'local dev without ADMIN_PASSWORD stays open (frictionless)');

  process.env.ADMIN_PASSWORD = saved;
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✓' : '✗'} security suite: ${passed} passed, ${failed} failed.\n`);
assert.equal(failed, 0, `${failed} security assertion(s) failed`);
process.exit(0);
