/**
 * Payment records — the server-side source of truth for "how much is this
 * customer supposed to pay?".
 *
 * WHY THIS EXISTS
 * ---------------
 * The legacy checkout link carries the amount in the query string:
 *
 *   /pay.html?amount=1500&merchant=Valmont+Electricals&ref=VE-MFA1B2C3
 *
 * A customer can edit `amount` to `1` and pay 1 pesewa for a GH₵ 15.00 order.
 * The fix is to make the browser carry an OPAQUE `access_code` instead, and to
 * resolve the amount here, server-side, from a record the merchant created with
 * its secret key. The legacy form keeps working, but its amount is treated as a
 * claim to be reconciled — never as the truth.
 *
 * THE REFERENCE IS OPAQUE
 * -----------------------
 * `VE-MFA1B2C3`, `VE-BK-123456`, `whatever/the/merchant/sends` — this module
 * never parses, splits, or interprets a reference. It is a primary key and an
 * idempotency key, nothing else. One payment maps to exactly one reference and
 * emits exactly one webhook per terminal event, regardless of how many orders
 * the merchant has stitched onto it on their side.
 */

const crypto = require('crypto');
const { collection } = require('./data-store');
const money = require('./money');

const store = collection('payments');
/** access_code -> reference. Rebuilt lazily from the payment store. */
const accessCodeIndex = new Map();

/** Access codes are single-use and short-lived: a checkout session, not a link. */
const ACCESS_CODE_TTL_MS = Number(process.env.VALMONTPAY_ACCESS_CODE_TTL_MS) || 60 * 60 * 1000;

const STATUS = Object.freeze({
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded'
});

/** States after which no further charge attempt is accepted. */
const TERMINAL_STATUSES = new Set([
  STATUS.SUCCESS,
  STATUS.FAILED,
  STATUS.CANCELLED,
  STATUS.REFUNDED
]);

/** status -> the webhook event a merchant receives. */
const EVENT_FOR_STATUS = Object.freeze({
  [STATUS.SUCCESS]: 'charge.success',
  [STATUS.FAILED]: 'charge.failed',
  // A customer who closes the tab is a failed charge as far as the merchant's
  // order state machine is concerned; `data.status` still says `cancelled`.
  [STATUS.CANCELLED]: 'charge.failed',
  [STATUS.REFUNDED]: 'refund.processed'
});

function newAccessCode() {
  return `ac_${crypto.randomBytes(20).toString('hex')}`;
}

function indexAccessCode(record) {
  if (record && record.access_code) {
    accessCodeIndex.set(record.access_code, storeKey(record.mode, record.reference));
  }
}

// Warm the index from whatever survived a restart.
for (const record of store.all()) indexAccessCode(record);

function now() {
  return new Date().toISOString();
}

/**
 * Validate a callback URL. Returns the normalised string, or null when absent
 * or unusable — a bad callback_url must never block a payment, the webhook is
 * the source of truth.
 */
function normalizeCallbackUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url).trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

/**
 * Storage key.
 *
 * A reference is unique WITHIN a merchant's mode, not globally: the same
 * `VE-BK-123456` may legitimately exist as a test rehearsal and as the real
 * live payment, and a test key must never be able to read, settle or collide
 * with live money. The reference itself is stored and returned untouched — this
 * prefix never leaves the store.
 */
function storeKey(mode, reference) {
  return `${mode || 'live'}::${reference}`;
}

/**
 * Look up a payment.
 *
 * @param {string} reference opaque merchant reference
 * @param {'test'|'live'} [mode] scope the lookup; omit to search both, which
 *   the checkout pages do because a browser has no key and therefore no mode.
 */
function get(reference, mode) {
  if (reference === null || reference === undefined) return null;
  const key = String(reference);
  if (mode) return store.get(storeKey(mode, key));
  // Live wins when a reference exists in both modes: real money first.
  return store.get(storeKey('live', key)) || store.get(storeKey('test', key)) || null;
}

