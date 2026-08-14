/**
 * Server-side admin sessions.
 *
 * ── Why this module exists ──────────────────────────────────────────────
 * The previous design compared the admin password *in browser JavaScript*
 * (admin-login.html) against a value served by `GET /config/admin.js`.
 * That endpoint published ADMIN_PASSWORD, unauthenticated, to anyone:
 *
 *     $ curl https://host/config/admin.js
 *     window.ADMIN_CONFIG = {"email":"…","password":"THE-REAL-PASSWORD"};
 *
 * Because ADMIN_PASSWORD is also the X-Admin-Key shared secret, that single
 * anonymous GET defeated every admin guard in the codebase. The guard and
 * the client-side login were mutually incompatible by construction: the
 * login could not work unless the secret reached the browser.
 *
 * The fix is architectural, not a patch. Credentials are now verified
 * ONLY on the server (POST /api/admin/login). The browser never receives
 * the password — it receives an opaque, expiring session token in an
 * httpOnly cookie it cannot read from JavaScript.
 *
 * ── Why sessions are STATELESS (the serverless login-loop fix) ──────────
 * Sessions used to live in a per-process `Map`. Vercel runs many serverless
 * instances behind the dashboard, and the instance that handled the
 * dashboard's first API call was usually NOT the one that handled
 * POST /api/admin/login — so it saw no session, returned 401, and the UI
 * bounced the operator straight back to the login page (a login loop) even
 * though the password was correct.
 *
 * Session tokens are now self-describing and signed, not stored:
 *
 *     v1.<issuedAt>.<expiresAt>.<nonce>.<hmac-sha256>
 *
 *   - issuedAt / expiresAt — absolute epoch-ms timestamps, so the token
 *     carries its own lifetime and any instance can enforce it.
 *   - nonce — 128 bits of CSPRNG entropy, so two tokens are never equal.
 *   - signature — HMAC-SHA256 (hex) over `issuedAt.expiresAt.nonce`,
 *     computed with a secret that every instance shares via environment
 *     configuration. Verification needs NO per-instance memory: any
 *     instance that knows the secret can validate a token minted by any
 *     other, so a correct password can never produce a login loop.
 *
 * The signing secret is ADMIN_SESSION_SECRET when set (recommended), else
 * derived deterministically from ADMIN_PASSWORD — which every instance
 * already shares, so the fix works with zero new configuration. Deriving
 * from ADMIN_PASSWORD adds no attack surface: anyone holding it can
 * already authenticate as admin via the X-Admin-Key header.
 *
 * ── Properties ──────────────────────────────────────────────────────────
 *   - Token: self-describing, signed, tamper-evident; never contains the
 *     password or the admin email.
 *   - Cookie: httpOnly (no JS access → XSS cannot steal the session),
 *     SameSite=Strict (cross-site requests never carry it → CSRF),
 *     Secure in production, Path=/.
 *   - Expiry: absolute, enforced by every instance on every lookup.
 *   - Constant-time comparison on the password check AND the signature.
 *   - Logout clears the browser cookie (the real protection) and records
 *     the token in a small in-memory revocation list so the same process
 *     rejects it immediately. Across instances revocation is best-effort —
 *     an already-stolen token stays valid until it expires, which is the
 *     standard tradeoff for stateless sessions (JWT-style).
 */

const crypto = require('crypto');

const COOKIE_NAME = 'vp_admin_session';
const TOKEN_VERSION = 'v1';
/** Absolute session lifetime. */
const SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
/** Allow a small clock-skew window when checking `issuedAt`. */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Tokens that were explicitly logged out (hashedToken -> expiry time of the
 * underlying token). In-memory only: across serverless instances this is a
 * best-effort backstop on top of the Max-Age=0 clear cookie.
 */
const revoked = new Map();

/** Per-process fallback used only when neither ADMIN_SESSION_SECRET nor
 *  ADMIN_PASSWORD exists (local dev with no admin configured at all). */
const processSecret = crypto.randomBytes(32).toString('hex');

function adminEmail() {
  return process.env.ADMIN_EMAIL || 'support@valmontpay.com';
}

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

/**
 * The HMAC key that signs session tokens. Identical on every serverless
 * instance because it comes from shared environment configuration, which is
 * what makes stateless verification work.
 */
function signingSecret() {
  if (process.env.ADMIN_SESSION_SECRET) return String(process.env.ADMIN_SESSION_SECRET);
  const base = process.env.ADMIN_PASSWORD;
  if (!base) return processSecret;
  // Deterministic derivation so all instances agree without any new config.
  return crypto.createHmac('sha256', 'valmont-pay admin session signing v1').update(String(base), 'utf8').digest('hex');
}

/** Constant-time string comparison that does not leak length via early exit. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // Hash both sides so differing lengths still compare in constant time.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Remove revocation entries whose underlying token has expired. */
function sweepRevoked(now = Date.now()) {
  for (const [key, expiresAt] of revoked) {
    if (expiresAt <= now) revoked.delete(key);
  }
}

