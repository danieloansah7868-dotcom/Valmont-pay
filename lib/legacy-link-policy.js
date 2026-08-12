/**
 * Legacy (unsigned) payment-link policy.
 *
 * ── The problem ─────────────────────────────────────────────────────────
 * The original public checkout URL carried the price in the query string:
 *
 *     pay.html?amount=1400&merchant=Valmont+Web+Services&reference=…
 *
 * Nothing in that URL is signed, so a customer could edit `1400` to `1`
 * and pay one cedi. The unit validator in pay.html only catches the
 * pesewas/cedis mix-up (`amount=140000`); a *tampered but plausible*
 * cedis amount sails straight through.
 *
 * ── The policy ──────────────────────────────────────────────────────────
 * The only public path is the access-code flow: the merchant calls
 * POST /api/transaction/initialize (or the dashboard mints a link) and the
 * amount lives on the server-side payment intent. pay.html?access_code=…
 * resolves it. Nothing the customer can type changes the price.
 *
 * Legacy `?amount=` links are therefore REJECTED, both:
 *   • in the browser (pay.html refuses to render a payment form), and
 *   • on the server (POST /api/initialize-payment refuses a request that
 *     came from a legacy pay.html URL).
 *
 * The single escape hatch is the server-side environment variable
 * ALLOW_LEGACY_AMOUNT_URL=1. It exists so an operator can temporarily
 * re-open the old flow while a storefront migrates. It must stay OFF in
 * production and is deliberately NOT settable from a request.
 */

/** Values that count as "on" for ALLOW_LEGACY_AMOUNT_URL. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Reason string recorded in /api/log/bad-amount for a rejected legacy URL. */
const LEGACY_UNSIGNED_REASON = 'legacy-unsigned';

/** Customer-facing copy. Keep in sync with pay.html. */
const LEGACY_UNSIGNED_MESSAGE =
  'This link is missing a locked payment code. Ask the merchant for a new link.';

/** Machine-readable error code returned by the API when a legacy call is refused. */
const LEGACY_UNSIGNED_CODE = 'LEGACY_URL_RETIRED';

/**
 * Is the legacy `pay.html?amount=…` flow re-opened on this deployment?
 * Off unless ALLOW_LEGACY_AMOUNT_URL is explicitly set to 1/true/yes/on.
 * @returns {boolean}
 */
function legacyAmountUrlAllowed() {
  const raw = String(process.env.ALLOW_LEGACY_AMOUNT_URL || '').trim().toLowerCase();
  return TRUTHY.has(raw);
}

/** Does this path look like the hosted payment page? */
function isPayPagePath(pathname) {
  const clean = String(pathname || '').toLowerCase();
  return clean === '/pay' || clean === '/pay.html' || clean.endsWith('/pay.html');
}

/**
 * True when the given Referer/URL is a legacy pay.html link — i.e. it puts
 * the price in the query string and has no access_code to fall back on.
 *
 * Used as a server-side backstop: even if someone strips the JavaScript out
 * of pay.html, a POST /api/initialize-payment that came from such a URL is
 * refused.
 *
 * @param {string} referer - the Referer header (or any URL string).
 * @returns {boolean}
 */
function refererIsLegacyAmountUrl(referer) {
  if (!referer) return false;
  let parsed;
  try {
    parsed = new URL(String(referer));
  } catch (_) {
    return false;
  }
  if (!isPayPagePath(parsed.pathname)) return false;
  if (parsed.searchParams.get('access_code')) return false;
  const amount = parsed.searchParams.get('amount');
  return amount !== null && String(amount).trim() !== '';
}

/** Standard JSON body for a refused legacy request. */
function legacyRejectionPayload() {
  return {
    success: false,
    status: false,
    code: LEGACY_UNSIGNED_CODE,
    error: LEGACY_UNSIGNED_MESSAGE,
    message: LEGACY_UNSIGNED_MESSAGE,
    docs: 'docs/tenant-integration.md#2-secure-flow-access_code--the-only-public-path'
  };
}

module.exports = {
  LEGACY_UNSIGNED_CODE,
  LEGACY_UNSIGNED_MESSAGE,
  LEGACY_UNSIGNED_REASON,
  isPayPagePath,
  legacyAmountUrlAllowed,
  legacyRejectionPayload,
  refererIsLegacyAmountUrl
};
