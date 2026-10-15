/**
 * Turn a Paystack decline into ONE line the merchant can act on.
 *
 * WHY THIS EXISTS
 *
 * When a card fails, Paystack tells us exactly why — `gateway_response` ("Denied
 * by Fraud System", "Declined", "Insufficient Funds", "Unrecognized card type",
 * "Pickup card", ...). We used to throw that sentence away: the webhook mapped
 * the event to status FAILED and dropped everything else, so the dashboard showed
 * a red FAILED badge with no explanation and every investigation started from
 * zero ("the customer says it said unable to process").
 *
 * The wording must be preserved VERBATIM — it is the exact string Paystack's own
 * dashboard shows, so a merchant can match our row against theirs one-for-one.
 * This module therefore only trims/limits, never rewrites or translates.
 *
 * CommonJS on purpose: server.js `require()`s it, and the ESM serverless
 * functions under /api default-import it (same convention as lib/ledger.js).
 *
 * Paystack error reference: https://paystack.com/docs/api/errors/transaction/
 */

/** Hard cap so a pathological gateway string can never bloat a row. */
const MAX_FAILURE_REASON_LENGTH = 300;

/** First value that has actual text in it, trimmed. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

/**
 * Clean a raw reason into something safe to store and render.
 *
 * Collapses newlines/tabs (HTML and CSV exports both hate them) and truncates at
 * MAX_FAILURE_REASON_LENGTH. Returns '' for anything empty — callers treat that
 * as "no reason recorded", never as a reason that reads "undefined".
 */
function normalizeFailureReason(value) {
  const text = firstNonEmpty(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > MAX_FAILURE_REASON_LENGTH
    ? `${text.slice(0, MAX_FAILURE_REASON_LENGTH - 1)}…`
    : text;
}

/**
 * Pull the decline reason out of a Paystack transaction/event `data` object.
 *
 * `gateway_response` is the authoritative field (it is what Paystack's dashboard
 * displays). `message` is the fallback for the few paths that only carry one —
 * including our own webhook-replay payloads. Anything else is ignored rather
 * than guessed at, so a missing reason stays missing.
 *
 * @param {object} data - Paystack `data` object, or any loose transaction shape
 * @returns {string} normalized reason, or '' when the gateway did not give one
 */
function extractFailureReason(data) {
  const source = data || {};
  return normalizeFailureReason(
    firstNonEmpty(
      source.failure_reason,
      source.failureReason,
      source.gateway_response,
      source.gatewayResponse,
      source.message
    )
  );
}

module.exports = {
  MAX_FAILURE_REASON_LENGTH,
  extractFailureReason,
  normalizeFailureReason
};
