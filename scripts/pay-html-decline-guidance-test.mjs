#!/usr/bin/env node

/**
 * Behavioural tests for the DECLINED-PAYMENT guidance on pay.html.
 *
 * ── What this protects ──────────────────────────────────────────────────
 *
 * A real customer's card was blocked by Paystack's fraud system ("Denied by
 * Fraud System") for a GH₵ 24,150 payment. Their reaction — the only one the
 * page invited — was to tap Pay again: the failure path was a bare
 * `alert(error.message)` followed by re-arming the Pay button. Paystack's block
 * stays active for ~24 hours from the LAST attempt, so every retry restarted the
 * clock. The customer was making their own lockout longer, from a screen that
 * told them nothing.
 *
 * These tests EXECUTE pay.html against the stub DOM harness and assert on what
 * the customer is actually shown after a failure:
 *
 *   1. A failure renders the guidance card, NOT a bare alert, and the Pay
 *      button is not re-armed behind their back.
 *   2. The gateway's message is echoed VERBATIM (their bank will ask for it) and
 *      can never inject markup — it reaches the DOM via textContent only.
 *   3. A security-block message ("Denied by Fraud System", "Unable to process
 *      transaction") gets the do-not-retry warning and a button that does not
 *      invite an immediate retry.
 *   4. A benign decline ("Insufficient Funds", "Card expired") keeps the plain
 *      "Try Again" — we do not scare people away from a simple retry.
 *   5. Repeat failures escalate ("you have now tried 2 times").
 *   6. The reference is shown, so the merchant can look the attempt up.
 *   7. Going back re-arms the Pay button.
 *
 *   node scripts/pay-html-decline-guidance-test.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPayHtml, PAY_HTML_PATH } from './lib/pay-html-harness.mjs';

const PAY_HTML = readFileSync(PAY_HTML_PATH, 'utf8');

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`PASS - ${label}`);
  } else {
    failed++;
    console.log(`FAIL - ${label}`);
  }
}

const ACCESS_CODE = 'ac_decline_test';
const URL_FOR_PAGE = `https://valmontpay.app/pay.html?access_code=${ACCESS_CODE}`;

const PAYMENT = {
  amount: 24150,
  reference: 'VP-MV9IYVC3-03433149',
  merchant: 'valmont-electricals',
  display_name: 'Valmont Electricals',
  email: 'buyer@example.com',
  currency: 'GHS'
};

/**
 * A page whose stored payment intent resolves, with a PaystackPop stub that
 * hands back the callbacks so the test can fire a real failure.
 */
