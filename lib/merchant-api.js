/**
 * The merchant-facing HTTP API.
 *
 *   POST /api/transaction/initialize          secret key   -> access_code
 *   GET  /api/transaction/verify/:reference   secret key   -> canonical data
 *   POST /api/checkout/resolve                access_code  -> amount (pay.html)
 *   POST /api/checkout/complete               access_code  -> settle + redirect
 *   GET  /api/merchant/keys                   dashboard
 *   GET  /api/merchant/webhook                dashboard
 *   PUT  /api/merchant/webhook                dashboard
 *   GET  /api/merchant/deliveries             dashboard
 *   POST /api/merchant/deliveries/:id/replay  dashboard
 *   GET  /api/merchant/payments               dashboard
 *
 * Exported as an Express Router so server.js mounts it in one line, and — since
 * vercel.json already sends every unmatched path to server.js — the same code
 * serves local development and production.
 *
 * The `:reference` path parameter is used verbatim. `VE-MFA1B2C3`,
 * `VE-BK-123456` and anything else are opaque keys; nothing here splits on `-`.
 */

const express = require('express');
const keys = require('./keys');
const merchants = require('./merchants');
const payments = require('./payments');
const webhookDelivery = require('./webhook-delivery');
const gateway = require('./gateway');
const money = require('./money');

const router = express.Router();

/** Uniform error body. */
function fail(res, statusCode, code, message, extra = {}) {
  return res.status(statusCode).json({ status: false, code, message, ...extra });
}

/**
 * Require a valid secret key. On success attaches `req.merchant` / `req.mode`.
 * A secret key in a QUERY STRING is never accepted — see keys.extractSecretKey.
 */
function requireSecretKey(req, res, next) {
  const presented = keys.extractSecretKey(req);
  if (!presented) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="valmontpay"');
    return fail(res, 401, 'missing_credentials', 'Provide your secret key as: Authorization: Bearer sk_live_...');
  }
  const auth = merchants.authenticateSecretKey(presented);
  if (!auth) {
    console.warn(`[AUTH] Rejected secret key ${keys.redact(presented)}`);
    return fail(res, 401, 'invalid_key', 'Invalid API key');
  }
  req.merchant = auth.merchant;
  req.mode = auth.mode;
  return next();
}

/**
 * Dashboard authorisation.
 *
 * The dashboard is an operator tool, not a public page: it can read secret keys
 * and replay webhooks. It authenticates with the same secret key (sent by the
 * logged-in operator), so there is exactly one credential to protect.
 */
const requireDashboardAuth = requireSecretKey;

