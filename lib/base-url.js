/**
 * Single source of truth for "what public origin should customer-facing
 * URLs (payment links, Paystack callbacks, webhook recommendations) use?"
 *
 * ── Why request-host-first? ─────────────────────────────────────────────
 * Production once had PUBLIC_BASE_URL pointing at a dead .vercel.app
 * hostname while the custom domain (valmontpay.app) served all traffic.
 * Every payment link the dashboard generated 404'd, and the Paystack
 * dashboard was pointed at a webhook URL that could never be reached.
 *
 * The host the caller actually used to reach us is the strongest possible
 * signal of a working public URL, so it wins. PUBLIC_BASE_URL is only a
 * fallback for non-HTTP contexts (CLI scripts, tests, webhook replays).
 *
 * ── Host-header injection guard ─────────────────────────────────────────
 * A client can send an arbitrary `Host:` header. If we blindly trusted it,
 * an attacker could make the gateway mint callback URLs on a phishing
 * domain. requestOrigin() therefore only honours hosts on the allowlist
 * below; anything else falls through to PUBLIC_BASE_URL / the default.
 * Add new production domains to PUBLIC_HOST_SUFFIXES / PUBLIC_HOSTS.
 */

const DEFAULT_PUBLIC_BASE_URL = 'https://valmontpay.app';

/** Exact hosts that may be reflected into generated URLs. */
const PUBLIC_HOSTS = new Set([
  'valmontpay.app',
  'www.valmontpay.app',
  'localhost',
  '127.0.0.1',
  '0.0.0.0'
]);

/** Suffixes considered safe (any Vercel preview / project domain). */
const PUBLIC_HOST_SUFFIXES = ['.vercel.app'];

function isAllowedHost(hostname) {
  if (!hostname) return false;
  const bare = String(hostname).toLowerCase().split(':')[0].trim();
  if (PUBLIC_HOSTS.has(bare)) return true;
  return PUBLIC_HOST_SUFFIXES.some(suffix => bare.endsWith(suffix));
}

/** First element of a possibly comma-joined (multi-proxy) header value. */
function firstHeaderValue(value) {
  return String(value).split(',')[0].trim();
}

/**
 * Best-effort public origin of the running deployment, taken from the
 * request headers. Returns null when the host is missing or not trusted.
 */
function requestOrigin(req) {
  const headers = (req && req.headers) || {};
  const host =
    headers['x-forwarded-host'] ||
    headers.host ||
    (typeof (req && req.get) === 'function' ? req.get('host') : null);

  if (!host) return null;
  const bareHost = firstHeaderValue(host);
  if (!isAllowedHost(bareHost)) return null;

  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(bareHost);
  const proto =
    headers['x-forwarded-proto'] ||
    (req && req.protocol) ||
    (isLocal ? 'http' : 'https');

  return `${firstHeaderValue(proto)}://${bareHost}`;
}

/**
 * The public base URL for building absolute links.
 *
 * Precedence:
 *   1. The (allowlisted) host of the incoming request — always works,
 *      immune to stale env vars.
 *   2. PUBLIC_BASE_URL env var (explicit override for non-HTTP contexts).
 *   3. DEFAULT_PUBLIC_BASE_URL (the canonical production domain).
 */
function publicBaseUrl(req) {
  const fromRequest = requestOrigin(req);
  if (fromRequest) return fromRequest;

  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  }

  return DEFAULT_PUBLIC_BASE_URL;
}

/** The URL Paystack should POST payment events to. */
function canonicalWebhookUrl(req) {
  return `${publicBaseUrl(req)}/api/webhook`;
}

module.exports = {
  DEFAULT_PUBLIC_BASE_URL,
  PUBLIC_HOSTS,
  PUBLIC_HOST_SUFFIXES,
  isAllowedHost,
  requestOrigin,
  publicBaseUrl,
  canonicalWebhookUrl
};
