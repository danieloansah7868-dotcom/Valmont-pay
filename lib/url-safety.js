/**
 * URL allow/deny helpers for tenant webhooks and post-payment redirects.
 *
 * Blocks the two classic holes:
 *   - open redirect (any callback_url → 302)
 *   - SSRF via webhook_url (http://169.254.169.254/, RFC1918, localhost)
 */

const net = require('net');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  '0.0.0.0',
  '::',
  '::1'
]);

function firstIpv4(hostname) {
  const bare = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(bare) === 4) return bare;
  return null;
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(n => Number(n));
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(hostname) {
  const bare = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(bare) !== 6) return false;
  if (bare === '::1' || bare === '::') return true;
  if (bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('fe80')) return true;
  return false;
}

function isLocalHostname(hostname) {
  const bare = String(hostname || '').toLowerCase().split('%')[0];
  if (!bare) return true;
  if (BLOCKED_HOSTNAMES.has(bare)) return true;
  if (bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) return true;
  const ipv4 = firstIpv4(bare);
  if (ipv4 && isPrivateIpv4(ipv4)) return true;
  if (isPrivateIpv6(bare)) return true;
  return false;
}

function allowHttpLocalhost() {
  return !process.env.VERCEL && process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
}

function isLoopbackHostname(hostname) {
  const bare = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

/**
 * Tenant webhook URLs: https only, no credentials, no private/link-local hosts.
 * http://localhost is permitted only in local development.
 */
function validatePublicHttpsUrl(value, { purpose = 'url' } = {}) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: `${purpose} is required` };
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    return { ok: false, reason: `${purpose} is not a valid URL` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: `${purpose} must not contain credentials` };
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  const privateHost = isLocalHostname(parsed.hostname);
  if (parsed.protocol === 'http:') {
    if (loopback && allowHttpLocalhost()) return { ok: true, url: parsed.toString() };
    return { ok: false, reason: `${purpose} must use https` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `${purpose} must use https` };
  }
  if (privateHost) {
    return { ok: false, reason: `${purpose} must not target a private or link-local host` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Customer return/callback redirects. https (or local http in dev), never
 * javascript:/data:, never an internal admin path on this origin.
 */
const INTERNAL_PATHS = new Set([
  '/dashboard.html', '/dashboard',
  '/admin.html', '/admin',
  '/admin-login.html', '/admin-login',
  '/tenants.html', '/tenants',
  '/webhook-status.html', '/webhook-status',
  '/payout.html', '/config/admin.js'
]);

function validateRedirectUrl(value, { allowedDomains = [], originHost = '' } = {}) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'callback_url is required' };
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    return { ok: false, reason: 'callback_url is not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'callback_url must be http(s)' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'callback_url must not contain credentials' };
  }
  const host = parsed.hostname.toLowerCase();
  if (isLocalHostname(host) && parsed.protocol === 'http:' && !allowHttpLocalhost()) {
    return { ok: false, reason: 'callback_url must use https' };
  }
  if (isLocalHostname(host) && parsed.protocol === 'https:' && process.env.VERCEL_ENV === 'production') {
    return { ok: false, reason: 'callback_url must not target a private host' };
  }

  const path = parsed.pathname.toLowerCase();
  const sameOrigin = originHost && host === String(originHost).toLowerCase().split(':')[0];
  if (sameOrigin && INTERNAL_PATHS.has(path)) {
    return { ok: false, reason: 'callback_url must not point at an internal admin page' };
  }

  const allowed = (allowedDomains || []).map(d => String(d).toLowerCase().trim()).filter(Boolean);
  if (allowed.length) {
    const matches = allowed.some(domain => host === domain || host.endsWith('.' + domain));
    if (!matches && !((host === 'localhost' || host === '127.0.0.1') && allowHttpLocalhost())) {
      return { ok: false, reason: `Domain "${host}" is not in the allowlist for this merchant` };
    }
  }

  return { ok: true, url: parsed };
}

module.exports = {
  isLocalHostname,
  validatePublicHttpsUrl,
  validateRedirectUrl,
  INTERNAL_PATHS,
  allowHttpLocalhost
};