// ---------------------------------------------------------------------------
// 1. Server-side initialize — the fix for the editable-amount hole.
// ---------------------------------------------------------------------------
router.post('/transaction/initialize', requireSecretKey, (req, res) => {
  const body = req.body || {};

  const amount = money.parseMinor(body.amount);
  if (amount === null) {
    return fail(
      res,
      400,
      'invalid_amount',
      'amount is required and must be a positive integer in minor units (pesewas: GH\u20b5 15.00 -> 1500)'
    );
  }

  const reference = body.reference === undefined || body.reference === null ? '' : String(body.reference).trim();
  if (!reference) {
    return fail(res, 400, 'invalid_reference', 'reference is required and is treated as an opaque idempotency key');
  }

  const result = payments.initialize({
    merchant: req.merchant,
    mode: req.mode,
    amount,
    reference,
    email: body.email,
    phone: body.phone,
    callback_url: body.callback_url,
    currency: body.currency,
    metadata: body.metadata,
    source: 'initialize'
  });

  if (!result.ok) {
    const statusCode = result.code === 'reference_conflict' || result.code === 'already_completed' ? 409 : 400;
    return fail(res, statusCode, result.code, result.error);
  }

  const record = result.record;
  const origin = req.baseOrigin || `${req.protocol}://${req.get('host')}`;

  console.log(
    `[INITIALIZE] ${record.reference} | ${record.merchant} | ${record.currency} ` +
      `${money.toMajor(record.amount).toFixed(2)} | mode=${record.mode} | reused=${result.reused}`
  );

  return res.status(result.reused ? 200 : 201).json({
    status: true,
    message: 'Authorization URL created',
    data: {
      // Opaque. Carries NO amount — that is the entire point.
      access_code: record.access_code,
      reference: record.reference,
      // The URL to send the customer to.
      authorization_url: `${origin}/pay.html?access_code=${encodeURIComponent(record.access_code)}`,
      amount: record.amount,
      currency: record.currency,
      expires_at: record.access_code_expires_at
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Verify — the merchant's fallback when a webhook is missed.
// ---------------------------------------------------------------------------
router.get('/transaction/verify/:reference', requireSecretKey, (req, res) => {
  // Opaque key, used exactly as received.
  const reference = req.params.reference;
  // Scoped to the mode the presented key belongs to, so a test key can never
  // read a live payment (and the two never collide on the same reference).
  const record = payments.get(reference, req.mode);

  if (!record) {
    return fail(res, 404, 'not_found', 'Transaction reference not found');
  }
  if (record.merchant_id && record.merchant_id !== req.merchant.id) {
    // Do not confirm that someone else's reference exists.
    return fail(res, 404, 'not_found', 'Transaction reference not found');
  }
  if (record.mode !== req.mode) {
    return fail(
      res,
      404,
      'not_found',
      `Transaction reference not found in ${req.mode} mode`
    );
  }

  return res.status(200).json({
    status: true,
    message: 'Verification successful',
    // Byte-for-byte the same shape as the webhook's `data`.
    data: payments.toPublicData(record)
  });
});

// ---------------------------------------------------------------------------
// Checkout support — called by pay.html, NOT by merchants.
// ---------------------------------------------------------------------------

/**
 * Resolve a checkout session into a real amount.
 *
 * Two accepted inputs:
 *   { access_code }                       the secure path
 *   { ref, amount, merchant, email, ... } the legacy query-string path
 *
 * In BOTH cases the amount in the response comes from the server-side record.
 */
router.post('/checkout/resolve', (req, res) => {
  const body = req.body || {};

  if (body.access_code) {
    const result = payments.resolveAccessCode(body.access_code);
    if (!result.ok) {
      const statusCode = result.code === 'already_completed' ? 409 : 404;
      return fail(res, statusCode, result.code, result.error, {
        data: result.record ? payments.toPublicData(result.record) : null
      });
    }
    return res.status(200).json({
      status: true,
      data: checkoutView(result.record, { trusted: true, mismatch: false })
    });
  }

  // Legacy: /pay.html?amount=…&merchant=…&ref=…
  const result = payments.resolveLegacy({
    reference: body.ref || body.reference,
    amount: body.amount,
    merchant: body.merchant,
    merchantId: (merchants.getDefaultMerchant() || {}).id,
    mode: process.env.VALMONTPAY_LEGACY_MODE || 'live',
    email: body.email,
    phone: body.phone,
    callback_url: body.callback_url,
    currency: body.currency
  });

  if (!result.ok) {
    const statusCode = result.code === 'already_completed' ? 409 : 400;
    return fail(res, statusCode, result.code, result.error, {
      data: result.record ? payments.toPublicData(result.record) : null
    });
  }

  return res.status(200).json({
    status: true,
    data: checkoutView(result.record, result),
    // Told to the page so it can show "amount confirmed by merchant" and so the
    // mismatch is visible in the browser console during an integration.
    warnings: buildCheckoutWarnings(result)
  });
});

function checkoutView(record, meta = {}) {
  return {
    reference: record.reference,
    // Authoritative, server-resolved, minor units.
    amount: record.amount,
    amount_display: money.formatMinor(record.amount, record.currency),
    currency: record.currency,
    merchant: record.merchant,
    email: record.email,
    phone: record.phone,
    status: record.status,
    // false when the amount could only ever come from the URL.
    amount_verified: meta.trusted !== false && record.amount_trusted !== false,
    has_callback: Boolean(record.callback_url)
  };
}

function buildCheckoutWarnings(result) {
  const warnings = [];
  if (result.mismatch) {
    warnings.push(
      'The amount in the link did not match the initialized amount. The initialized amount is being charged.'
    );
  }
  if (result.trusted === false) {
    warnings.push(
      'This checkout link carries an unverified amount. Ask the merchant to use POST /api/transaction/initialize.'
    );
  }
  return warnings;
}

/**
 * Complete a checkout: settle the payment, enqueue exactly one webhook and hand
 * the browser the URL to bounce to.
 *
 * Called by pay.html after the customer authorises. The AMOUNT IS NOT READ FROM
 * THE REQUEST — it is whatever the server already has for this reference.
 */
router.post('/checkout/complete', (req, res) => {
  const body = req.body || {};

  let record = null;
  if (body.access_code) {
    const resolved = payments.resolveAccessCode(body.access_code);
    if (!resolved.ok) {
      const statusCode = resolved.code === 'already_completed' ? 409 : 404;
      return fail(res, statusCode, resolved.code, resolved.error, {
        redirect_url: resolved.record
          ? gateway.buildRedirectUrl(resolved.record.callback_url, resolved.record.reference, resolved.record.status)
          : null
      });
    }
    record = resolved.record;
  } else if (body.ref || body.reference) {
    record = payments.get(body.ref || body.reference);
  }

  if (!record) return fail(res, 404, 'not_found', 'Unknown checkout session');

  const requested = String(body.status || 'success').toLowerCase();
  if (!payments.TERMINAL_STATUSES.has(requested)) {
    return fail(res, 400, 'invalid_status', 'status must be success, failed or cancelled');
  }
  if (requested === payments.STATUS.REFUNDED) {
    return fail(res, 400, 'invalid_status', 'Refunds are not initiated from the checkout page');
  }

  const result = gateway.settle(record.reference, {
    status: requested,
    channel: body.channel || null,
    gateway_reference: body.gateway_reference || null,
    failure_reason: body.failure_reason || null
  });

  return res.status(result.ok ? 200 : 409).json({
    status: result.ok,
    message: result.ok
      ? result.changed
        ? 'Payment recorded'
        : 'Payment was already recorded'
      : result.error,
    data: result.data,
    // Cosmetic — the webhook is the source of truth.
    redirect_url: result.redirect_url
  });
});

// ---------------------------------------------------------------------------
// Dashboard endpoints.
// ---------------------------------------------------------------------------

/** Keys. Secret keys are redacted unless `?reveal=1` is explicitly asked for. */
router.get('/merchant/keys', requireDashboardAuth, (req, res) => {
  const safe = merchants.toSafeJSON(req.merchant);
  if (req.query.reveal === '1') {
    safe.keys.test.secret_key = req.merchant.keys.test.secret_key;
    safe.keys.live.secret_key = req.merchant.keys.live.secret_key;
    console.warn(`[MERCHANT] Secret keys revealed to the dashboard for ${req.merchant.name}`);
  }
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ status: true, data: { ...safe, authenticated_mode: req.mode } });
});

router.post('/merchant/keys/rotate', requireDashboardAuth, (req, res) => {
  const mode = String((req.body && req.body.mode) || req.mode);
  const result = merchants.rotateKeys(req.merchant.id, mode);
  if (!result.ok) return fail(res, 400, 'rotate_failed', result.error);
  return res.status(200).json({
    status: true,
    message: `Rotated ${mode} keys. The previous secret key no longer works.`,
    data: result.keypair
  });
});

router.get('/merchant/webhook', requireDashboardAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    status: true,
    data: {
      merchant: req.merchant.name,
      mode: req.mode,
      webhooks: req.merchant.webhooks,
      signature_header: 'x-valmontpay-signature',
      algorithm: 'HMAC-SHA512 (hex) over the raw request body, keyed with your secret key'
    }
  });
});

