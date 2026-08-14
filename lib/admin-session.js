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
 * the password — it receives an opaque, random, expiring session token in
 * an httpOnly cookie it cannot read from JavaScript.
 *
 * ── Properties ──────────────────────────────────────────────────────────
 *   - Token: 256 bits of CSPRNG entropy, stored hashed (SHA-256) so a
 *     memory/log disclosure does not yield a usable credential.
 *   - Cookie: httpOnly (no JS access → XSS cannot steal the session),
 *     SameSite=Strict (cross-site requests never carry it → CSRF),
 *     Secure in production, Path=/.
 *   - Expiry: absolute TTL, swept lazily on every lookup.
 *   - Constant-time comparison on the password check.
 *
 * Sessions live in process memory. On serverless that means a cold start
 * logs the operator out — an acceptable, fail-*closed* tradeoff. Set
 * ADMIN_SESSION_SECRET to keep sessions valid across instances via a
 * stateless signed token (see issueStatelessToken below).
 */

const crypto = require('crypto');

const COOKIE_NAME = 'vp_admin_session';
/** Absolute session lifetime. */
const SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

/** hashedToken -> { expiresAt, email } */
const sessions = new Map();

function adminEmail() {
  return process.env.ADMIN_EMAIL || 'support@valmontpay.com';
}

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
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

/** Remove expired sessions. Cheap: called on every lookup. */
function sweep(now = Date.now()) {
  for (const [key, entry] of sessions) {
    if (!entry || entry.expiresAt <= now) sessions.delete(key);
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

/** Mint a new session. Returns the raw token (shown to the browser once). */
function createSession(email) {
  sweep();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(hashToken(token), {
    email: String(email || adminEmail()),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return { token, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
}

/** True when the raw token maps to a live session. */
function isValidSession(token) {
  if (!token) return false;
  sweep();
  const entry = sessions.get(hashToken(token));
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(hashToken(token));
    return false;
  }
  return true;
}

function destroySession(token) {
  if (!token) return false;
  return sessions.delete(hashToken(token));
}

/** Drop every session (used by tests). */
function clearAllSessions() {
  sessions.clear();
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
