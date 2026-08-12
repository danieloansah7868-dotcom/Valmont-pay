/**
 * Security headers for every response. Small enough to avoid a Helmet
 * dependency; specific enough to close the obvious browser holes.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://js.paystack.co",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://api.paystack.co",
  "frame-src https://js.paystack.co https://checkout.paystack.com https://standard.paystack.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Content-Security-Policy', CSP);
  const proto = String(
    (req.headers && (req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto'])) ||
    req.protocol ||
    ''
  ).split(',')[0].trim().toLowerCase();
  if (proto === 'https' || process.env.VERCEL) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return next ? next() : undefined;
}

module.exports = {
  applySecurityHeaders,
  CSP
};