router.put('/merchant/webhook', requireDashboardAuth, (req, res) => {
  const body = req.body || {};
  const mode = String(body.mode || req.mode);
  const result = merchants.setWebhookUrl(req.merchant.id, mode, body.url || null);
  if (!result.ok) return fail(res, 400, 'invalid_webhook_url', result.error);
  return res.status(200).json({
    status: true,
    message: body.url ? 'Webhook URL saved' : 'Webhook delivery disabled',
    data: { mode, webhooks: result.merchant.webhooks[mode] }
  });
});

router.get('/merchant/deliveries', requireDashboardAuth, (req, res) => {
  const list = webhookDelivery.list({
    merchantId: req.merchant.id,
    mode: req.query.mode || undefined,
    reference: req.query.reference || undefined,
    state: req.query.state || undefined
  });
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    status: true,
    data: list.map(webhookDelivery.toDashboardJSON),
    summary: {
      total: list.length,
      delivered: list.filter(d => d.state === webhookDelivery.STATE.DELIVERED).length,
      pending: list.filter(d => d.state === webhookDelivery.STATE.PENDING).length,
      failed: list.filter(d => d.state === webhookDelivery.STATE.FAILED).length,
      disabled: list.filter(d => d.state === webhookDelivery.STATE.DISABLED).length
    }
  });
});

router.post('/merchant/deliveries/:id/replay', requireDashboardAuth, async (req, res) => {
  const delivery = webhookDelivery.get(req.params.id);
  if (!delivery || delivery.merchant_id !== req.merchant.id) {
    return fail(res, 404, 'not_found', 'Unknown delivery');
  }
  const result = await webhookDelivery.replay(req.params.id);
  if (!result.ok) return fail(res, 400, 'replay_failed', result.error);
  return res.status(200).json({
    status: true,
    message: 'Replayed with the original event id and body',
    data: webhookDelivery.toDashboardJSON(result.delivery)
  });
});

router.get('/merchant/payments', requireDashboardAuth, (req, res) => {
  const list = payments.list({
    merchantId: req.merchant.id,
    mode: req.query.mode || undefined,
    status: req.query.status || undefined
  });
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    status: true,
    data: list.map(payments.toDashboardJSON),
    summary: {
      total: list.length,
      succeeded: list.filter(p => p.status === payments.STATUS.SUCCESS).length,
      // The interesting one: links whose amount could not be verified.
      unverified_amounts: list.filter(p => p.amount_trusted === false).length,
      volume_minor: list
        .filter(p => p.status === payments.STATUS.SUCCESS)
        .reduce((total, p) => total + p.amount, 0),
      currency: money.currency()
    }
  });
});

module.exports = { router, requireSecretKey };
