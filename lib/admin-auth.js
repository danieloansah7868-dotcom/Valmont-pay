/**
 * Shared admin authorization for sensitive, non-Paystack endpoints.
 *
 * Accepted credentials (any one is enough):
 *   1. X-Admin-Key header matching ADMIN_PASSWORD (API / curl).
 *   2. vp_admin httpOnly session cookie issued by POST /api/admin/login.
 *
 * The query-string `admin_key` fallback is GONE — it leaked into logs,
 * Referers and browser history.
 *
 * When ADMIN_PASSWORD is NOT configured (local development), checks pass
 * with a warned-open posture so the test suite and `npm start` stay
 * frictionless. Production must always set it.
 */

const { safeEqual, readSession } = require('./admin-session');

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

/** Is the deployment enforcing admin auth? (False only in local dev.) */
function adminAuthEnforced() {
  return Boolean(adminPassword());
}

function presentedKey(req) {
  const headers = (req && req.headers) || {};
  const header = headers['x-admin-key'] || headers['X-Admin-Key'];
  if (header) return String(header);
  return '';
}

/**
 * True when the request is authorized to perform an admin operation.
 * Open when ADMIN_PASSWORD is unset (local dev posture).
 */
function isAuthorizedAdmin(req) {
  const password = adminPassword();
  if (!password) return true;

  const presented = presentedKey(req);
  if (presented && safeEqual(presented, password)) return true;

  const session = readSession(req);
  if (session && session.e) return true;

  return false;
}

/** Standard 401 payload used by both Express and the serverless functions. */
function unauthorizedPayload() {
  return {
    status: false,
    success: false,
    message: 'Admin authorization required. Send the X-Admin-Key header or sign in.'
  };
}

/** Express middleware. */
function requireAdmin(req, res, next) {
  if (isAuthorizedAdmin(req)) return next();
  return res.status(401).json(unauthorizedPayload());
}

module.exports = {
  adminAuthEnforced,
  isAuthorizedAdmin,
  requireAdmin,
  unauthorizedPayload
};
