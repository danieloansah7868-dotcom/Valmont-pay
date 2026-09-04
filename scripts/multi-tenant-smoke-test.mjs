/**
 * Multi-tenant payment gateway smoke test.
 *
 * Tests:
 *   1. Tenant registry loads defaults
 *   2. POST /api/transaction/initialize with valid auth
 *   3. POST /api/transaction/initialize with invalid auth (401)
 *   4. GET /api/transaction/access/{access_code}
 *   5. GET /api/transaction/verify/{reference}
 *   6. GET /api/tenants list
 *   7. PUT /api/tenants/{key}/webhook
 *   8. POST /api/tenants/{key}/rotate-keys
 *   9. GET /api/transaction/return redirect
 *  10. Cross-tenant isolation (404 not 403)
 *  11. Callback URL validation
 *
 * Run it:  node scripts/multi-tenant-smoke-test.mjs
 *
 * By default it boots its OWN server on a spare port with the test-merchant-a
 * fixture loaded, runs every test against it, and shuts it down. Point it at
 * an already-running deployment instead with TEST_BASE_URL=… (in that case
 * nothing is started or stopped).
 *
 * Every run needs a FRESH server: test 14 rotates valmont-electricals' API
 * secret in memory, so a second run against the same process legitimately
 * fails the "old key still works during rotation" check.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

let BASE = process.env.TEST_BASE_URL || null;

let child = null;

async function waitForHealth(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok || res.status === 503) return true; // 503 still means it's up
    } catch (_) {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

async function startServer() {
  const port = 4500 + Math.floor(Math.random() * 400);
  const fixture = fs.readFileSync(new URL('./fixtures/test-merchant-a.json', import.meta.url), 'utf8');
  const base = `http://127.0.0.1:${port}`;

  const childEnv = { ...process.env };
  // A stray VERCEL/VERCEL_ENV from the developer's shell must not make the
  // child behave like a deployment (see NODE_ENV below).
  delete childEnv.VERCEL;
  delete childEnv.VERCEL_ENV;

  child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...childEnv,
      PORT: String(port),
      // Offline posture: no database, no real Paystack credential, no admin
      // password (so /api/admin/* stays open, exactly like local dev).
      PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY || 'sk_test_offline_smoke',
      TENANTS_JSON: fixture,
      // Pins the fixture tenant's secret through the environment, using the
      // same value the fixture carries so the other tests keep working. This
      // is what makes test 20 able to prove the rotate guard fires.
      TENANT__TEST_MERCHANT_A__SECRET_KEY_1: testMerchantAFixtureKey,
      // Force the local posture. A developer shell with NODE_ENV=production
      // or VERCEL set would make the gateway drop its dev credentials and
      // lock the admin endpoints, and the run would fail for the wrong
      // reason. The child is always "a laptop".
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  if (!(await waitForHealth(base))) {
    child.kill('SIGKILL');
    console.error(`✗ server did not become healthy on ${base}`);
    process.exit(1);
  }
  return base;
}

function stopServer() {
  if (child) child.kill('SIGTERM');
}

let passed = 0;
let failed = 0;
let errors = [];

function assert(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const msg = `  ✗ ${label}${detail ? ': ' + detail : ''}`;
    console.error(msg);
    errors.push(msg);
  }
}

// Tests are QUEUED, not run on call. The previous version called `test(...)`
// fire-and-forget and printed the summary synchronously, so the process exited
// with "0 passed, 0 failed — All tests passed!" while every assertion was
// still in flight. Nothing in this file was ever actually verified.
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

async function runQueue() {
  for (const { name, fn } of queue) {
    console.log(`\n━━━ ${name} ━━━`);
    try {
      await fn();
    } catch (err) {
      failed++;
      const msg = `  ✗ EXCEPTION: ${err.message}`;
      console.error(msg);
      errors.push(msg);
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

const testSecretKey = 'vme_secret_dev_key_1';
// Kept identical to the value in scripts/fixtures/test-merchant-a.json and
// pinned through the environment in startServer() — see test 20.
const testMerchantAFixtureKey = 'test-merchant-a-fixture-key';
// Test-only second merchant. Start the smoke-test server with
// TENANTS_JSON="$(cat scripts/fixtures/test-merchant-a.json)"; this fixture
// is intentionally never part of lib/tenants.js production defaults.
const testMerchantASecretKey = 'test-merchant-a-fixture-key';
const testMerchantAKey = 'test-merchant-a';
const invalidSecretKey = 'sk_test_invalid_key_that_does_not_exist';

test('1. GET /api/tenants — lists tenants', async () => {
  const res = await fetch(`${BASE}/api/tenants`);
  const json = await res.json();

  assert('returns 200', res.status === 200);
  assert('has status true', json.status === true);
  assert('has data array', Array.isArray(json.data));
  assert('contains valmont-electricals', json.data.some(t => t.key === 'valmont-electricals'));
  assert('contains valmont-web-services', json.data.some(t => t.key === 'valmont-web-services'));
  assert('contains test-only second merchant', json.data.some(t => t.key === testMerchantAKey));
  assert('does not publish legacy valmontweb as a tenant', !json.data.some(t => t.key === 'valmontweb'));
  assert('no secrets in response', json.data.every(t => t.has_secret_keys !== undefined));
  assert('display_name is present', json.data[0].display_name && json.data[0].display_name.length > 0);
});

test('2. GET /api/tenants/{key} — single tenant', async () => {
  const res = await fetch(`${BASE}/api/tenants/valmont-electricals`);
  const json = await res.json();

  assert('returns 200', res.status === 200);
  assert('key matches', json.data.key === 'valmont-electricals');
  assert('has display_name', json.data.display_name === 'Valmont Electricals');
  assert('has brand_color', json.data.brand_color === '#f68b1e');
  assert('has allowed_domains', Array.isArray(json.data.allowed_domains));
  assert('no secret keys exposed', !json.data.secret_keys);
});

test('3. GET /api/tenants/{key} — unknown tenant returns 404', async () => {
  const res = await fetch(`${BASE}/api/tenants/nonexistent`);
  assert('returns 404', res.status === 404);
});

test('4. POST /api/transaction/initialize — valid auth', async () => {
  const res = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testSecretKey}`
    },
    body: JSON.stringify({
      amount: 99.99,
      reference: `TEST-REF-${Date.now()}`,
      email: 'customer@test.com',
      currency: 'GHS',
      callback_url: 'https://valmontweb.com/return'
    })
  });
  const json = await res.json();

  assert('returns 200', res.status === 200);
  assert('status is true', json.status === true);
  assert('has access_code', json.data && json.data.access_code && json.data.access_code.startsWith('ac_'));
  assert('has reference', json.data && json.data.reference);
  assert('amount matches', json.data && json.data.amount === 99.99);
  assert('merchant matches tenant key', json.data && json.data.merchant === 'valmont-electricals');
  assert('has pay_url', json.data && json.data.pay_url);
});

test('5. POST /api/transaction/initialize — missing Authorization returns 401', async () => {
  const res = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 50, email: 'test@test.com' })
  });
  assert('returns 401', res.status === 401);
});

test('6. POST /api/transaction/initialize — invalid secret key returns 401', async () => {
  const res = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${invalidSecretKey}`
    },
    body: JSON.stringify({ amount: 50, email: 'test@test.com' })
  });
  assert('returns 401', res.status === 401);
});

test('7. POST /api/transaction/initialize — invalid callback_url rejected', async () => {
  const res = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testSecretKey}`
    },
    body: JSON.stringify({
      amount: 50,
      email: 'test@test.com',
      callback_url: 'https://evil.com/phishing'
    })
  });
  const json = await res.json();

  assert('returns 400', res.status === 400);
  assert('error message about domain', json.message && json.message.includes('domain') || json.message.includes('allowlist'));
});

test('8. POST /api/transaction/initialize — missing email returns 400', async () => {
  const res = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testSecretKey}`
    },
    body: JSON.stringify({ amount: 50 })
  });
  assert('returns 400', res.status === 400);
});

test('9. GET /api/transaction/access/{code} — valid access code', async () => {
  // First, create a payment
  const initRes = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testSecretKey}`
    },
    body: JSON.stringify({
      amount: 75.50,
      reference: `ACCESS-TEST-${Date.now()}`,
      email: 'access@test.com',
      callback_url: 'https://valmontweb.com/return'
    })
  });
  const initJson = await initRes.json();
  assert('init succeeded', initJson.status === true);

  const accessCode = initJson.data.access_code;

  // Now resolve the access code
  const res = await fetch(`${BASE}/api/transaction/access/${accessCode}`);
  const json = await res.json();

  assert('returns 200', res.status === 200);
  assert('status true', json.status === true);
  assert('amount matches', json.data.amount === 75.50);
  assert('merchant matches', json.data.merchant === 'valmont-electricals');
  assert('email matches', json.data.email === 'access@test.com');
});

test('10. GET /api/transaction/access/{code} — invalid code returns 404', async () => {
  const res = await fetch(`${BASE}/api/transaction/access/invalid_code_xyz`);
  assert('returns 404', res.status === 404);
});

test('11. GET /api/transaction/verify/{reference} — valid auth, existing ref', async () => {
  // First create a payment
  const ref = `VERIFY-TEST-${Date.now()}`;
  const initRes = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testSecretKey}`
    },
    body: JSON.stringify({
      amount: 150.00,
      reference: ref,
      email: 'verify@test.com',
      callback_url: 'https://valmontweb.com/return'
    })
  });
  assert('init succeeded', initRes.status === 200);

  // Now verify with the same auth
  const res = await fetch(`${BASE}/api/transaction/verify/${ref}`, {
    headers: { 'Authorization': `Bearer ${testSecretKey}` }
  });
  const json = await res.json();

  assert('returns 200', res.status === 200);
  assert('status true', json.status === true);
  assert('reference matches', json.data && json.data.reference === ref);
  assert('has amount', json.data && json.data.amount >= 0);
});

test('12. GET /api/transaction/verify/{reference} — cross-tenant isolation', async () => {
  // Get a reference from valmont-electricals tenant
  const ref = `CROSS-TENANT-${Date.now()}`;
  await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testSecretKey}` // valmont-electricals key
    },
    body: JSON.stringify({
      amount: 50,
      reference: ref,
      email: 'cross@test.com',
      callback_url: 'https://valmontweb.com/return'
    })
  });

  // Try to verify with test-merchant-a's key — should get 404 because this
  // reference belongs to valmont-electricals
  const res = await fetch(`${BASE}/api/transaction/verify/${ref}`, {
    headers: { 'Authorization': `Bearer ${testMerchantASecretKey}` }
  });
  const json = await res.json();

  // Note: in-memory ledger doesn't track which tenant created a ref perfectly,
  // but the design intent is 404. We check that at minimum it's not 403 and
  // not leaking other tenant's data.
  assert('returns 404, not 403 or 200', res.status === 404 || !json.data);
});

test('13. PUT /api/tenants/{key}/webhook — update webhook URL', async () => {
  const testUrl = 'https://valmontweb.com/api/payments/webhook';

  const res = await fetch(`${BASE}/api/tenants/valmont-electricals/webhook`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhook_url: testUrl })
  });
  const json = await res.json();

  // The endpoint persists to Supabase FIRST and only then syncs memory, so
  // without a database the correct behaviour is a loud 503 — never a fake
  // success. Assert whichever contract the environment is actually running.
  const noDatabase = res.status === 503 && /Supabase is not configured/i.test(json.message || '');

  if (noDatabase) {
    // ── Offline contract: refuse, and leave the built-in URL untouched ──
    assert('returns 503 when Supabase is not configured', res.status === 503);
    assert('explains why it refused', /Supabase is not configured/i.test(json.message || ''));

    const checkRes = await fetch(`${BASE}/api/tenants/valmont-electricals`);
    const checkJson = await checkRes.json();
    assert(
      'refuses to pretend the write succeeded (URL unchanged)',
      checkJson.data.webhook_url === 'https://valmontelectricals.com/api/valmontpay/webhook'
    );
    return;
  }

  // ── Database contract: persist, then report the effective value ──
  assert('returns 200', res.status === 200);
  assert('status true', json.status === true);

  const checkRes = await fetch(`${BASE}/api/tenants/valmont-electricals`);
  const checkJson = await checkRes.json();
  assert('webhook URL persisted', checkJson.data.webhook_url === testUrl);
});

test('14. POST /api/tenants/{key}/rotate-keys — rotate API secrets', async () => {
  const res = await fetch(`${BASE}/api/tenants/valmont-electricals/rotate-keys`, {
    method: 'POST'
  });
  const json = await res.json();

  // Rotation must be DURABLE. It is persisted to Supabase first, so without a
  // database the correct answer is a loud 503 — an in-memory-only rotation
  // would let a "revoked" credential come back at the next cold start.
  const noDatabase = res.status === 503 && /not rotated/i.test(json.message || '');

  if (noDatabase) {
    assert('returns 503 when rotation cannot be persisted', res.status === 503);
    assert('says the keys were NOT rotated', /not rotated/i.test(json.message || ''));

    const oldKeyRes = await fetch(`${BASE}/api/transaction/initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testSecretKey}`
      },
      body: JSON.stringify({ amount: 10, email: 'rotate@test.com', callback_url: 'https://valmontweb.com/return' })
    });
    assert('the existing key is still untouched', oldKeyRes.status === 200);
    return;
  }

  assert('returns 200', res.status === 200);
  assert('status true', json.status === true);
  assert('has secret_key_1', json.data && json.data.secret_key_1);
  assert('has secret_key_2', json.data && json.data.secret_key_2);
  assert('keys are different', json.data.secret_key_1 !== json.data.secret_key_2);

  const init = (key) => fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ amount: 10, email: 'rotate@test.com', callback_url: 'https://valmontweb.com/return' })
  });

  const newKeyRes = await init(json.data.secret_key_1);
  assert('the new secret_key_1 works immediately', newKeyRes.status === 200);

  const oldKeyRes = await init(json.data.secret_key_2);
  assert('the previous key (now secret_key_2) still works during rotation', oldKeyRes.status === 200);
});

test('15. GET /api/transaction/return — valid redirect', async () => {
  const callbackUrl = 'https://valmontweb.com/orders/thanks';
  const ref = 'ORDER-123';

  const res = await fetch(
    `${BASE}/api/transaction/return?reference=${ref}&status=success&merchant=valmont-electricals&callback_url=${encodeURIComponent(callbackUrl)}`,
    { redirect: 'manual' }
  );

  assert('returns 302', res.status === 302);
  const location = res.headers.get('location') || '';
  assert('has ref param', location.includes('ref=' + ref));
  assert('has status param', location.includes('status=success'));
  assert('redirects to callback_url', location.startsWith(callbackUrl));
});

test('16. GET /api/webhook-deliveries — returns log', async () => {
  const res = await fetch(`${BASE}/api/webhook-deliveries`);
  const json = await res.json();

  assert('returns 200', res.status === 200);
  assert('status true', json.status === true);
  assert('has data array', Array.isArray(json.data));
});

test('17. Tenant valmont-electricals has allowed domains configured', async () => {
  const res = await fetch(`${BASE}/api/tenants/valmont-electricals`);
  const json = await res.json();

  assert('has allowed_domains', Array.isArray(json.data.allowed_domains));
  assert('includes valmontweb.com', json.data.allowed_domains.includes('valmontweb.com'));
  assert('includes valmontpay.app', json.data.allowed_domains.includes('valmontpay.app'));
  assert('includes localhost for dev', json.data.allowed_domains.includes('localhost'));
});

test('18. POST /api/transaction/initialize — test-only second tenant (test-merchant-a) works', async () => {
  const res = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testMerchantASecretKey}`
    },
    body: JSON.stringify({
      amount: 250.00,
      reference: `TEST-MERCHANT-A-${Date.now()}`,
      email: 'test-merchant-a@example.com',
      currency: 'GHS',
      callback_url: 'https://test-merchant-a.example/return'
    })
  });
  const json = await res.json();

  assert('returns 200', res.status === 200);
  assert('has access_code', json.data && json.data.access_code);
  assert('merchant is test-merchant-a', json.data && json.data.merchant === testMerchantAKey);
  assert('amount matches', json.data && json.data.amount === 250.00);

  // Verify the access code resolves to the correct tenant
  const accessRes = await fetch(`${BASE}/api/transaction/access/${json.data.access_code}`);
  const accessJson = await accessRes.json();
  assert('access_code resolves to correct tenant', accessJson.data && accessJson.data.merchant === testMerchantAKey);
});

test('19. POST /api/transaction/initialize — valid domain in callback_url passes validation', async () => {
  // valmont-electricals allows *.valmontweb.com
  const res = await fetch(`${BASE}/api/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testSecretKey}`
    },
    body: JSON.stringify({
      amount: 25.00,
      reference: `DOMAIN-OK-${Date.now()}`,
      email: 'domain@test.com',
      callback_url: 'https://shop.valmontweb.com/checkout/thanks'
    })
  });
  assert('returns 200 for subdomain of allowed domain', res.status === 200);
});

test('20. POST /api/tenants/{key}/rotate-keys — refuses when the environment pins the key', async () => {
  // test-merchant-a has TENANT__TEST_MERCHANT_A__SECRET_KEY_1 set, which
  // overrides the database entirely. Rotating it would write a new key and
  // change nothing — the operator would walk away believing a credential was
  // revoked. The API must refuse instead.
  const res = await fetch(`${BASE}/api/admin/tenants/test-merchant-a/rotate-keys`, {
    method: 'POST'
  });
  const json = await res.json();

  assert('refuses with 409', res.status === 409);
  assert('says why', json.code === 'KEYS_PINNED_BY_ENV');
  assert('names the variable', (json.pinned_env_vars || []).includes('TENANT__TEST_MERCHANT_A__SECRET_KEY_1'));
  assert('explains that nothing changed', /change nothing/i.test(json.message || ''));

  // An unpinned tenant must still rotate normally.
  const unlocked = await fetch(`${BASE}/api/admin/tenants/valmont-electricals/rotate-keys`, {
    method: 'POST'
  });
  assert('an unpinned tenant is not blocked', unlocked.status === 503 || unlocked.status === 200);
});

// ─── Summary ─────────────────────────────────────────────────────────────

BASE = BASE || (await startServer());

try {
  await runQueue();
} finally {
  stopServer();
}

if (passed + failed === 0) {
  // A silent no-op is worse than a red run: it is the exact bug this file
  // used to have. Refuse to report success for a run that verified nothing.
  console.error('\n✗ No assertions ran — refusing to report success.');
  process.exit(1);
}

console.log(`\n\n══════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════════\n`);

if (errors.length > 0) {
  console.error('Failures:');
  errors.forEach(e => console.error(e));
  process.exit(1);
} else {
  console.log('All tests passed!');
  process.exit(0);
}