async function openPage() {
  let handlers = null;
  class FakePaystackPop {
    resumeTransaction(accessCode, options) {
      handlers = options;
    }
  }

  const page = loadPayHtml({
    url: URL_FOR_PAGE,
    paystack: FakePaystackPop,
    fetch: async url => {
      if (url.includes('/api/transaction/access/')) {
        return { ok: true, json: async () => ({ status: true, data: PAYMENT }) };
      }
      if (url.includes('/api/initialize-payment')) {
        return {
          ok: true,
          json: async () => ({
            status: true,
            success: true,
            accessCode: 'ac_gateway_1',
            reference: PAYMENT.reference,
            data: { access_code: 'ac_gateway_1', reference: PAYMENT.reference }
          })
        };
      }
      return { ok: true, json: async () => ({ status: true }) };
    }
  });

  await page.load();
  await page.call('openEmbeddedCheckout("ac_gateway_1", "' + PAYMENT.reference + '")');

  return {
    page,
    el: id => page.document.getElementById(id),
    /** Fire the gateway's failure callback, exactly as PaystackPop would. */
    failWith: async message => {
      handlers.onError({ message });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
}

// ───────────────────────────────────── 1. a block message gets the warning
console.log('\n# "Denied by Fraud System" — the real case');

{
  const { page, el, failWith } = await openPage();
  check('the pay form is up before any attempt', page.showsPayForm);
  check('the decline card is hidden before any attempt', !el('declinedState').visible);
  check('no alert is raised just by opening the checkout', page.alerts.length === 0);

  await failWith('Denied by Fraud System.');

  check('the failure shows the guidance card', el('declinedState').visible);
  check('the pay form is hidden behind it', !page.showsPayForm);
  check('no bare alert() is used for a decline', page.alerts.length === 0);
  check(
    'the gateway message is echoed VERBATIM',
    el('declinedMessage').textContent === 'Denied by Fraud System.'
  );
  check(
    'the message reaches the DOM as text, never as markup',
    el('declinedMessage').innerHTML === ''
  );
  check('the do-not-retry warning is shown for a block', el('declinedBlockWarning').visible);
  check(
    'the warning explains that retrying extends the block (~24 hours)',
    /24 hours/.test(el('declinedBlockBody').textContent)
  );
  check(
    'the button does NOT invite an immediate retry',
    el('btnDeclineBack').textContent === 'Back to Payment Details'
  );
  check(
    'the reference is shown so the merchant can trace the attempt',
    el('declinedReference').textContent === PAYMENT.reference
  );
  check(
    'the card tells the customer that nothing was charged',
    /no money has left your account/i.test(PAY_HTML)
  );
  check(
    'the card points at bank transfer / mobile money as an alternative',
    /another way to pay/i.test(PAY_HTML)
  );
}

// ────────────────────────────── 2. "Unable to process transaction" is a block
console.log('\n# "Unable to process transaction" — same fraud system, friendlier words');

{
  const { el, failWith } = await openPage();
  await failWith('Unable to process transaction');
  check('the block warning is shown for this wording too', el('declinedBlockWarning').visible);
  check(
    'the message is still echoed verbatim',
    el('declinedMessage').textContent === 'Unable to process transaction'
  );
}

// ─────────────────────────── 3. a benign decline keeps the simple retry
console.log('\n# "Insufficient Funds" — a normal retry must stay easy');

{
  const { page, el, failWith } = await openPage();
  await failWith('Insufficient Funds');

  check('the guidance card is still shown', el('declinedState').visible);
  check('the do-not-retry warning is NOT shown', !el('declinedBlockWarning').visible);
  check('the button says Try Again', el('btnDeclineBack').textContent === 'Try Again');
  check(
    'the reason is still recorded verbatim',
    el('declinedMessage').textContent === 'Insufficient Funds'
  );
  check('still no alert()', page.alerts.length === 0);
}

// ─────────────────────────────────────── 4. repeat attempts escalate
console.log('\n# repeat failures');

{
  const { el, failWith } = await openPage();
  await failWith('Denied by Fraud System.');
  const firstWarning = el('declinedBlockBody').textContent;
  await failWith('Denied by Fraud System.');

  check(
    'the second failure counts the attempts out loud',
    /tried 2 times/i.test(el('declinedBlockBody').textContent)
  );
  check(
    'the copy escalates from the first failure',
    el('declinedBlockBody').textContent !== firstWarning
  );
  check('it still points at the 24-hour wait', /24 hours/.test(el('declinedBlockBody').textContent));
}

// ─────────────────────────────── 5. going back re-arms the Pay button
console.log('\n# back to the payment form');

{
  const { page, el, failWith } = await openPage();

  // Drive the real button path: fill the form, let payWithValmontPay() ask the
  // server for an access code and open the checkout itself.
  page.document.getElementById('customerEmail').value = PAYMENT.email;
  page.document.getElementById('customerPhone').value = '0244000000';
  await page.call('payWithValmontPay()');

  check('the Pay button is disabled while the checkout is open', el('btnPayWithPaystack').disabled === true);
  check('the checkout was initialized through the real button path', Boolean(page.initializeCall));

  await failWith('Denied by Fraud System.');
  check(
    'the Pay button is NOT silently re-armed behind the guidance card',
    el('btnPayWithPaystack').disabled === true
  );

  await page.call('returnToPayment()');
  check('returning hides the guidance card', !el('declinedState').visible);
  check('returning shows the payment form again', page.showsPayForm);
  check('the Pay button is re-armed on an explicit return', el('btnPayWithPaystack').disabled === false);
  check(
    'the button label is restored',
    el('btnPayWithPaystack').textContent === 'Pay Securely via Valmont-Pay'
  );
}

// ───────────────────────────────── 6. hostile gateway text cannot inject
console.log('\n# a hostile error string');

{
  const { page, el, failWith } = await openPage();
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  await failWith(hostile);

  check('the hostile string is stored as text', el('declinedMessage').textContent === hostile);
  check('no markup was injected into the message node', el('declinedMessage').innerHTML === '');
  check('no script executed from the failure path', page.alerts.length === 0);
}

// ──────────────────────────────────────── 7. empty message still renders
console.log('\n# a failure with no message at all');

{
  const { page, el, failWith } = await openPage();
  await failWith(undefined);
  check('a missing message falls back to readable copy', el('declinedMessage').textContent.length > 0);
  check('the fallback never reads "undefined"', !/undefined/.test(el('declinedMessage').textContent));
  check('the card is shown', el('declinedState').visible);
  check('no alert() fallback', page.alerts.length === 0);
}

console.log(
  failed === 0
    ? `\nAll checks passed (${passed}).`
    : `\n${failed} check(s) failed (${passed} passed).`
);
process.exit(failed === 0 ? 0 : 1);
