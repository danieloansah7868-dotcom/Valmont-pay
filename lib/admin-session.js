/**
 * Signed, httpOnly admin sessions.
 *
 * Replaces the previous "download ADMIN_PASSWORD into the browser" login
 * (/config/admin.js). The password never leaves the server. The cookie is
 * HMAC-SHA256 over a compact payload so any isolate can verify it — no
 * shared session store required on Vercel.
 *
 * Cookie: vp_admin=<base64url(payload)>.<base64url(hmac)>
 * Payload: { e: email, iat, exp }
 */

const crypto = require('crypto');

const COOKIE_NAME = 'vp_admin';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

function adminEmail() {
  return String(process.env.ADMIN_EMAIL || 'support@valmontpay.com').trim().toLowerCase();
}

function sessionSecret() {
  if (process.env.ADMIN_SESSION_SECRET) return process.env.ADMIN_SESSION_SECRET;
  const password = adminPassword();
  if (!password) return '';
  return crypto.createHash('sha256').update(`valmont-admin-session:${password}`).digest('hex');
}

function ttlSeconds() {
  const raw = Number(process.env.ADMIN_SESSION_TTL_SECONDS);
  if (Number.isFinite(raw) && raw >= 60) return Math.floor(raw);
  return DEFAULT_TTL_SECONDS;
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function sign(payloadB64, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const header = (req && req.headers && (req.headers.cookie || req.headers.Cookie)) || '';
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch (_) {
      out[key] = value;
    }
  }
  return out;
}

function issueSession(email) {
  const secret = sessionSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    e: String(email || adminEmail()).trim().toLowerCase(),
    iat: now,
    exp: now + ttlSeconds()
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

function verifySessionToken(token) {
  const secret = sessionSecret();
  if (!secret || !token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!mac || !safeEqual(mac, sign(payloadB64, secret))) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function readSession(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME] || '');
}

function cookieSecure(req) {
  if (process.env.COOKIE_SECURE === '0') return false;
  if (process.env.COOKIE_SECURE === '1' || process.env.VERCEL) return true;
  const proto = String(
    (req && req.headers && (req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto'])) ||
    (req && req.protocol) ||
    ''
  ).split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function serializeCookie(value, { maxAgeSeconds, secure, clear } = {}) {
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(value || '')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (secure) parts.push('Secure');
  if (clear) {
    parts.push('Max-Age=0');
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else if (Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  }
  return parts.join('; ');
}

function sessionCookieHeader(req, token) {
  return serializeCookie(token, { maxAgeSeconds: ttlSeconds(), secure: cookieSecure(req) });
}

function clearSessionCookieHeader(req) {
  return serializeCookie('', { clear: true, secure: cookieSecure(req) });
}

function setSessionCookie(res, req, token) {
  res.setHeader('Set-Cookie', sessionCookieHeader(req, token));
}

function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', clearSessionCookieHeader(req));
}

function credentialsMatch(email, password) {
  const expectedEmail = adminEmail();
  const expectedPassword = adminPassword();
  if (!expectedPassword) return { ok: false, reason: 'admin-not-configured' };
  const presentedEmail = String(email || '').trim().toLowerCase();
  if (!presentedEmail || presentedEmail !== expectedEmail) {
    return { ok: false, reason: 'invalid-credentials' };
  }
  if (!safeEqual(String(password || ''), expectedPassword)) {
    return { ok: false, reason: 'invalid-credentials' };
  }
  return { ok: true, email: expectedEmail };
}

function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  const header = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return safeEqual(match[1].trim(), secret);
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_SECONDS,
  adminEmail,
  adminPassword,
  sessionSecret,
  ttlSeconds,
  safeEqual,
  parseCookies,
  issueSession,
  verifySessionToken,
  readSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  setSessionCookie,
  clearSessionCookie,
  credentialsMatch,
  isCronAuthorized
};
