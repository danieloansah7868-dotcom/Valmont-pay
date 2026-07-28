/**
 * Outbound webhook delivery.
 *
 * Contract with the merchant
 * --------------------------
 *   POST <merchant webhook url>
 *   Content-Type: application/json
 *   x-valmontpay-signature: <hex HMAC-SHA512 of the RAW body, key = secret key>
 *
 *   { "event": "charge.success",
 *     "data": { reference, status, amount, currency, channel, paid_at,
 *               merchant, gateway_reference } }
 *
 * The signature scheme is deliberately identical to Paystack's
 * (`hmac_sha512(raw_body, secret_key)`, hex, one header), so a merchant already
 * verifying `x-paystack-signature` only has to change the header name:
 *
 *   const hash = crypto.createHmac('sha512', SECRET).update(req.rawBody).digest('hex');
 *   if (hash !== req.headers['x-valmontpay-signature']) return res.sendStatus(401);
 *
 * Idempotency
 * -----------
 * The body is serialised ONCE, when the delivery is created, and every retry
 * re-sends those exact bytes with the same `x-valmontpay-event-id`. So the
 * signature stays valid, and a merchant that de-duplicates on event id (or on
 * reference + event) sees one logical event no matter how many times the
 * network made us try. Exactly one delivery is ever created per (reference,
 * event) pair — see `enqueue()`.
 *
 * Retries
 * -------
 * Exponential backoff with jitter, capped at 6 hours between attempts, giving
 * up after ~24 hours. Anything 2xx is success. Everything else (including a
 * timeout or DNS failure) is retried.
 */

const crypto = require('crypto');
const { collection } = require('./data-store');
const merchants = require('./merchants');
const payments = require('./payments');

const deliveries = collection('webhook-deliveries');

/** Retry schedule, in seconds from the previous attempt. ~24h of coverage. */
const BACKOFF_SECONDS = Object.freeze([
  0,      // attempt 1: immediately
  30,     // +30s
  60,     // +1m
  300,    // +5m
  900,    // +15m
  1800,   // +30m
  3600,   // +1h
  7200,   // +2h
  10800,  // +3h
  21600,  // +6h
  21600,  // +6h
  21600   // +6h  -> ~24h total
]);

const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = Number(process.env.VALMONTPAY_WEBHOOK_TIMEOUT_MS) || 15000;
/** How often the scheduler wakes up to look for due retries. */
const TICK_MS = Number(process.env.VALMONTPAY_WEBHOOK_TICK_MS) || 15000;

const STATE = Object.freeze({
  PENDING: 'pending',
  DELIVERED: 'delivered',
  FAILED: 'failed',      // gave up after the retry window
  DISABLED: 'disabled'   // no webhook URL configured
});

let timer = null;
let ticking = false;
/** Swappable for tests. */
let fetchImpl = (...args) => globalThis.fetch(...args);

function setFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

function now() {
  return new Date().toISOString();
}

