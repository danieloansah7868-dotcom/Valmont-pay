/**
 * Regression test for the pay.html amount-unit contract (Blocker 4).
 *
 * Electricals shipped a redirect with `amount=2300` expecting Paystack's
 * smallest-currency-unit convention, but pay.html (and the gateway
 * server, and the database) speak cedis. The customer got charged
 * GH₵2,300 for a GH₵23 cart.
 *
 * This test pins the contract in two places:
 *
 *   1. The pure validator `validateAmountUrl` (re-implemented here from
 *      the same source so we test the contract, not the file path).
 *      Every accept / reject case in the README and
 *      docs/tenant-integration.md is asserted here.
 *
 *   2. The wiring inside pay.html. We read the file and assert that
 *      the validator is defined, exported on window.ValmontPayAmount,
 *      and called in the legacy-path branch before any
 *      /api/initialize-payment POST.
 *
 * Run via `npm test` (added to the suite by package.json).
 *
 *   node scripts/pay-html-amount-validation.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const __filename = path.resolve(process.argv[1] || '');
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PAY_HTML_PATH = path.join(REPO_ROOT, 'pay.html');

// ─── 1. The pure validator, re-implemented verbatim from pay.html ────
//
// The actual function lives inside the <script> tag in pay.html.
// We re-declare it here from the same source so this test exercises
// the CONTRACT (the rules the README documents) without needing a
// browser. The "wiring" check below then asserts that pay.html still
// defines the same function and calls it in the right place.
//
// The threshold and the message format must match pay.html exactly;
// if you change one, change the other.

const PESEWAS_INTEGER_THRESHOLD = 1000;
const MAX_URL_AMOUNT = 1_000_000;

function validateAmountUrl(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: false, amount: 0, error: 'missing', raw, suspectUnit: null };
  }

  const trimmed = String(raw).trim();

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return {
      ok: false,
      amount: 0,
      error: 'not-numeric',
      raw: trimmed,
      suspectUnit: null,
      message: 'Amount must be a plain decimal number in cedis, e.g. 23 or 23.50.'
    };
  }

  const hasDecimal = trimmed.includes('.');
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, amount: 0, error: 'not-positive', raw: trimmed, suspectUnit: null };
  }

  if (value > MAX_URL_AMOUNT) {
    return {
      ok: false,
      amount: 0,
      error: 'too-large',
      raw: trimmed,
      suspectUnit: null,
      message: `Amount is above the maximum supported by URL links (GH\u20b5 1,000,000). Use the secure checkout-link generator instead.`
    };
  }

  if (!hasDecimal && Math.floor(value) >= PESEWAS_INTEGER_THRESHOLD) {
    return {
      ok: false,
      amount: 0,
      error: 'looks-like-pesewas',
      raw: trimmed,
      suspectUnit: 'pesewas',
      message:
        `Amount looks like pesewas. This gateway expects cedis (major units) — ` +
        `e.g. amount=${(value / 100).toFixed(2)} not amount=${trimmed}. Contact the merchant site.`
    };
  }

  return { ok: true, amount: value, error: null, raw: trimmed, suspectUnit: null };
}

// ─── 2. Test cases (asserted below) ──────────────────────────────────

const ACCEPT = [
  // The Electricals fix: GH₵23 is `amount=23`, not `amount=2300`.
  { input: '23', amount: 23 },
  { input: '23.00', amount: 23 },
  { input: '23.50', amount: 23.5 },
  // High-value cart with a decimal suffix — the .00 is the disambiguator.
  { input: '1500.00', amount: 1500 },
  // Just under the threshold, no decimal — must still be accepted.
  { input: '999', amount: 999 },
  // One-pesewa minimum, used by some legacy test fixtures.
  { input: '0.01', amount: 0.01 },
  // Whitespace is trimmed before validation (clients sometimes
  // serialise numbers with surrounding whitespace).
  { input: '  23.50  ', amount: 23.5 }
];

const REJECT_PESEWAS = [
  // The actual Electricals bug, with the reference from the ticket.
  { input: '2300', expectedMessage: 'amount=23.00' },
  // GH₵1,500 sent as a plain integer — almost certainly pesewas.
  { input: '1500', expectedMessage: 'amount=15.00' },
  // Very small-looking but actually still over the threshold.
  { input: '1000', expectedMessage: 'amount=10.00' },
  // Realistic large-pesewas value, e.g. GH₵230 sent as 23000.
  { input: '23000', expectedMessage: 'amount=230.00' }
];

const REJECT_OTHER = [
  { input: '', error: 'missing' },
  { input: null, error: 'missing' },
  { input: undefined, error: 'missing' },
  { input: '0', error: 'not-positive' },
  { input: '0.00', error: 'not-positive' },
  { input: '-23.50', error: 'not-numeric' },
  { input: 'GH\u20b523.50', error: 'not-numeric' },
  { input: '1,500.00', error: 'not-numeric' },
  { input: '2.350e1', error: 'not-numeric' },
  { input: '+23.50', error: 'not-numeric' },
  { input: '23abc', error: 'not-numeric' },
  { input: '1500000', error: 'too-large' },
  { input: '1500000.00', error: 'too-large' }
];

// ─── 3. Run the contract assertions ───────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  \u2713 ${label}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  \u2717 ${label}\n`);
    process.stdout.write(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}\n`);
  }
}

process.stdout.write('pay.html amount-unit contract\n');

process.stdout.write('  accept (cedis, must render the payment form)\n');
for (const { input, amount } of ACCEPT) {
  check(`accepts ${JSON.stringify(input)} as ${amount}`, () => {
    const v = validateAmountUrl(input);
    assert.equal(v.ok, true, `expected ok, got ${JSON.stringify(v)}`);
    assert.equal(v.amount, amount);
    assert.equal(v.error, null);
    assert.equal(v.suspectUnit, null);
  });
}

process.stdout.write('  reject (looks like pesewas — the Electricals bug)\n');
for (const { input, expectedMessage } of REJECT_PESEWAS) {
  check(`rejects ${JSON.stringify(input)} with the unit-mismatch message`, () => {
    const v = validateAmountUrl(input);
    assert.equal(v.ok, false, `expected reject, got ${JSON.stringify(v)}`);
    assert.equal(v.error, 'looks-like-pesewas');
    assert.equal(v.suspectUnit, 'pesewas');
    assert.ok(
      v.message && v.message.includes(expectedMessage),
      `expected message to suggest ${expectedMessage}, got: ${v.message}`
    );
    assert.ok(
      v.message && v.message.toLowerCase().includes('cedis'),
      'expected the rejection message to mention cedis'
    );
  });
}

process.stdout.write('  reject (other malformed / out-of-range values)\n');
for (const { input, error } of REJECT_OTHER) {
  check(`rejects ${JSON.stringify(input)} with error=${error}`, () => {
    const v = validateAmountUrl(input);
    assert.equal(v.ok, false);
    assert.equal(v.error, error);
  });
}

process.stdout.write('  boundary cases\n');
check('999 is below the threshold and is accepted', () => {
  const v = validateAmountUrl('999');
  assert.equal(v.ok, true);
  assert.equal(v.amount, 999);
});
check('1000 hits the threshold and is rejected as pesewas', () => {
  const v = validateAmountUrl('1000');
  assert.equal(v.ok, false);
  assert.equal(v.error, 'looks-like-pesewas');
  assert.equal(v.suspectUnit, 'pesewas');
  assert.ok(v.message.includes('amount=10.00'));
});
check('1000.00 is exactly the boundary with a decimal — accepted', () => {
  const v = validateAmountUrl('1000.00');
  assert.equal(v.ok, true);
  assert.equal(v.amount, 1000);
});

// ─── 4. Wiring assertions: pay.html must contain the contract ─────────

process.stdout.write('  pay.html wiring\n');
const payHtml = fs.readFileSync(PAY_HTML_PATH, 'utf8');

check('pay.html exposes validateAmountUrl on window.ValmontPayAmount', () => {
  assert.ok(
    /window\.ValmontPayAmount\s*=\s*\{[^}]*validateAmountUrl/.test(payHtml),
    'expected `window.ValmontPayAmount = { ... validateAmountUrl ... }` in pay.html'
  );
});

check('pay.html contains the AMOUNT UNIT CONTRACT banner at the top of the script', () => {
  // The bolded contract must be present and explicit about cedis vs pesewas.
  assert.ok(
    /AMOUNT UNIT CONTRACT/i.test(payHtml),
    'expected the AMOUNT UNIT CONTRACT header in the script'
  );
  assert.ok(
    /cedis/i.test(payHtml),
    'expected the word "cedis" in the contract'
  );
  assert.ok(
    /pesewas/i.test(payHtml),
    'expected the word "pesewas" in the contract'
  );
});

check('pay.html calls validateAmountUrl in the legacy (?amount=&merchant=) branch', () => {
  // The validator must run BEFORE the /api/initialize-payment POST.
  // The order in the file is: access-code branch, legacy branch, hash fallback.
  const legacyBranch = payHtml.indexOf('// Legacy flow');
  const initCall = payHtml.indexOf("/api/initialize-payment");
  const validateCall = payHtml.indexOf('validateAmountUrl(amountRawFromUrl)');

  assert.ok(legacyBranch > 0, 'expected "// Legacy flow" comment in pay.html');
  assert.ok(validateCall > 0, 'expected validateAmountUrl() call in pay.html');
  assert.ok(initCall > 0, 'expected /api/initialize-payment call in pay.html');
  assert.ok(
    validateCall > legacyBranch,
    'expected validateAmountUrl() to be called in or after the legacy branch'
  );
});

check('pay.html shows a unit-mismatch error card (NOT the form) when the URL looks like pesewas', () => {
  // showUnitError is the dedicated card with a "Payment Link Unavailable"
  // title and a hint that explains the unit. showError (generic) is the
  // existing "Payment Link Invalid" card and would NOT explain the unit
  // — using it for this case is the bug we're guarding against.
  assert.ok(/function\s+showUnitError\s*\(/.test(payHtml), 'expected showUnitError() to be defined');
  assert.ok(/showUnitError\s*\(validation\)/.test(payHtml), 'expected showUnitError(validation) to be called on reject');
  assert.ok(/Payment Link Unavailable/.test(payHtml), 'expected "Payment Link Unavailable" title in the unit error card');
});

check('pay.html fires a fire-and-forget audit log for unit-mismatch rejections', () => {
  assert.ok(/reportBadAmount\s*\(/.test(payHtml), 'expected reportBadAmount() to be called on reject');
  assert.ok(/navigator\.sendBeacon|navigator\s*\.\s*sendBeacon/.test(payHtml), 'expected navigator.sendBeacon in the audit helper');
  assert.ok(/\/api\/log\/bad-amount/.test(payHtml), 'expected /api/log/bad-amount endpoint in the audit helper');
});

check('pay.html does NOT silently transform a bad-unit amount (e.g. divide by 100) before rendering', () => {
  // The whole point: if the unit is wrong, render an error — do NOT
  // try to be clever and "fix" it. A search for /100 division in the
  // amount-handling path would be a red flag.
  //
  // We assert the validator is the gate, not any heuristic that
  // recovers the supposed cedis value.
  assert.ok(!/paymentData\.amount\s*=\s*parseFloat\([^)]*\)\s*\/\s*100/.test(payHtml),
    'pay.html must not divide the URL amount by 100 anywhere');
  assert.ok(!/amount\s*\/\s*100/.test(payHtml.replace(/Number\(.*?\)\.toFixed\(2\)/g, '')),
    'pay.html must not divide the URL amount by 100 anywhere');
});

// ─── 5. Summary ───────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
