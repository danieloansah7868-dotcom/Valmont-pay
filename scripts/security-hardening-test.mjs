#!/usr/bin/env node

/**
 * Guards the 2026-08-12 control-plane lock:
 *   - /config/admin.js is gone (password never shipped to the browser)
 *   - the repo is not statically served
 *   - ledger / mandates / diagnostics require admin when ADMIN_PASSWORD is set
 *   - login issues an httpOnly session cookie
 *   - open redirect is closed
 *   - private webhook URLs are rejected
 *   - well-known dev secrets are refused in strict mode
 *   - charge persists Paystack's amount, not the body's
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}

process.env.ADMIN_PASSWORD = 'hardening-s3cret';
process.env.ADMIN_EMAIL = 'support@valmontpay.com';
process.env.PORT = '4331';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_hardening';

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.paystack.co/transaction/verify/')) {
    return {
      json: async () => ({
        status: true,
        data: {
          status: 'success',
          amount: 100,
          reference: String(url).split('/').pop(),
          paid_at: '2026-08-12T12:00:00.000Z',
          customer: { email: 'paid@example.com' },
          channel: 'mobile_money'
        }
      })
    };
  }
  return origFetch(url, opts);
};

const ledger = require('../lib/ledger.js');
ledger.resetLedger();

await import('../server.js');
await new Promise(r => setTimeout(r, 400));

const base = 'http://127.0.0.1:4331';
let passed = 0;
function pass(label) {
  passed += 1;
  console.log('  ✓', label);
}

console.log('\n# Security hardening');

{
  const res = await fetch(base + '/config/admin.js');
  const text = await res.text();
  assert.notEqual(res.status, 200);
  assert.ok(!text.includes('hardening-s3cret'));
  assert.ok(!text.includes('ADMIN_CONFIG'));
  pass('/config/admin.js no longer serves the admin password');
}

{
  for (const p of ['/server.js', '/lib/tenants.js', '/lib/admin-auth.js', '/AUDIT.md', '/package.json']) {
    const res = await fetch(base + p);
    assert.ok(res.status === 404 || res.status === 401, `${p} must not be statically served (got ${res.status})`);
    const text = await res.text();
    assert.ok(!text.includes('requireAdmin'), `${p} must not leak source`);
  }
  pass('repository source is not statically served');
}

{
  const tx = await fetch(base + '/api/transactions');
  assert.equal(tx.status, 401);
  const tenantsRes = await fetch(base + '/api/tenants');
  assert.equal(tenantsRes.status, 401);
  const dash = await fetch(base + '/api/v1/merchant/dashboard');
  assert.equal(dash.status, 401);
  const status = await fetch(base + '/api/webhook-status?paystack=0');
  assert.equal(status.status, 401);
  const deliveries = await fetch(base + '/api/webhook-deliveries');
  assert.equal(deliveries.status, 401);
  pass('ledger, tenants, dashboard and diagnostics require admin');
}

{
  const branding = await fetch(base + '/api/tenants/valmont-electricals');
  const json = await branding.json();
  assert.equal(branding.status, 200);
  assert.ok(json.data.display_name);
  assert.equal(json.data.webhook_url, undefined);
  assert.equal(json.data.settlement_account, undefined);
  assert.equal(json.data.allowed_domains, undefined);
  pass('public tenant lookup returns branding only');
}

{
  const badLogin = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'support@valmontpay.com', password: 'wrong' })
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'support@valmontpay.com', password: 'hardening-s3cret' })
  });
  const loginJson = await login.json();
  assert.equal(login.status, 200);
  assert.equal(loginJson.status, true);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /vp_admin=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.ok(!JSON.stringify(loginJson).includes('hardening-s3cret'));
  pass('login issues an httpOnly SameSite=Strict session cookie and never returns the password');

  const cookie = setCookie.split(';')[0];
  const session = await fetch(base + '/api/admin/session', { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  const tx = await fetch(base + '/api/transactions', { headers: { Cookie: cookie } });
  assert.equal(tx.status, 200);
  pass('session cookie authorizes GET /api/transactions');
}

{
  const redir = await fetch(
    base + '/api/transaction/return?callback_url=https://evil.example/phish&status=success',
    { redirect: 'manual' }
  );
  assert.equal(redir.status, 400);
  pass('open redirect without an allowlisted merchant is rejected');
}

{
  const webhook = await fetch(base + '/api/tenants/valmont-electricals/webhook', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'hardening-s3cret' },
    body: JSON.stringify({ webhook_url: 'http://169.254.169.254/latest/meta-data' })
  });
  assert.equal(webhook.status, 400);
  const body = await webhook.json();
  assert.match(String(body.message || ''), /https|private|link-local/i);
  pass('private/metadata webhook URLs are rejected');
}

{
  const { rejectInsecureSecret } = require('../lib/insecure-secrets.js');
  process.env.VALMONT_STRICT_SECRETS = '1';
  const tenants = require('../lib/tenants.js');
  tenants.resetRegistryForTests();
  assert.equal(tenants.getTenantBySecretKey('vme_secret_dev_key_1'), undefined);
  assert.equal(rejectInsecureSecret('vme_secret_dev_key_1'), true);
  delete process.env.VALMONT_STRICT_SECRETS;
  tenants.resetRegistryForTests();
  pass('well-known development tenant secrets are refused in strict/production mode');
}

{
  const init = await fetch(base + '/api/v1/transaction/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'hardening-s3cret' },
    body: JSON.stringify({ email: 'paid@example.com', amount: 1, merchant: 'valmont-electricals' })
  });
  const initJson = await init.json();
  assert.equal(init.status, 200, JSON.stringify(initJson));
  const reference = initJson.data.reference;

  const charge = await fetch(base + '/api/v1/transaction/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, amount: 100000, email: 'attacker@evil.test' })
  });
  const chargeJson = await charge.json();
  assert.equal(chargeJson.trx_status, 'SUCCESS');
  assert.equal(chargeJson.amount, 1);
  pass('verified charge persists Paystack amount (GH₵1), not the body amount (GH₵100000)');
}

{
  const serverSrc = readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(!serverSrc.includes("password: process.env.ADMIN_PASSWORD"));
  assert.ok(!serverSrc.includes('express.static(__dirname)'));
  assert.match(serverSrc, /module\.exports = app/);
  const loginSrc = readFileSync(path.join(root, 'admin-login.html'), 'utf8');
  assert.ok(!loginSrc.includes('/config/admin.js'));
  assert.ok(!loginSrc.includes('ADMIN_PASSWORD'));
  const checkoutSrc = readFileSync(path.join(root, 'checkout.html'), 'utf8');
  assert.ok(!checkoutSrc.includes('cardNumber'));
  assert.ok(!checkoutSrc.includes('cardCVV'));
  pass('static guards: no password-in-JS, no repo static, Express exported, no card form');
}

globalThis.fetch = origFetch;
console.log(`\n✓ security hardening: ${passed} checks passed.\n`);
process.exit(0);