function newEventId() {
  return `evt_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * HMAC-SHA512 of the raw body, hex encoded. Paystack's exact scheme.
 * @param {string} rawBody the literal bytes that will be sent
 * @param {string} secret the merchant's secret key
 */
function sign(rawBody, secret) {
  return crypto.createHmac('sha512', String(secret)).update(rawBody, 'utf8').digest('hex');
}

/** Verify a signature, constant-time. Exported so merchants/tests can reuse it. */
function verifySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = Buffer.from(sign(rawBody, secret), 'utf8');
  const received = Buffer.from(String(signature), 'utf8');
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

/**
 * Deliveries are keyed by mode + reference + event: one payment, one webhook.
 * The mode is part of the key for the same reason it is part of a payment's
 * key — a test rehearsal of `VE-BK-123456` must not suppress the live one.
 */
function deliveryId(reference, event, mode = 'live') {
  return `${mode}::${reference}::${event}`;
}

/**
 * Create the single delivery for a terminal payment event.
 *
 * Idempotent: calling it twice for the same (reference, event) returns the
 * EXISTING delivery untouched — same event id, same body, same signature. That
 * is the guarantee that a merchant never receives two webhooks for one payment.
 *
 * @param {object} options
 * @param {object} options.payment payment record
 * @param {string} options.event   charge.success | charge.failed | refund.processed
 * @param {boolean} [options.dispatch=true] send immediately
 * @returns {{ok:boolean, created:boolean, delivery:object|null, error?:string}}
 */
function enqueue(options = {}) {
  const payment = options.payment;
  const event = options.event;
  if (!payment || !event) return { ok: false, created: false, delivery: null, error: 'payment and event are required' };

  const id = deliveryId(payment.reference, event, payment.mode);
  const existing = deliveries.get(id);
  if (existing) {
    console.log(`[WEBHOOK-OUT] ${id} already queued (${existing.state}); not duplicating.`);
    return { ok: true, created: false, delivery: existing };
  }

  const merchant = merchants.getMerchant(payment.merchant_id) || merchants.getDefaultMerchant();
  const mode = payment.mode || 'live';
  const url = merchants.getWebhookUrl(merchant, mode);
  const secret = merchants.signingSecret(merchant, mode);

  // The body is frozen HERE, once. Every attempt re-sends these exact bytes.
  const payload = { event, data: payments.toPublicData(payment) };
  const body = JSON.stringify(payload);

  const delivery = {
    id,
    event_id: newEventId(),
    event,
    reference: payment.reference,
    merchant_id: merchant.id,
    merchant: merchant.name,
    mode,
    url: url || null,
    body,
    signature: secret ? sign(body, secret) : null,
    state: url ? STATE.PENDING : STATE.DISABLED,
    attempt_count: 0,
    /** @type {Array<object>} newest last */
    attempts: [],
    created_at: now(),
    next_attempt_at: url ? now() : null,
    delivered_at: null,
    expires_at: new Date(Date.now() + MAX_WINDOW_MS).toISOString(),
    updated_at: now()
  };

  deliveries.set(id, delivery);

  if (!url) {
    console.warn(
      `[WEBHOOK-OUT] ${merchant.name} has no ${mode} webhook URL configured — ` +
        `${event} for ${payment.reference} was recorded but not sent. Set one in the dashboard, then replay.`
    );
    return { ok: true, created: true, delivery };
  }

  console.log(`[WEBHOOK-OUT] Queued ${event} for ${payment.reference} -> ${url}`);
  if (options.dispatch !== false) {
    // Fire and forget: the customer's redirect must never wait on the merchant.
    attempt(id).catch(error => console.error('[WEBHOOK-OUT] Dispatch error:', error.message));
  }
  return { ok: true, created: true, delivery };
}

function backoffMs(attemptNumber) {
  const base = BACKOFF_SECONDS[Math.min(attemptNumber, BACKOFF_SECONDS.length - 1)] * 1000;
  // Up to 20% jitter so a fleet of retries does not stampede the merchant.
  return Math.round(base * (1 + Math.random() * 0.2));
}

/**
 * Make one HTTP attempt. Never throws.
 * @returns {Promise<object>} the updated delivery record
 */
async function attempt(id) {
  const delivery = deliveries.get(id);
  if (!delivery) return null;
  if (delivery.state === STATE.DELIVERED) return delivery;
  if (!delivery.url) {
    delivery.state = STATE.DISABLED;
    deliveries.set(id, delivery);
    return delivery;
  }

  const attemptNumber = delivery.attempt_count + 1;
  const startedAt = Date.now();
  const record = {
    attempt: attemptNumber,
    at: now(),
    url: delivery.url,
    status_code: null,
    ok: false,
    duration_ms: 0,
    error: null,
    response_snippet: null
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ValmontPay/1.0 (+https://valmontpay.app)',
        'x-valmontpay-signature': delivery.signature || '',
        // Stable across every retry — de-duplicate on this.
        'x-valmontpay-event-id': delivery.event_id,
        'x-valmontpay-event': delivery.event,
        'x-valmontpay-reference': delivery.reference,
        'x-valmontpay-attempt': String(attemptNumber)
      },
      body: delivery.body,
      signal: controller.signal
    });

    record.status_code = response.status;
    record.ok = response.status >= 200 && response.status < 300;
    try {
      const text = await response.text();
      record.response_snippet = text ? text.slice(0, 500) : null;
    } catch (_) {
      /* body is optional — the status code is what matters */
    }
  } catch (error) {
    record.error = error.name === 'AbortError' ? `Timed out after ${REQUEST_TIMEOUT_MS}ms` : error.message;
  } finally {
    clearTimeout(timeout);
  }

  record.duration_ms = Date.now() - startedAt;

  delivery.attempt_count = attemptNumber;
  delivery.attempts.push(record);
  // Keep the log bounded; the most recent attempts are the interesting ones.
  if (delivery.attempts.length > 30) delivery.attempts = delivery.attempts.slice(-30);
  delivery.updated_at = now();

  if (record.ok) {
    delivery.state = STATE.DELIVERED;
    delivery.delivered_at = now();
    delivery.next_attempt_at = null;
    console.log(
      `[WEBHOOK-OUT] ${delivery.event} ${delivery.reference} delivered (HTTP ${record.status_code}) on attempt ${attemptNumber}`
    );
  } else {
    const windowClosed = Date.parse(delivery.expires_at) <= Date.now();
    if (attemptNumber >= MAX_ATTEMPTS || windowClosed) {
      delivery.state = STATE.FAILED;
      delivery.next_attempt_at = null;
      console.error(
        `[WEBHOOK-OUT] ${delivery.event} ${delivery.reference} GAVE UP after ${attemptNumber} attempt(s) over ~24h. ` +
          'The merchant must reconcile via GET /api/transaction/verify/{reference}, or replay from the dashboard.'
      );
    } else {
      delivery.state = STATE.PENDING;
      delivery.next_attempt_at = new Date(Date.now() + backoffMs(attemptNumber)).toISOString();
      console.warn(
        `[WEBHOOK-OUT] ${delivery.event} ${delivery.reference} attempt ${attemptNumber} failed ` +
          `(${record.status_code || record.error}); retrying at ${delivery.next_attempt_at}`
      );
    }
  }

  deliveries.set(id, delivery);
  return delivery;
}

/** Deliver every attempt that is due. Called by the scheduler and by tests. */
async function processDue(referenceTime = Date.now()) {
  const due = deliveries.filter(
    d => d.state === STATE.PENDING && d.next_attempt_at && Date.parse(d.next_attempt_at) <= referenceTime
  );
  for (const delivery of due) {
    // Sequential: a merchant endpoint under load should not be hit in parallel.
    await attempt(delivery.id);
  }
  return due.length;
}

/**
 * Replay a delivery by hand from the dashboard.
 *
 * A replay re-sends the SAME frozen body and the SAME event id, so it is
 * indistinguishable from an automatic retry to a correctly written merchant
 * handler — which is exactly the point. It also re-signs with the merchant's
 * CURRENT secret and re-reads the CURRENT webhook URL, so a replay is how you
 * recover after fixing a wrong URL or rotating a key.
 */
async function replay(id) {
  const delivery = deliveries.get(id);
  if (!delivery) return { ok: false, error: 'Unknown delivery' };

  const merchant = merchants.getMerchant(delivery.merchant_id);
  const url = merchant ? merchants.getWebhookUrl(merchant, delivery.mode) : null;
  if (!url) return { ok: false, error: 'No webhook URL is configured for this mode' };

  const secret = merchants.signingSecret(merchant, delivery.mode);
  delivery.url = url;
  delivery.signature = sign(delivery.body, secret);
  delivery.state = STATE.PENDING;
  delivery.next_attempt_at = now();
  // A manual replay reopens the retry window rather than resuming an exhausted one.
  delivery.expires_at = new Date(Date.now() + MAX_WINDOW_MS).toISOString();
  delivery.attempt_count = 0;
  delivery.updated_at = now();
  deliveries.set(id, delivery);

  const result = await attempt(id);
  return { ok: true, delivery: result };
}

/** Start the background retry loop. Safe to call more than once. */
function startScheduler() {
  if (timer) return timer;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    processDue()
      .catch(error => console.error('[WEBHOOK-OUT] Scheduler error:', error.message))
      .finally(() => { ticking = false; });
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[WEBHOOK-OUT] Retry scheduler running every ${TICK_MS}ms`);
  return timer;
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

