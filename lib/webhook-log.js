/**
 * In-memory ring buffer of inbound webhook hits.
 *
 * Every request that reaches /api/webhook or /api/test-webhook is recorded here
 * so /api/webhook-status (and webhook-status.html) can answer the single most
 * important debugging question: "has ANYTHING ever POSTed to this endpoint?"
 *
 * IMPORTANT CAVEAT: this is process memory. On Vercel each serverless instance
 * has its own copy and it is wiped on a cold start, so an EMPTY log does NOT
 * prove Paystack never called — it only proves this particular instance has not
 * seen a call. A NON-empty log is definitive proof that delivery works.
 *
 * Nothing sensitive is stored: the signature header is truncated and bodies are
 * capped, so this buffer can safely be exposed to the diagnostic page.
 */

const MAX_ENTRIES = 25;
const MAX_BODY_CHARS = 4000;

/** @type {Array<object>} newest last */
const entries = [];

/** Headers that must never be echoed back in full. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-vercel-id',
  'x-vercel-signature'
]);

/**
 * Redact or truncate a header value so the diagnostic page never leaks a token.
 */
function safeHeaderValue(name, value) {
  const raw = Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
  const key = String(name).toLowerCase();

  if (SENSITIVE_HEADERS.has(key)) return '[redacted]';

  // The Paystack signature is not a secret, but it is 128 hex chars of noise.
  // Show enough to eyeball it without flooding the UI.
  if (key === 'x-paystack-signature') {
    return raw.length > 24 ? `${raw.slice(0, 12)}…${raw.slice(-8)} (${raw.length} chars)` : raw;
  }

  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

/** Copy a request's headers into a plain, redacted, lower-cased object. */
function sanitizeHeaders(headers = {}) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    output[String(name).toLowerCase()] = safeHeaderValue(name, value);
  }
  return output;
}

/**
 * Record one inbound webhook hit.
 *
 * @param {object} hit
 * @param {string} hit.endpoint      e.g. '/api/webhook'
 * @param {string} hit.method        HTTP method
 * @param {object} [hit.headers]     raw request headers (sanitized here)
 * @param {string} [hit.body]        raw request body text (truncated here)
 * @param {string} [hit.outcome]     short machine-ish outcome label
 * @param {number} [hit.statusCode]  response status we returned
 * @param {object} [hit.detail]      any extra JSON-serializable context
 * @returns {object} the stored entry
 */
function recordWebhookHit(hit = {}) {
  const bodyText = typeof hit.body === 'string' ? hit.body : '';

  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    endpoint: hit.endpoint || 'unknown',
    method: hit.method || 'unknown',
    headers: sanitizeHeaders(hit.headers),
    bodyBytes: Buffer.byteLength(bodyText, 'utf8'),
    bodyPreview:
      bodyText.length > MAX_BODY_CHARS ? `${bodyText.slice(0, MAX_BODY_CHARS)}…[truncated]` : bodyText,
    event: hit.event || null,
    reference: hit.reference || null,
    outcome: hit.outcome || null,
    statusCode: typeof hit.statusCode === 'number' ? hit.statusCode : null,
    detail: hit.detail || null
  };

  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();

  return entry;
}

/**
 * Update the entry returned by recordWebhookHit once the outcome is known.
 * Safe to call with a stale/unknown entry — it simply does nothing.
 */
function completeWebhookHit(entry, patch = {}) {
  if (!entry || typeof entry !== 'object') return null;
  Object.assign(entry, patch);
  return entry;
}

/** Newest-first list of the most recent hits (default 10). */
function getRecentWebhookHits(limit = 10) {
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return entries.slice(-size).reverse();
}

/** How many hits this instance has seen since it started. */
function getWebhookHitCount() {
  return entries.length;
}

/** Test helper. */
function resetWebhookLog() {
  entries.length = 0;
}

module.exports = {
  MAX_ENTRIES,
  recordWebhookHit,
  completeWebhookHit,
  getRecentWebhookHits,
  getWebhookHitCount,
  resetWebhookLog,
  sanitizeHeaders
};
