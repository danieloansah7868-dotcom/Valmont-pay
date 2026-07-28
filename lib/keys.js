/**
 * Valmont-Pay API keypairs.
 *
 * Every merchant gets FOUR keys — a test pair and a live pair:
 *
 *   pk_test_xxxxxxxx…  public, browser-safe. Identifies the merchant on a
 *                      checkout page. Cannot move money, cannot read data.
 *   sk_test_xxxxxxxx…  SECRET, server-only. Authorises
 *                      POST /api/transaction/initialize and
 *                      GET  /api/transaction/verify/{reference}, and is the
 *                      HMAC-SHA512 key used to sign webhook deliveries.
 *   pk_live_… / sk_live_…  the same pair against real money.
 *
 * A secret key must never appear in HTML, JavaScript bundles, query strings or
 * logs. `redact()` below is the only way this codebase is allowed to print one.
 */

const crypto = require('crypto');

const MODES = Object.freeze(['test', 'live']);
const KEY_BYTES = 24; // 48 hex chars — 192 bits of entropy.

/** `pk_test_` / `sk_live_` … */
function prefix(type, mode) {
  return `${type === 'secret' ? 'sk' : 'pk'}_${mode}_`;
}

function randomKey(type, mode) {
  return prefix(type, mode) + crypto.randomBytes(KEY_BYTES).toString('hex');
}

/**
 * Generate one keypair for a mode.
 * @param {'test'|'live'} mode
 */
function generateKeypair(mode) {
  if (!MODES.includes(mode)) throw new Error(`Unknown key mode: ${mode}`);
  return {
    mode,
    public_key: randomKey('public', mode),
    secret_key: randomKey('secret', mode)
  };
}

/** Generate both pairs at once — what merchant onboarding hands out. */
function generateKeySet() {
  return { test: generateKeypair('test'), live: generateKeypair('live') };
}

/** Which mode does this key belong to? Returns null for anything unparsable. */
function modeOf(key) {
  const value = String(key || '');
  for (const mode of MODES) {
    if (value.startsWith(`sk_${mode}_`) || value.startsWith(`pk_${mode}_`)) return mode;
  }
  return null;
}

function isSecretKey(key) {
  return /^sk_(test|live)_[0-9a-f]{16,}$/.test(String(key || ''));
}

function isPublicKey(key) {
  return /^pk_(test|live)_[0-9a-f]{16,}$/.test(String(key || ''));
}

/**
 * Constant-time key comparison. A plain `===` on a secret leaks its prefix
 * length through timing; this does not.
 */
function keysMatch(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** `sk_live_9f2c…8a1b` — safe to log. Never log the raw key. */
function redact(key) {
  const value = String(key || '');
  if (!value) return '(none)';
  const head = value.slice(0, Math.min(11, value.length));
  const tail = value.length > 15 ? value.slice(-4) : '';
  return tail ? `${head}\u2026${tail}` : `${head}\u2026`;
}

/**
 * Pull a bearer token out of an incoming request.
 * Accepts `Authorization: Bearer sk_…` (the documented form) and, as a
 * convenience for server-to-server callers, `x-valmontpay-secret-key`.
 * A key is NEVER read from the query string — query strings end up in access
 * logs, browser history and Referer headers.
 */
function extractSecretKey(req) {
  const headers = (req && req.headers) || {};
  const auth = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
  if (match) return match[1].trim();
  const header = headers['x-valmontpay-secret-key'];
  if (header) return String(header).trim();
  return null;
}

module.exports = {
  MODES,
  generateKeypair,
  generateKeySet,
  modeOf,
  isSecretKey,
  isPublicKey,
  keysMatch,
  redact,
  extractSecretKey
};