function get(id) {
  return deliveries.get(id);
}

function list(filter = {}) {
  return deliveries
    .filter(d => {
      if (filter.merchantId && d.merchant_id !== filter.merchantId) return false;
      if (filter.mode && d.mode !== filter.mode) return false;
      if (filter.reference && d.reference !== filter.reference) return false;
      if (filter.state && d.state !== filter.state) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
}

/** Delivery record shaped for the dashboard (parsed body, no secrets). */
function toDashboardJSON(delivery) {
  if (!delivery) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(delivery.body);
  } catch (_) {
    parsed = null;
  }
  const last = delivery.attempts[delivery.attempts.length - 1] || null;
  return {
    id: delivery.id,
    event_id: delivery.event_id,
    event: delivery.event,
    reference: delivery.reference,
    merchant: delivery.merchant,
    mode: delivery.mode,
    url: delivery.url,
    state: delivery.state,
    attempt_count: delivery.attempt_count,
    max_attempts: MAX_ATTEMPTS,
    created_at: delivery.created_at,
    delivered_at: delivery.delivered_at,
    next_attempt_at: delivery.next_attempt_at,
    expires_at: delivery.expires_at,
    last_status_code: last ? last.status_code : null,
    last_error: last ? last.error : null,
    payload: parsed,
    // Shown so a merchant can reproduce the HMAC locally while debugging.
    signature: delivery.signature,
    attempts: delivery.attempts
  };
}

/** Test helper. */
function _reset() {
  deliveries.clear();
}

module.exports = {
  STATE,
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  MAX_WINDOW_MS,
  REQUEST_TIMEOUT_MS,
  deliveries,
  sign,
  verifySignature,
  deliveryId,
  enqueue,
  attempt,
  processDue,
  replay,
  startScheduler,
  stopScheduler,
  get,
  list,
  toDashboardJSON,
  setFetch,
  _reset
};