/**
 * Create (or idempotently return) a payment record.
 *
 * Idempotency: calling initialize twice with the same reference does NOT create
 * a second payment and does NOT change the amount. It returns the existing
 * record with a FRESH access code, so a merchant retrying a dropped request
 * gets a usable checkout link instead of a duplicate charge. An attempt to
 * re-initialize the same reference with a DIFFERENT amount is rejected — that
 * is a bug on the merchant's side and silently honouring it would let a
 * customer's price change underneath them.
 *
 * @param {object} input
 * @param {object} input.merchant   merchant record
 * @param {'test'|'live'} input.mode
 * @param {number} input.amount     MINOR units (pesewas). Already validated.
 * @param {string} input.reference  opaque merchant reference
 * @returns {{ok:boolean, code?:string, error?:string, record?:object, reused?:boolean}}
 */
function initialize(input = {}) {
  const reference = input.reference === undefined || input.reference === null
    ? ''
    : String(input.reference).trim();

  if (!reference) return { ok: false, code: 'invalid_reference', error: 'reference is required' };
  if (reference.length > 200) {
    return { ok: false, code: 'invalid_reference', error: 'reference must be 200 characters or fewer' };
  }

  const amount = money.parseMinor(input.amount);
  if (amount === null) {
    return {
      ok: false,
      code: 'invalid_amount',
      error: 'amount must be a positive integer in minor units (pesewas)'
    };
  }

  const existing = get(reference, input.mode);
  if (existing) {
    if (existing.merchant_id !== input.merchant.id) {
      // Another merchant (or the other mode) already owns this reference.
      return { ok: false, code: 'reference_conflict', error: 'reference already exists' };
    }
    if (existing.amount !== amount) {
      return {
        ok: false,
        code: 'reference_conflict',
        error: `reference ${reference} was already initialized for a different amount`
      };
    }
    if (existing.status !== STATUS.PENDING) {
      return {
        ok: false,
        code: 'already_completed',
        error: `reference ${reference} is already ${existing.status}`
      };
    }
    // Re-issue a checkout session for the same payment.
    if (existing.access_code) accessCodeIndex.delete(existing.access_code);
    existing.access_code = newAccessCode();
    existing.access_code_expires_at = new Date(Date.now() + ACCESS_CODE_TTL_MS).toISOString();
    existing.access_code_used_at = null;
    existing.updated_at = now();
    store.set(storeKey(existing.mode, reference), existing);
    indexAccessCode(existing);
    return { ok: true, record: existing, reused: true };
  }

  const record = {
    reference,
    merchant_id: input.merchant.id,
    merchant: input.merchant.name,
    mode: input.mode,
    amount,
    currency: (input.currency || money.currency()).toUpperCase(),
    email: input.email ? String(input.email).trim() : null,
    phone: input.phone ? String(input.phone).trim() : null,
    callback_url: normalizeCallbackUrl(input.callback_url),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null,
    status: STATUS.PENDING,
    channel: null,
    paid_at: null,
    gateway_reference: null,
    // Set when a legacy query-string link claimed an amount that did not match
    // the initialized one. Surfaced in the dashboard; never trusted.
    amount_claim: null,
    source: input.source || 'initialize',
    access_code: newAccessCode(),
    access_code_expires_at: new Date(Date.now() + ACCESS_CODE_TTL_MS).toISOString(),
    access_code_used_at: null,
    created_at: now(),
    updated_at: now()
  };

  store.set(storeKey(record.mode, reference), record);
  indexAccessCode(record);
  console.log(
    `[PAYMENT] Initialized ${reference} | ${record.merchant} | ${record.currency} ${money.toMajor(record.amount).toFixed(2)} | mode=${record.mode}`
  );
  return { ok: true, record, reused: false };
}

/**
 * Exchange an access code for its payment.
 *
 * Single use in spirit: the first resolve stamps `access_code_used_at`, so the
 * dashboard can show a reused link, but a resolve is still allowed while the
 * payment is PENDING — a customer who refreshes the checkout page must not be
 * locked out of paying. What is NOT allowed is resolving a code for a payment
 * that already reached a terminal state, or an expired one.
 *
 * @returns {{ok:boolean, code?:string, error?:string, record?:object}}
 */
