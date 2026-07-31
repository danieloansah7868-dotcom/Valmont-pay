/**
 * Offline smoke test for the Paystack serverless handlers.
 * Stubs global fetch so no real network/secret key is needed.
 *   node scripts/api-smoke-test.mjs
 */
process.env.PAYSTACK_SECRET_KEY = 'sk_test_fake';

// This is an offline Paystack handler test. CI injects real Supabase secrets for
// the persistence-specific suites later in `npm test`; keep those credentials
// out of this process so verify-payment cannot make a real database write.
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  if (String(url).includes('/initialize')) {
    return {
      json: async () => ({
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/abc',
          access_code: 'abc',
          reference: JSON.parse(opts.body).reference
        }
      })
    };
  }
  return {
    json: async () => ({
      status: true,
      message: 'Verification successful',
      data: {
        reference: 'VP-111222',
        status: 'success',
        amount: 5000,
        currency: 'GHS',
        channel: 'card',
        paid_at: '2026-07-25T10:00:00Z',
        customer: { email: 'test@example.com' },
        metadata: { merchant: 'Valmont Electricals' }
      }
    })
  };
};

const mkRes = () => {
  const r = {};
  r.status = c => { r._c = c; return r; };
  r.json = b => { r._b = b; return r; };
  return r;
};

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${msg}`);
  if (!cond) failures++;
};

const init = (await import('../api/initialize-payment.js')).default;
const verify = (await import('../api/verify-payment.js')).default;

// 1. initialize with amount 50 and an explicit reference
let res = mkRes();
await init(
  { method: 'POST', body: { email: 'test@example.com', amount: 50, reference: 'VP-111222', merchant: 'Valmont Electricals' } },
  res
);
const sent = JSON.parse(calls[0].opts.body);
console.log('  sent to Paystack:', JSON.stringify(sent));
check(res._c === 200, 'initialize returns 200');
check(sent.amount === 5000, 'GH\u20b5 50 is sent as 5000 pesewas (x100)');
check(sent.reference === 'VP-111222', 'reference is forwarded to Paystack');
check(sent.currency === 'GHS', 'currency is GHS');
check(calls[0].opts.headers.Authorization === 'Bearer sk_test_fake', 'secret key auth header set');
check(res._b.reference === 'VP-111222', 'handler echoes the reference back');

// 2. rounding
calls.length = 0;
res = mkRes();
await init({ method: 'POST', body: { email: 'a@b.com', amount: 50.1, reference: 'VP-2' } }, res);
check(JSON.parse(calls[0].opts.body).amount === 5010, 'GH\u20b5 50.10 rounds to exactly 5010 pesewas');

// 3. no amount -> rejected (proves there is no hidden 450 fallback)
res = mkRes();
await init({ method: 'POST', body: { email: 'a@b.com' } }, res);
check(res._c === 400, 'missing amount is rejected (no hardcoded default)');

// 4. verify
res = mkRes();
await verify({ method: 'GET', query: { reference: 'VP-111222' } }, res);
check(res._c === 200, 'verify returns 200');
check(res._b.success === true, 'verify reports success for a paid transaction');
check(res._b.summary.amount === 50, 'verify converts 5000 pesewas back to GH\u20b5 50');
check(res._b.summary.merchant === 'Valmont Electricals', 'verify surfaces merchant metadata');
check(calls[calls.length - 1].url.includes('/transaction/verify/VP-111222'), 'verify hits the right Paystack URL');

// 5. verify without a reference
res = mkRes();
await verify({ method: 'GET', query: {} }, res);
check(res._c === 400, 'verify without a reference is rejected');

// 6. subaccount from body
calls.length = 0;
res = mkRes();
await init(
  { method: 'POST', body: { email: 'sub@example.com', amount: 30, subaccount: 'ACCT_testsub123' } },
  res
);
let sentSub = JSON.parse(calls[0].opts.body);
check(sentSub.subaccount === 'ACCT_testsub123', 'subaccount from req.body is forwarded in Paystack payload');

// 7. subaccount from query
calls.length = 0;
res = mkRes();
await init(
  { method: 'POST', body: { email: 'sub2@example.com', amount: 40 }, query: { subaccount: 'ACCT_testsub456' } },
  res
);
let sentSubQuery = JSON.parse(calls[0].opts.body);
check(sentSubQuery.subaccount === 'ACCT_testsub456', 'subaccount from req.query is forwarded in Paystack payload');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
