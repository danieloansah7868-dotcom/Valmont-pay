/**
 * The one place where a payment reaches a terminal state.
 *
 * Every route that can finish a payment (the checkout page, the Paystack
 * webhook, a manual dashboard action, a refund) calls `settle()`. That is what
 * makes "exactly one webhook per payment" true: the transition and the webhook
 * enqueue happen together, both keyed off the reference, both idempotent.
 *
 *   settle() -> payments.markTerminal()  (idempotent, first write wins)
 *            -> webhookDelivery.enqueue() (idempotent per reference+event)
 *            -> returns the redirect URL for the customer's browser
 */

const payments = require('./payments');
const webhookDelivery = require('./webhook-delivery');
const ledger = require('./ledger');
const money = require('./money');

/** Map an internal status to the `status` query param on the return redirect. */
const REDIRECT_STATUS = Object.freeze({
  [payments.STATUS.SUCCESS]: 'success',
  [payments.STATUS.FAILED]: 'failed',
  [payments.STATUS.CANCELLED]: 'cancelled',
  [payments.STATUS.REFUNDED]: 'success'
});

/**
 * Build the merchant return URL.
 *
 * COSMETIC ONLY. Customers close the tab, lose signal, or hit back — this
 * redirect is best-effort UX, and the merchant is told (loudly, in the README)
 * to treat the webhook as the source of truth and this as a hint that lets them
 * show a nice "thank you" page.
 *
 * Existing query parameters on the merchant's callback_url are preserved; `ref`
 * and `status` are appended (overwriting any same-named params).
 *
 * @returns {string|null} null when the merchant supplied no usable callback_url
 */
function buildRedirectUrl(callbackUrl, reference, status) {
  if (!callbackUrl) return null;
  let url;
  try {
    url = new URL(String(callbackUrl));
  } catch (_) {
    console.warn(`[GATEWAY] Ignoring unparsable callback_url for ${reference}: ${callbackUrl}`);
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  url.searchParams.set('ref', reference);
  url.searchParams.set('status', REDIRECT_STATUS[status] || status);
  return url.toString();
}

/**
 * Finish a payment.
 *
 * @param {string} reference opaque merchant reference — never parsed
 * @param {object} input
 * @param {'success'|'failed'|'cancelled'|'refunded'} input.status
 * @param {string} [input.channel]           mobile_money | card | bank_transfer …
 * @param {string} [input.gateway_reference] Paystack's own reference
 * @param {string} [input.paid_at]
 * @param {string} [input.failure_reason]
 * @returns {{ok:boolean, changed:boolean, error?:string, record:object|null,
 *   data:object|null, event:string|null, delivery:object|null, redirect_url:string|null}}
 */
function settle(reference, input = {}) {
  const transition = payments.markTerminal(reference, input);

  if (!transition.ok) {
    return {
      ok: false,
      changed: false,
      error: transition.error,
      record: transition.record,
      data: payments.toPublicData(transition.record),
      event: null,
      delivery: null,
      redirect_url: transition.record
        ? buildRedirectUrl(transition.record.callback_url, reference, transition.record.status)
        : null
    };
  }

  const record = transition.record;

  // Mirror onto the existing in-memory ledger so the legacy dashboard views
  // and /api/transactions keep working unchanged.
  if (transition.changed) {
    ledger.upsertTransaction({
      reference: record.reference,
      customer: record.email || 'unknown@customer',
      amount: money.toMajor(record.amount),
      channel: record.channel || 'Unknown',
      status: record.status === payments.STATUS.SUCCESS ? 'SUCCESS' : record.status.toUpperCase(),
      merchant: record.merchant,
      timestamp: record.paid_at || record.updated_at
    });
  }

  // Only a REAL state change produces a webhook. A duplicate settle for a
  // reference that is already terminal returns changed:false and enqueues
  // nothing — one payment, one webhook.
  let delivery = null;
  if (transition.changed && transition.event) {
    const queued = webhookDelivery.enqueue({ payment: record, event: transition.event });
    delivery = queued.delivery;
  }

  return {
    ok: true,
    changed: transition.changed,
    record,
    data: payments.toPublicData(record),
    event: transition.event,
    delivery,
    redirect_url: buildRedirectUrl(record.callback_url, record.reference, record.status)
  };
}

/** Convenience wrapper: refund a settled payment (emits `refund.processed`). */
function refund(reference, input = {}) {
  return settle(reference, { ...input, status: payments.STATUS.REFUNDED });
}

module.exports = { REDIRECT_STATUS, buildRedirectUrl, settle, refund };
