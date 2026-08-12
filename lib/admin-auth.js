/**
 * Shared admin authorization for sensitive, non-Paystack endpoints.
 *
 * Accepted credentials (any one is enough):
 *   1. X-Admin-Key header matching ADMIN_API_KEY (API / curl).
 *      The login password is NEVER a valid API key.
 *   2. vp_admin httpOnly session cookie issued by POST /api/admin/login.
 *
 * Production (VERCEL_ENV=production / NODE_ENV=production /
 * VALMONT_STRICT_SECRETS=1) is FAIL-CLOSED: if ADMIN_PASSWORD is unset,
 * every admin check returns false. Local `npm start` / `npm test` stay
 * open so the suite does not need a password.
 */

const { safeEqual, readSession } = require('./admin-session');
const { isProductionRuntime } = require('./insecure-secrets');

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

function adminApiKey() {
  return process.env.ADMIN_API_KEY || '';
}

/** True when admin checks are actually enforced (not the local-dev open door). */
function adminAuthEnforced() {
  return Boolean(adminPassword()) || isProductionRuntime();
}

function presentedKey(req) {
  const headers = (req && req.headers) || {};
  const header = headers['x-admin-key'] || headers['X-Admin-Key'];
  if (header) return String(header);
  return '';
}

function isAuthorizedAdmin(req) {
  const password = adminPassword();
  if (!password) {
    // Production with no password is locked, not open.
    return !isProductionRuntime();
  }

  const presented = presentedKey(req);
  const apiKey = adminApiKey();
  if (presented && apiKey && safeEqual(presented, apiKey)) return true;

  const session = readSession(req);
  if (session && session.e) return true;

  return false;
}

function unauthorizedPayload() {
  return {
    status: false,
    success: false,
    message: 'Admin authorization required. Sign in or send X-Admin-Key (ADMIN_API_KEY).'
  };
}

function misconfiguredPayload() {
  return {
    status: false,
    success: false,
    message: 'Admin is not configured. Set ADMIN_PASSWORD before serving production traffic.'
  };
}

function requireAdmin(req, res, next) {
  if (isAuthorizedAdmin(req)) return next();
  if (isProductionRuntime() && !adminPassword()) {
    return res.status(503).json(misconfiguredPayload());
  }
  return res.status(401).json(unauthorizedPayload());
}

/** HTML pages: redirect to login (or 503 if production is unconfigured). */
function requireAdminPage(req, res, next) {
  if (isAuthorizedAdmin(req)) return next();
  if (isProductionRuntime() && !adminPassword()) {
    res.status(503).type('html').send('Admin is not configured. Set ADMIN_PASSWORD.');
    return;
  }
  return res.redirect(302, '/admin-login.html');
}

module.exports = {
  adminAuthEnforced,
  isAuthorizedAdmin,
  requireAdmin,
  requireAdminPage,
  unauthorizedPayload,
  misconfiguredPayload,
  adminApiKey,
  adminPassword
};
