/**
 * Shared admin authorization for sensitive, non-Paystack endpoints.
 *
 * The admin HTML pages (admin.html / tenants.html / dashboard.html) sit
 * behind a client-side login. Until now the API endpoints those pages
 * call were COMPLETELY OPEN — anyone on the internet could:
 *
 *   - rotate tenant API keys and receive the fresh secrets in the
 *     response (POST /api/tenants/:key/rotate-keys),
 *   - create / edit / delete tenants (POST|PUT|DELETE /api/admin/tenants…),
 *   - insert arbitrary SUCCESS transactions into the ledger
 *     (POST /api/manual-transaction, POST /api/webhook-debug),
 *   - change the tenant's settlement-side webhook URL
 *     (PUT /api/tenants/:key/webhook).
 *
 * This module enforces a shared-secret check: the X-Admin-Key header must
 * match ADMIN_PASSWORD. When ADMIN_PASSWORD is NOT configured (local
 * development), checks pass with a warned-open posture so the dev
 * experience stays frictionless — production must always set it.
 */

const crypto = require('crypto');

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

/** Is the deployment enforcing admin auth? (False only in local dev.) */
function adminAuthEnforced() {
  return Boolean(adminPassword());
}

/** Constant-time comparison that tolerates different lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function presentedKey(req) {
  const headers = (req && req.headers) || {};
  const header = headers['x-admin-key'] || headers['X-Admin-Key'];
  if (header) return String(header);
  // Query-string fallback for serverless handlers reading req.query.
  const query = (req && req.query) || {};
  return query.admin_key ? String(query.admin_key) : '';
}

/**
 * True when the request is authorized to perform an admin operation.
 * Open when ADMIN_PASSWORD is unset (local dev posture).
 */
function isAuthorizedAdmin(req) {
  const password = adminPassword();
  if (!password) return true;
  const presented = presentedKey(req);
  if (!presented) return false;
  return safeEqual(presented, password);
}

/** Standard 401 payload used by both Express and the serverless functions. */
function unauthorizedPayload() {
  return {
    status: false,
    success: false,
    message: 'Admin authorization required. Send the X-Admin-Key header.'
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
