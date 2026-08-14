/**
 * Shared admin authorization for sensitive, non-Paystack endpoints.
 *
 * Guards: /api/admin/*, tenant key rotation, tenant webhook URL updates,
 * POST /api/manual-transaction, POST /api/webhook-debug, terminal-status
 * order writes, the mandate (recurring billing) API, and the ledger read.
 *
 * ── Two accepted credentials ────────────────────────────────────────────
 *  1. An admin SESSION COOKIE (preferred). Minted by POST /api/admin/login
 *     after a server-side credential check — see lib/admin-session.js. The
 *     browser never holds the password, only an opaque httpOnly token.
 *  2. The X-Admin-Key HEADER equal to ADMIN_PASSWORD. Retained for
 *     server-to-server/CLI callers (curl, scripts, monitoring). This is a
 *     machine credential: it is never sent to a browser any more. The route
 *     that used to publish it (`GET /config/admin.js`) has been REMOVED.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────
 * When ADMIN_PASSWORD is unset the guard previously returned "authorized"
 * so local dev stayed frictionless — meaning one missing env var in Vercel
 * silently opened every admin endpoint to the internet, with nothing but a
 * log line. Now an unset password is fatal in a deployed environment: all
 * guarded endpoints return 503 and refuse to act. The open posture survives
 * ONLY for genuinely local processes (no VERCEL / NODE_ENV=production).
 */

const crypto = require('crypto');
const adminSession = require('./admin-session');

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

/** True in any deployed environment (Vercel, or an explicit production build). */
function isDeployed() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.NODE_ENV === 'production');
}

/** Is the deployment enforcing admin auth? */
function adminAuthEnforced() {
  return Boolean(adminPassword());
}

/**
 * A deployed environment with no ADMIN_PASSWORD is MISCONFIGURED, not "open".
 * Guarded routes must refuse to serve rather than expose admin capability.
 */
function isMisconfigured() {
  return isDeployed() && !adminPassword();
}

/** Constant-time comparison; hashes first so lengths cannot differ. */
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function presentedKey(req) {
  const headers = (req && req.headers) || {};
  const header = headers['x-admin-key'] || headers['X-Admin-Key'];
  if (header) return String(header);
  // NOTE: the admin key is deliberately NOT accepted from the query string.
  // Query strings land in access logs, browser history, and Referer headers,
  // which is exactly how a long-lived shared secret leaks.
  return '';
}

/**
 * True when the request is authorized to perform an admin operation.
 *
 * Order: session cookie first (the browser path), then the machine key.
 * Returns false — never true — when the deployment is misconfigured.
 */
function isAuthorizedAdmin(req) {
  if (isMisconfigured()) return false;

  if (adminSession.hasValidSession(req)) return true;

  const password = adminPassword();
  if (!password) {
    // Local development only: no password configured, not a deployed env.
    return true;
  }

  const presented = presentedKey(req);
  if (!presented) return false;
  return safeEqual(presented, password);
}

/** Standard 401 payload used by both Express and the serverless functions. */
function unauthorizedPayload() {
  return {
    status: false,
    success: false,
    message: 'Admin authorization required. Log in at /admin-login.html, or send the X-Admin-Key header.'
  };
}

/** 503 payload for a deployment that forgot ADMIN_PASSWORD. */
function misconfiguredPayload() {
  return {
    status: false,
    success: false,
    message:
      'Server misconfiguration: ADMIN_PASSWORD is not set, so admin endpoints are disabled. ' +
      'Set ADMIN_PASSWORD in the deployment environment and redeploy.'
  };
}

/** Express middleware. */
function requireAdmin(req, res, next) {
  if (isMisconfigured()) {
    console.error('[ADMIN-AUTH] Refusing admin request: ADMIN_PASSWORD is not set in a deployed environment.');
    return res.status(503).json(misconfiguredPayload());
  }
  if (isAuthorizedAdmin(req)) return next();
  return res.status(401).json(unauthorizedPayload());
}

module.exports = {
  adminAuthEnforced,
  isAuthorizedAdmin,
  isMisconfigured,
  requireAdmin,
  unauthorizedPayload,
  misconfiguredPayload
};
