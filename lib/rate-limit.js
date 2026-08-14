/**
 * Dependency-free, in-memory rate limiting.
 *
 * The gateway previously had NO limiter of any kind. That left uncapped:
 *   - admin login  → offline-speed brute force against ADMIN_PASSWORD,
 *   - payment-link generation → link spam, and one Supabase write each,
 *   - mandate endpoints → authorization_code enumeration,
 *   - the public order write → unbounded junk rows in the ledger.
 *
 * Implemented as a fixed-window counter keyed on client IP + bucket name.
 * Deliberately no new npm dependency: this runs on Vercel serverless where
 * every dependency is cold-start cost, and the module graph is guarded by
 * scripts/verify-module-graph.mjs.
 *
 * ── Honest limitation ───────────────────────────────────────────────────
 * State is per-process. On serverless, N warm instances mean the effective
 * limit is N × max. This still defeats the attack that matters (single-
 * source high-rate brute force / spam) and degrades safely, but it is NOT
 * a distributed quota. Move to Supabase or Upstash counters if you need a
 * hard global cap.
 */

/** bucketName -> Map<clientKey, { count, resetAt }> */
const buckets = new Map();

/** Identify the caller. Trusts x-forwarded-for's FIRST hop (set by Vercel). */
function clientKey(req) {
  const headers = (req && req.headers) || {};
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (
    headers['x-real-ip'] ||
    (req && req.ip) ||
    (req && req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

function bucketFor(name) {
  let bucket = buckets.get(name);
  if (!bucket) {
    bucket = new Map();
    buckets.set(name, bucket);
  }
  return bucket;
}

/** Drop expired entries so the map cannot grow without bound. */
function sweep(bucket, now) {
  for (const [key, entry] of bucket) {
    if (entry.resetAt <= now) bucket.delete(key);
  }
}

/**
 * Record a hit and report whether it is allowed.
 * @returns {{allowed:boolean, remaining:number, retryAfterSeconds:number}}
 */
function hit(name, key, { max, windowMs }) {
  const now = Date.now();
  const bucket = bucketFor(name);

  // Sweep opportunistically; cheap relative to the request itself.
  if (bucket.size > 512) sweep(bucket, now);

  const entry = bucket.get(key);
  if (!entry || entry.resetAt <= now) {
    bucket.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  entry.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  if (entry.count > max) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }
  return { allowed: true, remaining: Math.max(0, max - entry.count), retryAfterSeconds };
}

/**
 * Express middleware factory.
 *
 * @param {string} name      Bucket name (keeps limits independent per route).
 * @param {object} opts
 * @param {number} opts.max        Requests allowed per window.
 * @param {number} opts.windowMs   Window length in milliseconds.
 * @param {string} [opts.message]  Client-facing message.
 * @param {function} [opts.keyOn]  Custom key extractor (default: client IP).
 */
function limit(name, { max, windowMs, message, keyOn } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const key = keyOn ? String(keyOn(req) || clientKey(req)) : clientKey(req);
    const result = hit(name, key, { max, windowMs });

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (result.allowed) return next();

    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    console.warn(`[RATE-LIMIT] ${name}: blocked ${key} (over ${max}/${Math.round(windowMs / 1000)}s)`);
    return res.status(429).json({
      status: false,
      success: false,
      message: message || 'Too many requests. Please slow down and try again shortly.',
      retry_after_seconds: result.retryAfterSeconds
    });
  };
}

/** Test/ops helper: wipe all counters. */
function resetAll() {
  buckets.clear();
}

module.exports = { limit, hit, clientKey, resetAll };