function resolveAccessCode(accessCode) {
  const code = String(accessCode || '').trim();
  if (!code) return { ok: false, code: 'invalid_access_code', error: 'access_code is required' };

  let key = accessCodeIndex.get(code);
  if (!key) {
    const found = store.find(r => r.access_code === code);
    if (found) {
      key = storeKey(found.mode, found.reference);
      indexAccessCode(found);
    }
  }

  const record = key ? store.get(key) : null;
  if (!record || record.access_code !== code) {
    return { ok: false, code: 'invalid_access_code', error: 'Unknown or expired access code' };
  }

  if (record.access_code_expires_at && Date.parse(record.access_code_expires_at) < Date.now()) {
    return { ok: false, code: 'expired_access_code', error: 'This checkout session has expired' };
  }

  if (isTerminal(record)) {
    return {
      ok: false,
      code: 'already_completed',
      error: `This payment is already ${record.status}`,
      record
    };
  }

  if (!record.access_code_used_at) {
    record.access_code_used_at = now();
    record.updated_at = now();
    store.set(storeKey(record.mode, record.reference), record);
  }

  return { ok: true, record };
}

/**
 * Resolve a LEGACY query-string checkout.
 *
 * `claimedAmount` comes from the URL, so it is attacker-controlled.
 *   - If the reference was initialized server-side, the stored amount WINS and
 *     any mismatch is recorded on the payment for the merchant to see.
 *   - If it was not (a merchant still on the old integration), we have nothing
 *     to reconcile against, so the claim is accepted but the payment is marked
 *     `source: 'legacy'` and `amount_trusted: false`, which the dashboard and
 *     the webhook payload's own record make visible.
 *
 * @returns {{ok:boolean, code?:string, error?:string, record?:object,
 *   trusted:boolean, mismatch:boolean}}
 */
function resolveLegacy(input = {}) {
  const reference = String(input.reference || '').trim();
  if (!reference) {
    return { ok: false, code: 'invalid_reference', error: 'ref is required', trusted: false, mismatch: false };
  }

  const claimed = money.parseMinor(input.amount);
  const mode = input.mode || 'live';
  const existing = get(reference, mode) || get(reference);

  if (existing) {
    if (isTerminal(existing)) {
      return {
        ok: false,
        code: 'already_completed',
        error: `This payment is already ${existing.status}`,
        record: existing,
        trusted: true,
        mismatch: false
      };
    }

    const mismatch = claimed !== null && claimed !== existing.amount;
    if (mismatch) {
      existing.amount_claim = {
        amount: claimed,
        source: 'query_string',
        seen_at: now(),
        rejected: true
      };
      existing.updated_at = now();
      store.set(storeKey(existing.mode, reference), existing);
      console.warn(
        `[PAYMENT] Amount mismatch on ${reference}: query string claimed ${claimed}, ` +
          `initialized amount is ${existing.amount}. Using the initialized amount.`
      );
    }

    return { ok: true, record: existing, trusted: true, mismatch };
  }

  // Never initialized: an old-style link. We cannot verify the amount.
  if (claimed === null) {
    return {
      ok: false,
      code: 'invalid_amount',
      error: 'amount must be a positive integer in minor units (pesewas)',
      trusted: false,
      mismatch: false
    };
  }

  const created = initialize({
    merchant: { id: input.merchantId || null, name: input.merchant || 'Valmont-Pay' },
    mode,
    amount: claimed,
    reference,
    email: input.email,
    phone: input.phone,
    callback_url: input.callback_url,
    currency: input.currency,
    source: 'legacy'
  });

  if (!created.ok) return { ...created, trusted: false, mismatch: false };

  created.record.amount_trusted = false;
  created.record.amount_claim = { amount: claimed, source: 'query_string', seen_at: now(), rejected: false };
  store.set(storeKey(created.record.mode, reference), created.record);

  console.warn(
    `[PAYMENT] Legacy checkout for ${reference} — amount ${claimed} came from the query string ` +
      'and could NOT be verified. Migrate this merchant to POST /api/transaction/initialize.'
  );

  return { ok: true, record: created.record, trusted: false, mismatch: false };
}

function isTerminal(record) {
  return Boolean(record && TERMINAL_STATUSES.has(record.status));
}

