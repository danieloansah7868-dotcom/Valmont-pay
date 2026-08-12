/**
 * Best-effort in-memory rate limiter.
 *
 * On Vercel each isolate has its own counters, so this is a brake — not a
 * global quota. Enough to stop casual brute-force of /api/admin/login and
 * payment-init spam from a single warm instance.
 */

const buckets = new Map();
const MAX_KEYS = 10_000;

function prune(now) {
  if (buckets.size < MAX_KEYS) return;
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
    if (buckets.size < MAX_KEYS * 0.8) break;
  }
  if (buckets.size >= MAX_KEYS) {
    const first = buckets.keys().next().value;
    if (first) buckets.delete(first);
  }
}

function clientKey(req, prefix) {
  const headers = (req && req.headers) || {};
  const forwarded = headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '';
  const ip = String(forwarded).split(',')[0].trim()
    || headers['x-real-ip']
    || (req.socket && req.socket.remoteAddress)
    || 'unknown';
  return `${prefix}:${ip}`;
}

function hit(key, { windowMs, max }) {
  const now = Date.now();
  prune(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1, retryAfterMs: windowMs };
  }
  existing.count += 1;
  if (existing.count > max) {
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }
  return { ok: true, remaining: max - existing.count, retryAfterMs: existing.resetAt - now };
}

function rateLimit({ windowMs = 60_000, max = 30, name = 'rl' } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const verdict = hit(clientKey(req, name), { windowMs, max });
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, verdict.remaining)));
    if (verdict.ok) return next();
    res.setHeader('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
    return res.status(429).json({
      status: false,
      success: false,
      message: 'Too many requests. Please try again shortly.'
    });
  };
}

/** Test helper. */
function resetRateLimits() {
  buckets.clear();
}

module.exports = {
  rateLimit,
  hit,
  clientKey,
  resetRateLimits
};