/**
 * Verify operator credentials. Returns true only on an exact match of BOTH
 * fields. Always runs both comparisons so a wrong email and a wrong password
 * take the same time.
 */
function verifyCredentials(email, password) {
  const configured = adminPassword();
  if (!configured) return false;
  const emailOk = safeEqual(String(email || '').trim().toLowerCase(), adminEmail().toLowerCase());
  const passwordOk = safeEqual(String(password || ''), configured);
  return emailOk && passwordOk;
}

/**
 * Mint a stateless session token: `v1.<issuedAt>.<expiresAt>.<nonce>.<sig>`.
 * The signature covers `issuedAt.expiresAt.nonce`, so every field is bound
 * and any instance with the same signing secret can verify it.
 */
function issueStatelessToken(now = Date.now()) {
  const expiresAt = now + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${now}.${expiresAt}.${nonce}`;
  const signature = crypto.createHmac('sha256', signingSecret()).update(payload, 'utf8').digest('hex');
  return { token: `${TOKEN_VERSION}.${payload}.${signature}`, expiresAt: new Date(expiresAt).toISOString() };
}

/** Mint a new session. Returns the raw token (shown to the browser once). */
function createSession(email) {
  return issueStatelessToken();
}

/**
 * Verify a stateless token without consulting ANY shared state: parse the
 * self-describing fields, re-derive the HMAC signature over
 * `issuedAt.expiresAt.nonce`, compare in constant time, then enforce the
 * absolute lifetime.
 */
function verifyStatelessToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 5) return false;
  const [version, issuedAt, expiresAt, nonce, signature] = parts;
  if (version !== TOKEN_VERSION) return false;
  if (!/^\d+$/.test(issuedAt) || !/^\d+$/.test(expiresAt)) return false;
  if (!/^[0-9a-f]{1,128}$/.test(nonce)) return false;

  const payload = `${issuedAt}.${expiresAt}.${nonce}`;
  const expected = crypto.createHmac('sha256', signingSecret()).update(payload, 'utf8').digest('hex');
  if (!safeEqual(expected, signature)) return false;

  const issued = Number(issuedAt);
  const expires = Number(expiresAt);
  const now = Date.now();
  if (expires <= issued) return false;            // malformed lifetime
  if (issued > now + CLOCK_SKEW_MS) return false; // not valid yet
  if (expires <= now) return false;               // expired
  return true;
}

/** True when the raw token maps to a live session. */
function isValidSession(token) {
  if (!token) return false;
  sweepRevoked();
  if (revoked.has(hashToken(token))) return false;
  return verifyStatelessToken(token);
}

/**
 * Invalidate a token. With stateless tokens the server cannot un-mint what
 * it never stored, so this records the token in an in-memory revocation list
 * (immediate effect on this instance) and relies on the Max-Age=0 clear
 * cookie to remove it from the browser.
 */
function destroySession(token) {
  if (!token) return false;
  sweepRevoked();
  revoked.set(hashToken(token), Date.now() + SESSION_TTL_MS);
  return true;
}

/** Drop every session and revocation record (used by tests). */
function clearAllSessions() {
  revoked.clear();
}

/**
 * Parse a Cookie header without pulling in a dependency.
 * Returns {} for a missing/!malformed header rather than throwing.
 */
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch (_) {
      out[name] = value;
    }
  }
  return out;
}

/** Read the session token off a request (Express or serverless). */
function sessionTokenFromRequest(req) {
  if (!req) return '';
  if (req.cookies && req.cookies[COOKIE_NAME]) return String(req.cookies[COOKIE_NAME]);
  const header = (req.headers && (req.headers.cookie || req.headers.Cookie)) || '';
  const parsed = parseCookies(header);
  return parsed[COOKIE_NAME] || '';
}

/** True when the request carries a valid admin session cookie. */
function hasValidSession(req) {
  return isValidSession(sessionTokenFromRequest(req));
}

function isProduction() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.NODE_ENV === 'production');
}

/** Serialize the Set-Cookie value for a freshly minted session. */
function buildSessionCookie(token, { maxAgeMs = SESSION_TTL_MS } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  // Secure would make the cookie unusable over plain-HTTP localhost dev.
  if (isProduction()) attrs.push('Secure');
  return attrs.join('; ');
}

/** Serialize the Set-Cookie value that clears the session. */
function buildClearCookie() {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isProduction()) attrs.push('Secure');
  return attrs.join('; ');
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  adminEmail,
  verifyCredentials,
  issueStatelessToken,
  verifyStatelessToken,
  createSession,
  isValidSession,
  destroySession,
  clearAllSessions,
  parseCookies,
  sessionTokenFromRequest,
  hasValidSession,
  buildSessionCookie,
  buildClearCookie,
  isProduction
};
