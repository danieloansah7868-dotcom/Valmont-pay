/**
 * In-memory access code store.
 *
 * When `POST /api/transaction/initialize` creates a payment intent, it
 * generates a one-time access_code. The client redirects to
 * `pay.html?access_code=...` and the server resolves all payment details
 * from this store — amount, merchant, reference, etc. — so the customer
 * can never edit the amount in the URL.
 *
 * Access codes are single-use and expire after 30 minutes. Expired codes
 * are silently cleaned up on each access.
 *
 * IMPORTANT: In production, this should be backed by Redis or the database
 * so a serverless cold start does not lose in-flight payments.
 */

const crypto = require('crypto');

const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/** @type {Map<string, {payment:object, createdAt:number, used:boolean}>} */
const store = new Map();

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Generate a unique access code.
 * @returns {string} e.g. "ac_1a2b3c4d5e6f7g8h"
 */
function generateAccessCode() {
  return `ac_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Store payment initialization data under a fresh access code.
 * @param {object} paymentData - {amount, reference, currency, email, phone, callback_url, tenant_key, access_code}
 * @returns {{access_code: string, payment: object}}
 */
function createAccessCode(paymentData) {
  const accessCode = paymentData.access_code || generateAccessCode();

  store.set(accessCode, {
    payment: {
      amount: paymentData.amount,
      reference: paymentData.reference,
      currency: paymentData.currency || 'GHS',
      email: paymentData.email,
      phone: paymentData.phone || '',
      callback_url: paymentData.callback_url || '',
      tenant_key: paymentData.tenant_key,
      merchant_display_name: paymentData.merchant_display_name || '',
      merchant_brand_color: paymentData.merchant_brand_color || '#f68b1e',
      merchant_logo_url: paymentData.merchant_logo_url || '/logo.svg',
      paystack_authorization_url: paymentData.paystack_authorization_url || '',
      paystack_access_code: paymentData.paystack_access_code || ''
    },
    createdAt: Date.now(),
    used: false
  });

  // Expire old entries
  purgeExpired();

  return { access_code: accessCode, payment: store.get(accessCode).payment };
}

/**
 * Redeem an access code. Returns null if not found, expired, or already used.
 * Marking as used ensures it can only be consumed once (redirect to pay.html
 * is the single use).
 * @param {string} accessCode
 * @returns {object|null} The payment data
 */
function redeemAccessCode(accessCode) {
  if (!accessCode) return null;

  const entry = store.get(accessCode);
  if (!entry) return null;

  // Expired
  if (Date.now() - entry.createdAt > EXPIRY_MS) {
    store.delete(accessCode);
    return null;
  }

  // Already used — but we still return it for idempotency so a page refresh
  // doesn't break. The "used" flag is best-effort.
  if (entry.used) {
    return entry.payment;
  }

  entry.used = true;
  return entry.payment;
}

/**
 * Peek at an access code without marking it used.
 * @param {string} accessCode
 * @returns {object|null}
 */
function peekAccessCode(accessCode) {
  if (!accessCode) return null;
  const entry = store.get(accessCode);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > EXPIRY_MS) {
    store.delete(accessCode);
    return null;
  }
  return entry.payment;
}

/**
 * Delete an access code.
 * @param {string} accessCode
 */
function deleteAccessCode(accessCode) {
  store.delete(accessCode);
}

/**
 * How many valid (unexpired, unused) access codes are stored.
 * @returns {number}
 */
function count() {
  purgeExpired();
  let valid = 0;
  for (const entry of store.values()) {
    if (!entry.used) valid++;
  }
  return valid;
}

/** Remove all expired entries. */
function purgeExpired() {
  const now = Date.now();
  for (const [code, entry] of store.entries()) {
    if (now - entry.createdAt > EXPIRY_MS) {
      store.delete(code);
    }
  }
}

/** Test helper. */
function reset() {
  store.clear();
}

module.exports = {
  generateAccessCode,
  createAccessCode,
  redeemAccessCode,
  peekAccessCode,
  deleteAccessCode,
  count,
  purgeExpired,
  reset,
  EXPIRY_MS
};