/**
 * Move a payment to a terminal state.
 *
 * Idempotent and one-way: the first terminal write wins. A second
 * `charge.success` for the same reference (a retried gateway callback, a
 * customer double-submitting, a webhook replay from Paystack) changes nothing
 * and reports `changed: false`, which is what stops the merchant receiving two
 * webhooks for one payment.
 *
 * The one legal second transition is success -> refunded, which is a genuinely
 * new terminal event (`refund.processed`).
 *
 * @returns {{ok:boolean, changed:boolean, record:object|null, event:string|null, error?:string}}
 */
function markTerminal(reference, input = {}) {
  const record = get(reference, input.mode);
  if (!record) return { ok: false, changed: false, record: null, event: null, error: 'Unknown reference' };

  const status = String(input.status || '').toLowerCase();
  if (!TERMINAL_STATUSES.has(status)) {
    return { ok: false, changed: false, record, event: null, error: `Invalid terminal status: ${status}` };
  }

  // A refund is only ever legal against a payment that actually succeeded.
  // Anything else (refunding a failure, a cancellation, or a second refund) is
  // a caller bug and must be reported, not quietly absorbed.
  if (status === STATUS.REFUNDED && record.status !== STATUS.SUCCESS) {
    return {
      ok: false,
      changed: false,
      record,
      event: null,
      error: `Only a successful payment can be refunded (${reference} is ${record.status})`
    };
  }

  // Any OTHER repeat transition is a duplicate delivery of an event we have
  // already handled, so it is absorbed silently and reports changed:false —
  // this is what guarantees one webhook per payment.
  if (isTerminal(record) && status !== STATUS.REFUNDED) {
    console.log(
      `[PAYMENT] ${reference} is already ${record.status}; ignoring duplicate ${status} transition.`
    );
    return { ok: true, changed: false, record, event: null };
  }

  record.status = status;
  record.channel = input.channel || record.channel || null;
  record.gateway_reference = input.gateway_reference || record.gateway_reference || null;
  record.paid_at =
    status === STATUS.SUCCESS
      ? input.paid_at || record.paid_at || now()
      : status === STATUS.REFUNDED
        ? record.paid_at
        : null;
  if (input.refunded_at || status === STATUS.REFUNDED) {
    record.refunded_at = input.refunded_at || now();
  }
  if (input.failure_reason) record.failure_reason = String(input.failure_reason);
  // The checkout session is over.
  if (record.access_code) accessCodeIndex.delete(record.access_code);
  record.access_code = null;
  record.updated_at = now();
  store.set(storeKey(record.mode, record.reference), record);

  const event = EVENT_FOR_STATUS[status];
  console.log(`[PAYMENT] ${reference} -> ${status} (${event})`);
  return { ok: true, changed: true, record, event };
}

/**
 * The canonical `data` object. GET /api/transaction/verify/{reference} and
 * every webhook body use THIS function, so a merchant that can parse one can
 * parse the other.
 *
 * `amount` is in minor units (pesewas), matching Paystack.
 */
function toPublicData(record) {
  if (!record) return null;
  return {
    reference: record.reference,
    status: record.status,
    amount: record.amount,
    currency: record.currency,
    channel: record.channel,
    paid_at: record.paid_at,
    merchant: record.merchant,
    gateway_reference: record.gateway_reference
  };
}

/** Everything the dashboard shows, including the untrusted-amount flags. */
function toDashboardJSON(record) {
  if (!record) return null;
  return {
    ...toPublicData(record),
    mode: record.mode,
    email: record.email,
    phone: record.phone,
    callback_url: record.callback_url,
    source: record.source,
    amount_trusted: record.amount_trusted !== false,
    amount_claim: record.amount_claim || null,
    failure_reason: record.failure_reason || null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function list(filter = {}) {
  return store
    .filter(record => {
      if (filter.merchantId && record.merchant_id !== filter.merchantId) return false;
      if (filter.mode && record.mode !== filter.mode) return false;
      if (filter.status && record.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
}

/** Test helper. */
function _reset() {
  store.clear();
  accessCodeIndex.clear();
}

module.exports = {
  STATUS,
  TERMINAL_STATUSES,
  EVENT_FOR_STATUS,
  ACCESS_CODE_TTL_MS,
  store,
  get,
  list,
  initialize,
  resolveAccessCode,
  resolveLegacy,
  markTerminal,
  isTerminal,
  toPublicData,
  toDashboardJSON,
  normalizeCallbackUrl,
  storeKey,
  _reset
};
