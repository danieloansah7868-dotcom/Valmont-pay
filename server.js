const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const {
  initializePayment,
  initializePaymentWithKey,
  verifyPayment,
  verifyPaymentWithKey,
  generateReference,
  toSubunits
} = require('./lib/paystack');
const ledger = require('./lib/ledger');
const { handleWebhookEvent, toLedgerRecord } = require('./lib/webhook');
const { isSupabaseConfigured, supabaseConfigState, getSupabaseClient } = require('./lib/supabase');
const transactionStore = require('./lib/transaction-store');
const webhookLog = require('./lib/webhook-log');
const webhookDiagnostics = require('./lib/webhook-diagnostics');
const tenants = require('./lib/tenants');
const paystackCredentials = require('./lib/paystack-credentials');
const accessCodeStore = require('./lib/access-code-store');
const webhookForwarder = require('./lib/tenant-webhook-forwarder');
const notifier = require('./lib/notifier');
const paymentLinkStore = require('./lib/payment-link-store');
const mandateStore = require('./lib/mandate-store');
const serviceCatalogue = require('./lib/service-catalogue');
const legacyLinkPolicy = require('./lib/legacy-link-policy');
const { publicBaseUrl } = require('./lib/base-url');
const adminAuth = require('./lib/admin-auth');
const { requireAdmin, isAuthorizedAdmin, unauthorizedPayload, adminAuthEnforced } = adminAuth;
const adminSession = require('./lib/admin-session');
const rateLimit = require('./lib/rate-limit');

// Vercel runs the dashboard checkout (POST /api/v1/transaction/charge) in a
// serverless function whose memory disappears between requests, so a payment
// that is not written to Supabase is a payment the dashboard will never see.
// In that environment a persistence failure must be reported, not swallowed.
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

// Simulated USSD/card authorization delay. Overridable so the test suite does
// not have to sit through it.
const CHARGE_SETTLEMENT_DELAY_MS = Number(process.env.CHARGE_SETTLEMENT_DELAY_MS) || 2000;

const app = express();
const PORT = process.env.PORT || 3000;

// Build absolute URLs from the incoming request instead of hardcoding the
// production domain AND instead of blindly trusting PUBLIC_BASE_URL: the
// request's (allowlisted) host always wins, so a stale/misconfigured env
// var can never again send customers to a dead domain. See lib/base-url.js.
function baseUrl(req) {
  return publicBaseUrl(req);
}

// ─── CORS ────────────────────────────────────────────────────────────────
// Public checkout/storefront endpoints are genuinely cross-origin, so a
// permissive default is intentional here. What is NOT safe is combining
// `*` with credentials: `origin: true` reflects the caller's origin, and
// `credentials: false` guarantees the admin session cookie is never sent
// or readable cross-site. Together with SameSite=Strict on the cookie,
// that closes the "any website reads your ledger / rides your session"
// path while leaving storefront integrations working.
app.use(cors({
  origin: true,
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'x-valmontpay-signature', 'Cache-Control']
}));
// Keep the raw body around so the Paystack webhook signature (an HMAC over the
// exact bytes Paystack sent) can be verified.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf ? buf.toString('utf8') : ''; }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// LIVE TRANSACTION LEDGER (shared in-memory store, see lib/ledger.js)
// It starts EMPTY — no seeded demo rows, no fake starting balance. The
// settled balance is always derived by summing SUCCESSFUL transactions.
const TRANSACTIONS = ledger.TRANSACTIONS;

// API 1: Initialize Transaction — the dashboard "Generate link" button.
// The returned pay.html?access_code=… link must survive serverless cold
// starts and multi-instance routing, so the payment intent is persisted
// durably (Supabase payment_links table) in addition to the in-memory
// access-code store. When Supabase is configured but the write fails, we
// return an error rather than hand out a link that will 404 for the client.
app.post('/api/v1/transaction/initialize', rateLimit.limit('link-generate', {
  max: 30, windowMs: 60 * 1000,
  message: 'Too many payment links generated. Please wait a minute and try again.'
}), async (req, res) => {
  const { email, amount, callback_url, merchant } = req.body;

  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ status: false, message: 'Invalid transaction details.' });
  }

  // ─── FREE-CHECKOUT FIX ────────────────────────────────────────────
  // The old implementation handed back a checkout.html URL that
  // silently simulated SUCCESS without ever touching Paystack. Any
  // visitor could craft a fake ref + amount and settle fake money in
  // the ledger. Now we go through the SECURE pay.html flow: a one-time
  // access_code locks the amount/merchant server-side so the customer
  // cannot tamper with it, and pay.html loads Paystack's real inline
  // checkout (no more simulated settlement).
  // ──────────────────────────────────────────────────────────────────
  const reference = generateReference();
  const origin = baseUrl(req);
  const merchantKey = String(merchant || 'valmont-electricals').toLowerCase();
  const matchedTenant = tenants.getTenant(merchantKey);
  // Infrastructure/routing falls back to the default tenant when the typed
  // name is not a tenant key — but the BRANDING the customer sees must be
  // what the operator typed. Previously "Daniel" silently displayed as
  // "Valmont Electricals" because the fallback tenant's display_name won.
  const tenant = matchedTenant || tenants.getTenant('valmont-electricals');
  const displayName = matchedTenant
    ? matchedTenant.display_name
    : (merchant ? String(merchant).trim() : '') || (tenant && tenant.display_name) || 'Valmont-Pay';

  // Record the payment intent (PENDING) so the dashboard can see it
  const newTransaction = ledger.addTransaction({
    reference,
    customer: email,
    amount: parseFloat(amount),
    channel: 'PENDING',
    status: 'PENDING',
    merchant: merchant || (tenant && tenant.display_name) || 'Valmont-Pay',
    tenant_key: tenant ? tenant.key : null,
    callback_url: callback_url || ''
  });

  // Build a one-time access code (source of truth for amount/merchant)
  const accessCodeData = accessCodeStore.createAccessCode({
    amount: parseFloat(amount),
    reference,
    currency: (tenant && tenant.currency) || 'GHS',
    email,
    phone: '',
    callback_url: callback_url || '',
    tenant_key: tenant ? tenant.key : null,
    merchant_display_name: displayName,
    merchant_brand_color: (tenant && tenant.brand_color) || '#f68b1e',
    merchant_logo_url: (tenant && tenant.logo_url) || '/logo.svg'
  });

  console.log(`[TENANT-INIT v1] ${tenant ? tenant.key : 'unknown'}: Ref ${reference} | Amount GHS ${amount} | Email ${email}`);

  // Durable persistence: a payment link a merchant sends to a client must
  // keep working after cold starts and across serverless instances. The
  // in-memory access-code store alone cannot promise that on Vercel.
  const persistence = await paymentLinkStore.persistPaymentLink({
    accessCode: accessCodeData.access_code,
    payment: accessCodeData.payment,
    ttlMs: paymentLinkStore.linkTtlMs()
  });

  if (!persistence.ok) {
    console.error('[LINK-GEN] ✗ payment link was NOT persisted — refusing to hand out a dead link:', persistence.reason);
    return res.status(502).json({
      status: false,
      message: 'The payment link could not be saved durably, so it was not generated. ' +
        'If this persists, apply scripts/supabase-payment-links-schema.sql to your Supabase project.',
      detail: persistence.reason
    });
  }

  if (!persistence.durable) {
    console.warn(`[LINK-GEN] ${reference}: link is memory-only (Supabase not configured); it will not survive a restart.`);
  }

  res.status(200).json({
    status: true,
    message: 'Transaction initialized successfully',
    data: {
      reference,
      amount: newTransaction.amount,
      merchant: newTransaction.merchant || displayName,
      access_code: accessCodeData.access_code,
      callback_url: callback_url || '',
      link_expires_at: persistence.expiresAt || null,
      link_durable: Boolean(persistence.durable),
      // SECURE checkout: pay.html resolves everything from access_code
      checkout_url: `${origin}/pay.html?access_code=${encodeURIComponent(accessCodeData.access_code)}`,
      pay_url: `${origin}/pay.html?access_code=${encodeURIComponent(accessCodeData.access_code)}`,
      // Legacy fields retained for backwards-compat, but the URL now
      // points at pay.html (NOT the simulated-charge checkout.html).
      payment_url: `${origin}/pay.html?access_code=${encodeURIComponent(accessCodeData.access_code)}`
    }
  });
});

// API 2: Process Charge (SECURED — no more simulated SUCCESS)
//
// FREE-CHECKOUT BUG FIX: the previous implementation of this endpoint
// silently flipped any PENDING row to SUCCESS after a 2-second delay,
// without ever talking to Paystack. A visitor could post a fake
// reference + amount and see large sums "settled" in the ledger.
//
// Going forward this endpoint:
//   1. NEVER marks a transaction SUCCESS on its own. Only Paystack's
//      signed webhook (or a successful /api/verify-payment round-trip)
//      can do that.
//   2. If Paystack is configured, verifies the reference against
//      Paystack before returning a status.
//   3. Otherwise instructs the caller to use the secure pay.html flow
//      instead of pretending money moved.
app.post('/api/v1/transaction/charge', async (req, res) => {
  const { reference, channel, wallet_number, card_number, amount, email, merchant } = req.body || {};

  if (!reference) {
    return res.status(400).json({ status: false, message: 'Transaction reference is required.', trx_status: 'FAILED' });
  }

  // Look up or register the payment intent
  let trx = ledger.findTransaction(reference);
  if (!trx) {
    trx = ledger.addTransaction({
      reference,
      customer: email || 'unknown@customer',
      amount: parseFloat(amount) || 0,
      channel: 'PENDING',
      status: 'PENDING',
      merchant: merchant || 'Valmont-Pay'
    });
  }

  if (trx.status === 'SUCCESS') {
    return res.status(200).json({
      status: true,
      message: 'Charge already confirmed',
      reference,
      amount: trx.amount,
      trx_status: 'SUCCESS'
    });
  }

  if (trx.status === 'FAILED') {
    return res.status(200).json({
      status: false,
      message: 'This transaction was previously declined.',
      reference,
      trx_status: 'FAILED'
    });
  }

  if (channel) trx.channel = channel;
  const confirmedAmount = parseFloat(amount);
  if (!isNaN(confirmedAmount) && confirmedAmount > 0) trx.amount = confirmedAmount;

  const paystackKey = process.env.PAYSTACK_SECRET_KEY || '';

  if (paystackKey) {
    try {
      const paystack = require('./lib/paystack');
      const result = await paystack.verifyPayment(reference);
      if (result && result.status && result.data && result.data.status === 'success') {
        // Real money confirmed by Paystack
        ledger.upsertTransaction({ reference, status: 'SUCCESS' });
        if (isSupabaseConfigured()) {
          const client = getSupabaseClient();
          if (client) {
            await transactionStore.saveTransaction(
              {
                reference,
                merchant: trx.merchant,
                customer: trx.customer,
                amount: trx.amount,
                channel: trx.channel,
                status: 'SUCCESS',
                paid_at: result.data.paid_at || new Date().toISOString()
              },
              { context: 'CHARGE-VERIFIED', client }
            );
          }
        }
        return res.status(200).json({
          status: true,
          message: 'Charge confirmed by Paystack',
          reference,
          amount: trx.amount,
          trx_status: 'SUCCESS'
        });
      }
      if (result && result.data && result.data.status === 'failed') {
        return res.status(200).json({
          status: false,
          message: 'Transaction was declined by the payment provider.',
          reference,
          trx_status: 'FAILED'
        });
      }
    } catch (err) {
      console.log('[CHARGE] Paystack verify failed:', err.message);
    }
  }

  // Payment is NOT confirmed. NEVER mark SUCCESS without Paystack.
  return res.status(200).json({
    status: false,
    trx_status: 'PENDING',
    message: 'Please complete the payment via Paystack. This endpoint no longer simulates success.',
    reference,
    secure_checkout_url: '/pay.html?reference=' + encodeURIComponent(reference) +
      '&amount=' + encodeURIComponent(trx.amount) +
      '&email=' + encodeURIComponent(trx.customer) +
      '&merchant=' + encodeURIComponent(trx.merchant)
  });
});

// API 3: Verify Transaction Status
app.get('/api/v1/transaction/verify/:reference', (req, res) => {
  const { reference } = req.params;
  const trx = TRANSACTIONS.find(t => t.reference === reference);
  
  if (!trx) {
    return res.status(404).json({ status: false, message: 'Transaction reference not found.' });
  }

  res.status(200).json({
    status: true,
    message: 'Transaction verified',
    data: {
      reference: trx.reference,
      customer: trx.customer,
      amount: trx.amount,
      channel: trx.channel,
      status: trx.status,
      timestamp: trx.timestamp
    }
  });
});

// ─── STANDING MANDATES / RECURRING BILLING API (Act 987 / BoG Compliant) ───
// Allows tenants and merchants to inspect active standing instructions,
// revoke mandates (mandatory opt-out), or execute merchant-initiated charges.

// ─── Standing mandates / recurring billing ───────────────────────────────
//
// SECURITY: these endpoints operate on Paystack `authorization_code`s —
// reusable tokens that pull money from a customer's card or MoMo wallet
// WITHOUT further customer interaction. They were previously completely
// unauthenticated, which made them a self-contained remote theft primitive:
// GET /api/v1/mandates dumped every authorization_code, and POST
// /api/v1/mandates/charge then billed any of them for an arbitrary amount.
// Unauthenticated /revoke was an anonymous denial-of-revenue (and, given
// consent obligations under Ghana's Act 987 / Act 843, a compliance issue).
//
// Access model now:
//   - Admin (session cookie or X-Admin-Key) → full cross-tenant access.
//   - Tenant (Authorization: Bearer <secret_key>) → only its OWN mandates,
//     enforced by mandateVisibleTo() on every read, charge and revoke.
//   - Anonymous → 401, always.
const mandateRateLimit = rateLimit.limit('mandates', {
  max: 20,
  windowMs: 60 * 1000,
  message: 'Too many mandate requests. Please slow down.'
});

function requireMandateAuth(req, res, next) {
  if (adminAuth.isMisconfigured()) {
    return res.status(503).json(adminAuth.misconfiguredPayload());
  }

  if (isAuthorizedAdmin(req)) {
    req.isAdmin = true;
    return next();
  }

  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (match) {
    const tenant = tenants.getTenantBySecretKey(match[1].trim());
    if (tenant) {
      req.tenant = tenant;
      return next();
    }
  }

  return res.status(401).json({
    status: false,
    message: 'Authorization required. Use a tenant secret key (Authorization: Bearer <key>) or admin credentials.'
  });
}

/**
 * Can the authenticated caller see/act on this mandate?
 * Admins: everything. Tenants: only rows carrying their own tenant_key —
 * matched on the canonical key so legacy aliases resolve correctly. A
 * mandate with no tenant_key is admin-only, never shared across tenants.
 */
function mandateVisibleTo(req, mandate) {
  if (!mandate) return false;
  if (req.isAdmin) return true;
  if (!req.tenant) return false;

  const owner = mandate.tenant_key ? tenants.canonicalTenantKey(mandate.tenant_key) : null;
  if (!owner) return false;
  return owner === tenants.canonicalTenantKey(req.tenant.key);
}

app.get('/api/v1/mandates', mandateRateLimit, requireMandateAuth, async (req, res) => {
  const merchant_name = req.query.merchant || req.query.merchant_name || undefined;
  const customer_email = req.query.email || req.query.customer_email || undefined;
  const status = req.query.status || undefined;

  const result = await mandateStore.listMandates({ merchant_name, customer_email, status });
  // A tenant may only ever see its OWN mandates. Admins see everything.
  const visible = (result.mandates || []).filter(m => mandateVisibleTo(req, m));

  return res.status(200).json({
    status: result.ok,
    count: visible.length,
    data: visible,
    error: result.error ? result.reason : null
  });
});

app.get('/api/v1/mandates/:code', mandateRateLimit, requireMandateAuth, async (req, res) => {
  const code = req.params.code;
  const mandate = await mandateStore.getMandate(code);
  // 404 (not 403) on a cross-tenant read, so the API never confirms that
  // another tenant's authorization_code exists.
  if (!mandate || !mandateVisibleTo(req, mandate)) {
    return res.status(404).json({ status: false, message: `Mandate ${code} not found.` });
  }
  return res.status(200).json({ status: true, data: mandate });
});

app.post('/api/v1/mandates/charge', mandateRateLimit, requireMandateAuth, async (req, res) => {
  const { authorization_code, amount, email, reference, currency, subaccount, merchant, metadata } = req.body || {};
  if (!authorization_code || !amount) {
    return res.status(400).json({ status: false, message: 'authorization_code and positive amount are required.' });
  }

  // Ownership check BEFORE any money moves: a tenant must not be able to
  // charge a mandate belonging to another merchant.
  const target = await mandateStore.getMandate(authorization_code);
  if (!target || !mandateVisibleTo(req, target)) {
    return res.status(404).json({ status: false, message: `Mandate ${authorization_code} not found.` });
  }

  const result = await mandateStore.chargeMandate({
    authorization_code,
    amount,
    email,
    reference,
    currency,
    subaccount,
    merchant,
    metadata
  });

  if (!result.ok) {
    return res.status(400).json({
      status: false,
      message: result.reason || 'Recurring mandate charge failed.',
      paystack_response: result.paystackResponse || null
    });
  }

  return res.status(200).json({
    status: true,
    message: 'Mandate charged successfully',
    data: result.transaction,
    paystack_response: result.paystackResponse || null
  });
});

app.post('/api/v1/mandates/revoke', mandateRateLimit, requireMandateAuth, async (req, res) => {
  const { authorization_code } = req.body || {};
  if (!authorization_code) {
    return res.status(400).json({ status: false, message: 'authorization_code is required.' });
  }

  const target = await mandateStore.getMandate(authorization_code);
  if (!target || !mandateVisibleTo(req, target)) {
    return res.status(404).json({ status: false, message: `Mandate ${authorization_code} not found.` });
  }

  const result = await mandateStore.revokeMandate(authorization_code);
  if (!result.ok) {
    return res.status(404).json({ status: false, message: result.reason || `Mandate ${authorization_code} not found.` });
  }

  return res.status(200).json({
    status: true,
    message: 'Mandate revoked successfully. No further automated charges can occur.',
    data: result.data || result.record
  });
});

// API 3b: Paystack-backed endpoints (same contract as the /api serverless
// functions, so local development and Vercel behave identically).
app.post('/api/initialize-payment', rateLimit.limit('payment-init', {
  max: 30, windowMs: 60 * 1000
}), async (req, res) => {
  const body = req.body || {};
  const { email, phone, callback_url } = body;
  let merchant = body.merchant;
  let amount = parseFloat(body.amount);
  let reference = body.reference || generateReference();
  // Paystack subaccount (body or query) — enables split settlement (e.g. ACCT_... for automatic 98%/2% splits).
  let subaccount = body.subaccount || (req.query && req.query.subaccount);

  // ─── AMOUNT AUTHORITY ─────────────────────────────────────────────
  // body.amount is NOT gospel. It arrives from a browser that may have
  // read it straight out of the address bar.
  //
  //   1. If the caller presents an access_code, the stored payment
  //      intent is the source of truth: amount, reference and merchant
  //      are re-read from it and the body values are ignored. Editing
  //      ?amount= on an access-code URL therefore cannot change what is
  //      charged.
  //   2. Otherwise, if the request came from a legacy pay.html URL that
  //      carried ?amount= (Referer check), it is refused outright unless
  //      ALLOW_LEGACY_AMOUNT_URL=1 is set on this server.
  // ──────────────────────────────────────────────────────────────────
  const accessCode = typeof body.access_code === 'string' ? body.access_code.trim() : '';

  // Which Paystack account charges this payment? The tenant's, when it has
  // one; otherwise the gateway's own credential (today's behaviour for every
  // existing tenant).
  let chargeTenant = null;

  if (accessCode) {
    const resolved = await paymentLinkStore.resolvePaymentLink(accessCode);
    const intent = resolved && resolved.payment;
    if (!intent) {
      return res.status(404).json({
        success: false,
        code: 'ACCESS_CODE_INVALID',
        error: 'This payment link is invalid or has expired. Ask the merchant for a new link.'
      });
    }

    const storedAmount = parseFloat(intent.amount);
    if (!Number.isFinite(storedAmount) || storedAmount <= 0) {
      return res.status(409).json({
        success: false,
        code: 'ACCESS_CODE_AMOUNT_MISSING',
        error: 'The stored payment intent has no usable amount. Ask the merchant for a new link.'
      });
    }

    if (Number.isFinite(amount) && Math.round(amount * 100) !== Math.round(storedAmount * 100)) {
      // Not an error for the customer — the server simply wins. Logged so
      // tampering attempts are visible.
      console.warn(
        `[INIT-PAYMENT] Ignoring client amount ${amount} for access_code ${accessCode}; ` +
        `charging the stored ${storedAmount}.`
      );
    }

    amount = storedAmount;
    reference = intent.reference || reference;
    // Locked links may predate the canonical SKU tenant key. The stored
    // amount/reference remain authoritative, while routing/branding resolves
    // the legacy key through the alias.
    const canonicalIntentKey = tenants.canonicalTenantKey(intent.tenant_key);
    merchant = canonicalIntentKey || intent.tenant_key || intent.merchant_display_name || merchant;
    const intentTenant = tenants.getTenant(canonicalIntentKey || intent.tenant_key);
    subaccount = subaccount || (intentTenant && intentTenant.paystack_subaccount) || undefined;
    chargeTenant = intentTenant || null;
  } else if (
    !legacyLinkPolicy.legacyAmountUrlAllowed() &&
    legacyLinkPolicy.refererIsLegacyAmountUrl(req.headers && req.headers.referer)
  ) {
    console.warn(
      '[INIT-PAYMENT] Refused a legacy unsigned pay.html request. ' +
      `referer=${req.headers.referer} amount=${body.amount} merchant=${body.merchant || 'unknown'}`
    );
    return res.status(403).json(legacyLinkPolicy.legacyRejectionPayload());
  }

  if (!email || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
  }

  // No access code (dashboard-issued links) still resolves a tenant from the
  // merchant name so its own Paystack account is used.
  if (!chargeTenant && merchant) {
    chargeTenant = tenants.getTenant(tenants.canonicalTenantKey(String(merchant)))
      || tenants.getTenantByIdentifier(String(merchant))
      || null;
  }

  console.log('Reference:', reference);

  try {
    const data = await initializePayment({
      amount,
      email,
      reference,
      merchant,
      phone,
      subaccount,
      secretKey: paystackCredentials.chargeSecret(chargeTenant),
      callback_url:
        callback_url ||
        `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(reference)}` +
          `&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
    });

    if (data.status) {
      return res.status(200).json({
        success: true,
        paymentUrl: data.data.authorization_url,
        // access_code powers the embedded inline checkout on pay.html so the
        // customer never leaves valmontpay.app (Paystack stays in the backend).
        accessCode: data.data.access_code,
        reference: data.data.reference || reference,
        amount
      });
    }
    return res.status(400).json({ success: false, error: data.message || 'Failed to initialize payment' });
  } catch (error) {
    console.error('Payment initialization error:', error.message);
    const missingKey = error.code === 'MISSING_SECRET_KEY';
    return res.status(500).json({
      success: false,
      error: missingKey ? 'Payment provider is not configured. Set PAYSTACK_SECRET_KEY.' : 'Internal server error'
    });
  }
});

app.get('/api/verify-payment', async (req, res) => {
  const { reference, merchant } = req.query;
  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing transaction reference' });
  }

  console.log('Reference:', reference);

  // A reference only exists on the Paystack account that charged it, so
  // verify against the same credential the charge used. Resolution order:
  // an explicit ?merchant=, then the tenant already recorded against the
  // reference in the ledger, then the gateway credential (unchanged
  // behaviour for every tenant without its own account).
  let verifyTenant = null;
  if (merchant) {
    verifyTenant = tenants.getTenant(tenants.canonicalTenantKey(String(merchant)))
      || tenants.getTenantByIdentifier(String(merchant))
      || null;
  }
  if (!verifyTenant) {
    const known = ledger.findTransaction(reference);
    if (known && known.merchant) {
      verifyTenant = tenants.getTenantByIdentifier(known.merchant)
        || tenants.getTenant(known.merchant)
        || null;
    }
  }

  try {
    const data = await verifyPaymentWithKey(
      reference,
      paystackCredentials.chargeSecret(verifyTenant)
    );

    const paystackTrx = data && data.data ? data.data : null;
    const isSuccess = Boolean(data && data.status && paystackTrx && paystackTrx.status === 'success');

    // A verified Paystack transaction is a REAL payment - record it on the
    // in-memory ledger so the dashboard reflects it.
    if (data && data.status && paystackTrx && paystackTrx.reference) {
      ledger.upsertTransaction(toLedgerRecord('charge.verified', paystackTrx));

      // CRITICAL FIX: ALSO persist to Supabase so the dashboard can display it.
      // Without this, verified payments only go to the in-memory ledger, which
      // is lost on server restart and empty on Vercel cold starts.
      if (isSupabaseConfigured()) {
        const client = getSupabaseClient();
        if (client) {
          const transaction = {
            reference: paystackTrx.reference,
            merchant_name: (paystackTrx.metadata && paystackTrx.metadata.merchant) || 'Valmont-Pay',
            customer_email: paystackTrx.customer?.email || paystackTrx.email || 'unknown@customer',
            amount: (Number(paystackTrx.amount) || 0) / 100,
            payment_method: paystackTrx.channel || 'N/A',
            status: isSuccess ? 'SUCCESS' : (paystackTrx.status || 'PENDING').toUpperCase(),
            paid_at: isSuccess ? (paystackTrx.paid_at || new Date().toISOString()) : null
          };

          const persistence = await transactionStore.saveTransaction(transaction, {
            client,
            context: 'VERIFY-PAYMENT'
          });

          if (isSuccess && mandateStore && typeof mandateStore.saveMandateFromAuthorization === 'function') {
            try {
              await mandateStore.saveMandateFromAuthorization(paystackTrx, { client, context: 'VERIFY-PAYMENT' });
            } catch (mandateErr) {
              console.warn('[VERIFY-PAYMENT] Non-fatal error saving standing mandate:', mandateErr.message || mandateErr);
            }
          }

          if (persistence.ok) {
            console.log(`[VERIFY-PAYMENT] Persisted to Supabase: ${paystackTrx.reference}`);
          } else {
            console.error(`[VERIFY-PAYMENT] Failed to persist: ${paystackTrx.reference}`, persistence.reason);
          }
        }
      }
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Payment verification error:', error.message);
    const missingKey = error.code === 'MISSING_SECRET_KEY';
    return res.status(500).json({
      status: false,
      message: missingKey ? 'Payment provider is not configured. Set PAYSTACK_SECRET_KEY.' : 'Internal server error'
    });
  }
});

// API 4: Get Ledger and Account Balance (For Dashboard)
app.get('/api/v1/merchant/dashboard', (req, res) => {
  res.status(200).json({ status: true, data: ledger.getLedgerSnapshot() });
});

// API 5: Canonical transactions endpoint used by the dashboard.
//
// Supabase is the durable source of truth (the in-memory ledger is per-instance
// and disappears on a serverless cold start). When Supabase is configured its
// rows are returned, merged with anything still only in memory. When it is not
// configured we fall back to the in-memory ledger so local development keeps
// working — but a Supabase READ ERROR is surfaced rather than hidden behind an
// innocent-looking empty list.
// GUARDED: this returns customer PII (email addresses), amounts and the
// full sales history. It was public — and served with `CORS: *`, so any
// website could read a merchant's entire customer list from a visitor's
// browser. The dashboard already authenticates, so there is no longer a
// reason to leave it open.
app.get('/api/transactions', requireAdmin, async (req, res) => {
  const memorySnapshot = ledger.getLedgerSnapshot();

  if (!isSupabaseConfigured()) {
    return res.status(200).json({
      success: true,
      status: true,
      source: 'memory',
      ...memorySnapshot,
      data: memorySnapshot.transactions
    });
  }

  const result = await transactionStore.fetchTransactions({ context: 'TRANSACTIONS' });

  if (!result.ok) {
    return res.status(500).json({
      success: false,
      status: false,
      error: 'Failed to fetch transactions',
      message: result.reason,
      balance: 0,
      currency: 'GHS',
      count: 0,
      successful: 0,
      transactions: [],
      data: []
    });
  }

  // Merge: Supabase rows win by reference, in-memory-only rows are appended so
  // a PENDING transaction created seconds ago is not missing from the list.
  const byReference = new Map();
  for (const row of memorySnapshot.transactions) {
    byReference.set(row.reference, transactionStore.toDashboardTransaction({
      reference: row.reference,
      merchant_name: row.merchant,
      customer_email: row.customer,
      amount: row.amount,
      payment_method: row.channel,
      status: row.status,
      paid_at: row.timestamp
    }));
  }
  for (const row of result.transactions) byReference.set(row.reference, row);

  const payload = transactionStore.buildLedgerPayload([...byReference.values()]);

  return res.status(200).json({
    success: true,
    status: true,
    source: 'supabase',
    ...payload,
    data: payload.transactions
  });
});

// POST /api/transactions — write side of the shared ledger.
// Mirrors api/transactions.js (the Vercel serverless function) so local and
// deployed behavior are identical.
//
// Used by the storefront checkout to record Cash on
// Delivery / Manual MoMo orders (status PENDING_MOMO) and by the admin panel to reconcile them (PENDING_MOMO → PAID) and to advance
// fulfillment status (PAID → SHIPPED / CANCELLED). Upserts by `reference`.
// Rate-limited: the non-terminal path is public by design (storefront
// order creation), so it is the one write an anonymous caller can spam.
app.post('/api/transactions', rateLimit.limit('order-write', {
  max: 60, windowMs: 60 * 1000
}), async (req, res) => {
  const body = req.body || {};
  if (!body.reference) {
    return res.status(400).json({ success: false, error: 'Reference is required' });
  }

  // Terminal-status writes change what the dashboard counts as settled
  // money. Public storefronts may only ever create/amend NON-terminal
  // rows (PENDING, PENDING_MOMO); marking an order PAID/CANCELLED/etc.
  // requires the admin key. Otherwise anyone could inject fake SUCCESS
  // rows and inflate the merchant's books.
  const TERMINAL_STATUSES = ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'];
  const requestedStatus = String(body.status || 'PENDING').toUpperCase();
  if (TERMINAL_STATUSES.includes(requestedStatus) && !isAuthorizedAdmin(req)) {
    return res.status(401).json(unauthorizedPayload());
  }

  // Without Supabase (local dev / demo) persist to the in-memory ledger so the
  // storefront → admin order loop still works end-to-end.
  if (!isSupabaseConfigured()) {
    const row = ledger.upsertTransaction({
      reference: body.reference,
      merchant: body.merchant_name || body.merchant || 'Valmont-Pay',
      customer: body.customer_email || body.customer || body.email || 'unknown@customer',
      amount: body.amount,
      channel: body.payment_method || body.channel || 'Unknown',
      status: body.status || 'PENDING',
      timestamp: body.paid_at || new Date().toISOString()
    });
    return res.status(200).json({
      success: true,
      status: true,
      source: 'memory',
      reference: row.reference,
      data: row
    });
  }

  const result = await transactionStore.saveTransaction(body, { context: 'TRANSACTIONS' });

  if (!result.ok) {
    return res.status(500).json({
      success: false,
      error: 'Failed to save transaction',
      message: result.reason,
      reference: result.record.reference
    });
  }

  return res.status(200).json({
    success: true,
    reference: result.record.reference,
    data: result.data
  });
});

// API 5b: Deployment health check.
// Reports WHICH environment variables are configured (never their values), so a
// production deployment can be verified without guessing why the dashboard is
// empty. Required in Vercel Production: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (preferred over SUPABASE_ANON_KEY) and PAYSTACK_SECRET_KEY; WEBHOOK_SECRET is
// optional because Paystack signs webhooks with PAYSTACK_SECRET_KEY.
app.get('/api/health', (req, res) => {
  const supabase = supabaseConfigState();
  const paystackConfigured = Boolean(process.env.PAYSTACK_SECRET_KEY);
  const webhookSecretConfigured = Boolean(
    process.env.PAYSTACK_SECRET_KEY || process.env.WEBHOOK_SECRET
  );

  const missing = [];
  if (!supabase.urlConfigured) missing.push('SUPABASE_URL');
  if (!supabase.keyConfigured) missing.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)');
  if (!paystackConfigured) missing.push('PAYSTACK_SECRET_KEY');

  const warnings = [];
  if (supabase.urlConfigured && !supabase.serviceRoleKeyConfigured && supabase.anonKeyConfigured) {
    warnings.push(
      'Using SUPABASE_ANON_KEY. Set SUPABASE_SERVICE_ROLE_KEY so Row Level Security cannot reject writes.'
    );
  }
  if (!process.env.WEBHOOK_SECRET && paystackConfigured) {
    warnings.push('WEBHOOK_SECRET is unset — PAYSTACK_SECRET_KEY is used directly (recommended for Paystack).');
  }

  res.set('Cache-Control', 'no-store');
  res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    environment: process.env.VERCEL_ENV || (IS_SERVERLESS ? 'vercel' : 'local'),
    required: {
      SUPABASE_URL: supabase.urlConfigured,
      SUPABASE_SERVICE_ROLE_KEY: supabase.serviceRoleKeyConfigured,
      SUPABASE_ANON_KEY: supabase.anonKeyConfigured,
      PAYSTACK_SECRET_KEY: paystackConfigured
    },
    optional: { WEBHOOK_SECRET: Boolean(process.env.WEBHOOK_SECRET) },
    supabase: {
      configured: supabase.configured,
      credentialType: supabase.credentialType
    },
    webhook: { signingSecretConfigured: webhookSecretConfigured },
    missing,
    warnings
  });
});

// API 6: Paystack webhook — the source of truth for real payments.
// Point your Paystack dashboard webhook URL at https://<your-domain>/api/webhook
app.post('/api/webhook', async (req, res) => {
  const requestId = `wh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  const signature = req.headers['x-paystack-signature'];

  console.log('========================================');
  console.log(`[WEBHOOK ${requestId}] STEP 1/6 RECEIVED — POST ${req.originalUrl} at ${new Date().toISOString()}`);
  console.log(`[WEBHOOK ${requestId}] STEP 2/6 HEADERS —`, JSON.stringify(req.headers, null, 2));
  console.log(`[WEBHOOK ${requestId}] STEP 3/6 BODY — ${Buffer.byteLength(rawBody, 'utf8')} byte(s):`, rawBody || '(empty)');
  console.log(`[WEBHOOK ${requestId}] STEP 4/6 ENV —`, JSON.stringify({
    signingSecretConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY || process.env.WEBHOOK_SECRET),
    signingSecretSource: process.env.PAYSTACK_SECRET_KEY ? 'PAYSTACK_SECRET_KEY'
      : process.env.WEBHOOK_SECRET ? 'WEBHOOK_SECRET (legacy fallback)' : null,
    supabase: supabaseConfigState()
  }, null, 2));

  const logEntry = webhookLog.recordWebhookHit({
    endpoint: '/api/webhook',
    method: req.method,
    headers: req.headers,
    body: rawBody,
    event: req.body && req.body.event ? String(req.body.event) : null,
    reference: req.body && req.body.data && req.body.data.reference ? String(req.body.data.reference) : null,
    outcome: 'processing'
  });

  let result;
  try {
    result = handleWebhookEvent(req.body, signature, req.rawBody);
  } catch (error) {
    console.error(`[WEBHOOK ${requestId}] UNHANDLED — ✗ handler threw:`, error.message);
    console.error(`[WEBHOOK ${requestId}] UNHANDLED — stack trace:\n`, error.stack);
    webhookLog.completeWebhookHit(logEntry, { outcome: 'unhandled-error', statusCode: 500 });
    console.log('========================================');
    return res.status(500).json({ status: false, message: 'Internal webhook error', error: error.message });
  }

  const signatureAccepted = result.statusCode !== 401;
  console.log(`[WEBHOOK ${requestId}] STEP 5/6 SIGNATURE — ${signatureAccepted ? '✓ accepted' : '✗ REJECTED'}`, JSON.stringify({
    signaturePresent: Boolean(signature),
    signatureLength: signature ? String(signature).length : 0,
    handlerStatus: result.statusCode
  }, null, 2));

  if (!signatureAccepted) {
    console.error(`[WEBHOOK ${requestId}] STEP 5/6 SIGNATURE — ✗ signature mismatch. Check that PAYSTACK_SECRET_KEY belongs to the Paystack account/mode (test/live) that sent this event.`);
  }


  // CRITICAL FIX: also persist the webhook event to Supabase so the dashboard
  // can display it. Without this, webhook events only go to the in-memory
  // ledger, which is lost on server restart and is empty on Vercel cold starts.
  if (result.statusCode === 200 && result.body && result.body.transaction && isSupabaseConfigured()) {
    const client = getSupabaseClient();
    if (client) {
      const record = result.body.transaction;
      const persistence = await transactionStore.saveTransaction(
        {
          reference: record.reference,
          merchant: record.merchant,
          customer: record.customer,
          amount: record.amount,
          channel: record.channel,
          status: record.status,
          timestamp: record.timestamp
        },
        { client, context: 'WEBHOOK' }
      );
      console.log(`[WEBHOOK ${requestId}] STEP 6/6 SUPABASE — insert result: ${persistence.ok ? '✓ SAVED' : '✗ REJECTED'}`, JSON.stringify({
        ok: persistence.ok,
        reason: persistence.reason,
        returnedRow: persistence.data || null,
        error: persistence.error || null
      }, null, 2));

    }
  } else if (result.statusCode === 200) {
    console.log(`[WEBHOOK ${requestId}] STEP 6/6 SUPABASE — skipped (no transaction to save, or Supabase is not configured)`);
  }

  // ─── STANDING MANDATE SAVING ───
  if (result.statusCode === 200 && req.body && req.body.event === 'charge.success' && req.body.data) {
    try {
      await mandateStore.saveMandateFromAuthorization(req.body.data, { context: `WEBHOOK ${requestId}` });
    } catch (mandateErr) {
      console.warn(`[WEBHOOK ${requestId}] Non-fatal error saving standing mandate:`, mandateErr.message || mandateErr);
    }
  }

  // ─── MULTI-TENANT: Forward webhook to the tenant's registered URL ───
  // After attempting to persist to Supabase, also dispatch the event to the
  // appropriate tenant's webhook URL.
  if (result.statusCode === 200 && result.body && result.body.transaction) {
    const trxRecord = result.body.transaction;
    const data = req.body && req.body.data ? req.body.data : {};
    const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    const merchantIdentifier = metadata.tenant_key || metadata.merchant || trxRecord.tenant_key || trxRecord.merchant;
    const tenant = tenants.getTenantByIdentifier(merchantIdentifier);

    if (tenant && tenant.webhook_url) {
      const eventName = req.body && req.body.event ? String(req.body.event) : 'charge.success';
      const reference = trxRecord.reference;

      console.log(`[WEBHOOK ${requestId}] STEP 6b/6 TENANT-FWD — forwarding ${eventName} for ${reference} to ${tenant.key} @ ${tenant.webhook_url}`);

      webhookForwarder.dispatchWebhook(tenant, eventName, {
        reference,
        status: trxRecord.status || 'success',
        amount: Number(trxRecord.amount) || 0,
        currency: data.currency || tenant.currency || 'GHS',
        channel: trxRecord.channel || data.channel || 'Unknown',
        paid_at: trxRecord.timestamp || data.paid_at || new Date().toISOString(),
        merchant: tenant.key,
        gateway_reference: reference
      }, reference);
    } else if (tenant) {
      console.log(`[WEBHOOK ${requestId}] STEP 6b/6 TENANT-FWD — tenant ${tenant.key} has no webhook URL configured, skipping`);
    } else {
      console.log(`[WEBHOOK ${requestId}] STEP 6b/6 TENANT-FWD — could not resolve tenant from merchant metadata, skipping`);
    }
  }

  // ─── NOTIFY: instant SMS/WhatsApp receipt to customer + merchant ───────
  // The event is verified and the SUCCESS transaction is recorded. Dispatch
  // fire-and-forget: lib/notifier never throws, but even if it did, a broken
  // receipt must never change the HTTP 200 Paystack is waiting for.
  if (
    result.statusCode === 200 &&
    result.body && result.body.transaction &&
    String(result.body.transaction.status).toUpperCase() === 'SUCCESS'
  ) {
    console.log(`[WEBHOOK ${requestId}] NOTIFY — dispatching SMS/WhatsApp receipt for ${result.body.transaction.reference} (fire-and-forget)`);
    notifier.sendOrderReceiptNotification(result.body.transaction, req.body || {}).catch(err => {
      console.error(`[WEBHOOK ${requestId}] [WEBHOOK-NOTIFIER-ERROR]`, err && err.message ? err.message : err);
    });
  }

  console.log(`[WEBHOOK ${requestId}] RESPONSE — → HTTP ${result.statusCode} in ${Date.now() - startedAt}ms`, JSON.stringify(result.body, null, 2));
  webhookLog.completeWebhookHit(logEntry, {
    statusCode: result.statusCode,
    outcome: result.statusCode === 200 ? 'saved' : result.statusCode === 401 ? 'invalid-signature' : 'rejected',
    durationMs: Date.now() - startedAt
  });
  console.log('========================================');

  return res.status(result.statusCode).json(result.body);
});

// API 6a-i: /api/test-webhook — the dumbest possible POST receiver.
// No signature check, no database, no validation: it exists purely to prove
// that an HTTP POST from the outside world can reach this deployment.
app.all('/api/test-webhook', (req, res) => {
  const receivedAt = new Date().toISOString();

  console.log('========================================');
  console.log(`[TEST-WEBHOOK] ${req.method} request received at ${receivedAt}`);
  console.log('[TEST-WEBHOOK] URL:', req.originalUrl);
  console.log('[TEST-WEBHOOK] Headers:', JSON.stringify(req.headers, null, 2));

  if (req.method === 'GET') {
    console.log('[TEST-WEBHOOK] GET probe — endpoint is reachable');
    console.log('========================================');
    return res.status(200).json({
      success: true,
      message: 'Test webhook endpoint is alive. POST here to log a request body.',
      method: 'GET',
      receivedAt
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    console.log('[TEST-WEBHOOK] Rejected method:', req.method);
    console.log('========================================');
    return res.status(405).json({ success: false, error: 'Method not allowed', method: req.method });
  }

  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  console.log('[TEST-WEBHOOK] Body bytes:', Buffer.byteLength(rawBody, 'utf8'));
  console.log('[TEST-WEBHOOK] Raw body:', rawBody || '(empty)');
  console.log('[TEST-WEBHOOK] Parsed body:', JSON.stringify(req.body || null, null, 2));
  console.log('[TEST-WEBHOOK] x-paystack-signature present:', Boolean(req.headers['x-paystack-signature']));
  console.log('========================================');

  webhookLog.recordWebhookHit({
    endpoint: '/api/test-webhook',
    method: req.method,
    headers: req.headers,
    body: rawBody,
    event: req.body && req.body.event ? String(req.body.event) : null,
    reference: req.body && req.body.data && req.body.data.reference ? String(req.body.data.reference) : null,
    outcome: 'test-endpoint-ok',
    statusCode: 200
  });

  // ALWAYS 200 — this endpoint must never be the thing that fails.
  return res.status(200).json({
    success: true,
    received: true,
    message: 'Test webhook received. Check the server logs for the full dump.',
    receivedAt,
    method: req.method,
    signaturePresent: Boolean(req.headers['x-paystack-signature']),
    bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
    body: req.body ?? null,
    headers: req.headers
  });
});

// API 6a-ii: /api/webhook-status — JSON behind /webhook-status.html.
// Reports configuration, env-var STATUS (never values), the misconfiguration
// checklist, observed inbound requests, and recent Paystack transactions
// cross-referenced against our own table.
app.get('/api/webhook-status', async (req, res) => {
  try {
    const payload = await webhookDiagnostics.buildDiagnostics(req, {
      includePaystack: req.query.paystack !== '0'
    });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[WEBHOOK-STATUS] Failed to build diagnostics:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to build webhook diagnostics',
      message: error.message
    });
  }
});

// API 6b: Webhook diagnostic endpoint — GET/POST /api/webhook-debug
// Helps debug webhook delivery issues without needing Paystack dashboard access.
app.get('/api/webhook-debug', (req, res) => {
  const supabase = supabaseConfigState();
  const webhookSecret = process.env.PAYSTACK_SECRET_KEY || process.env.WEBHOOK_SECRET || '';
  const paystackKey = process.env.PAYSTACK_SECRET_KEY || '';

  const diagnostics = {
    success: true,
    timestamp: new Date().toISOString(),
    environment: {
      vercel: Boolean(process.env.VERCEL),
      vercelEnv: process.env.VERCEL_ENV || 'local',
      nodeVersion: process.version
    },
    supabase: {
      configured: supabase.configured,
      urlConfigured: supabase.urlConfigured,
      keyConfigured: supabase.keyConfigured,
      credentialType: supabase.credentialType
    },
    webhook: {
      webhookSecretConfigured: Boolean(webhookSecret),
      webhookSecretSource: process.env.PAYSTACK_SECRET_KEY
        ? 'PAYSTACK_SECRET_KEY'
        : process.env.WEBHOOK_SECRET ? 'WEBHOOK_SECRET (legacy fallback)' : null,
      paystackSecretKeyConfigured: Boolean(paystackKey),
      // Host-first: never recommend a webhook URL on a stale env-var domain.
      expectedWebhookUrl: `${baseUrl(req)}/api/webhook`
    },
    recommendations: []
  };

  if (!supabase.configured) {
    diagnostics.recommendations.push('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel env vars');
  }
  if (!webhookSecret) {
    diagnostics.recommendations.push('Set PAYSTACK_SECRET_KEY in Vercel env vars — Paystack signs webhooks with this key');
  }
  diagnostics.recommendations.push(
    'In Paystack Dashboard → Settings → Preferences → Webhooks, ensure your webhook URL is: ' +
    diagnostics.webhook.expectedWebhookUrl
  );
  diagnostics.recommendations.push(
    'POST to /api/webhook-debug with a test event to verify the pipeline end-to-end'
  );

  res.set('Cache-Control', 'no-store');
  return res.status(200).json(diagnostics);
});

app.post('/api/webhook-debug', requireAdmin, async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(500).json({ success: false, error: 'Supabase is not configured' });
  }

  const body = req.body || {};
  const eventName = body.event || 'charge.success';
  const data = body.data || {};

  const reference = data.reference || `VP-DEBUG-${Date.now().toString(36).toUpperCase()}`;
  const amount = (Number(data.amount) || 5000) / 100;
  const channel = data.channel || 'mobile_money';
  const email = data.email || 'test@example.com';
  const merchant = (data.metadata && data.metadata.merchant) || 'Debug Test Merchant';

  const transaction = {
    reference,
    merchant_name: merchant,
    customer_email: email,
    amount: Math.round(amount * 100) / 100,
    payment_method: channel === 'mobile_money' ? 'Mobile Money' : channel === 'card' ? 'Credit/Debit Card' : channel,
    status: eventName === 'charge.success' ? 'SUCCESS' : 'FAILED',
    paid_at: eventName === 'charge.success' ? new Date().toISOString() : null
  };

  const client = getSupabaseClient();
  if (!client) {
    return res.status(500).json({ success: false, error: 'Supabase client is not available' });
  }

  const result = await transactionStore.saveTransaction(transaction, {
    client,
    context: 'WEBHOOK-DEBUG'
  });

  if (!result.ok) {
    return res.status(500).json({
      success: false,
      error: 'Failed to save simulated transaction',
      message: result.reason
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Simulated webhook event processed successfully',
    reference,
    event: eventName,
    transaction: result.data || transaction
  });
});

// API 6c: Manual transaction endpoint — POST /api/manual-transaction
// Admin-guarded: this inserts arbitrary rows (including status SUCCESS)
// straight into the ledger. Left open, it lets ANY internet visitor
// inflate the dashboard "Total Collected" with fake settled money — a
// bookkeeping-integrity hole on a live-money system.
app.post('/api/manual-transaction', requireAdmin, async (req, res) => {
  if (!isSupabaseConfigured()) {
    return res.status(500).json({ success: false, error: 'Supabase is not configured' });
  }

  const body = req.body || {};
  const amount = parseFloat(body.amount);

  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({
      success: false,
      error: 'A valid amount (number >= 0) is required'
    });
  }

  const reference = body.reference || `VP-MANUAL-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const transaction = {
    reference,
    merchant_name: body.merchant_name || body.merchant || 'Valmont-Pay',
    customer_email: body.customer_email || body.customer || body.email || 'manual@entry',
    amount,
    payment_method: body.payment_method || body.channel || 'Manual Entry',
    status: (body.status || 'SUCCESS').toUpperCase(),
    paid_at: body.paid_at || (body.status !== 'FAILED' ? new Date().toISOString() : null)
  };

  const client = getSupabaseClient();
  if (!client) {
    return res.status(500).json({ success: false, error: 'Supabase client is not available' });
  }

  const result = await transactionStore.saveTransaction(transaction, {
    client,
    context: 'MANUAL'
  });

  if (!result.ok) {
    return res.status(500).json({
      success: false,
      error: 'Failed to save transaction',
      message: result.reason
    });
  }

  return res.status(200).json({
    success: true,
    reference: transaction.reference,
    data: result.data || transaction,
    message: 'Transaction saved to Supabase successfully'
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MULTI-TENANT PAYMENT GATEWAY API
// ═══════════════════════════════════════════════════════════════════════

// ─── Authentication middleware ──────────────────────────────────────────

/**
 * Extract and validate the Bearer token (tenant secret key) from the
 * Authorization header. On success, sets req.tenant to the resolved tenant.
 */
function requireTenantAuth(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ status: false, message: 'Missing or invalid Authorization header. Use: Bearer <secret_key>' });
  }

  const secretKey = match[1].trim();
  const tenant = tenants.getTenantBySecretKey(secretKey);
  if (!tenant) {
    return res.status(401).json({ status: false, message: 'Invalid secret key' });
  }

  req.tenant = tenant;
  next();
}

/**
 * Resolve a merchant param to a tenant. Used for public endpoints where
 * the merchant key comes from the request body or query string.
 * Returns 404 (not 403) for cross-tenant reference lookups per spec.
 */
function resolveTenant(req, res, next) {
  const merchantKey = req.body && req.body.merchant
    ? String(req.body.merchant).toLowerCase()
    : req.query && req.query.merchant
      ? String(req.query.merchant).toLowerCase()
      : null;

  if (!merchantKey) {
    return res.status(400).json({ status: false, message: 'merchant parameter is required' });
  }

  const tenant = tenants.getTenant(merchantKey);
  if (!tenant) {
    return res.status(404).json({ status: false, message: 'Merchant not found' });
  }

  req.tenant = tenant;
  next();
}

/** Legacy keys resolve for reads, but cannot create/configure a second tenant. */
function rejectLegacyTenantAliasWrite(key, res) {
  if (!tenants.isLegacyTenantKey(key)) return false;
  res.status(409).json({
    status: false,
    code: 'LEGACY_TENANT_ALIAS',
    message: `${key} is a read-only legacy alias. Use ${tenants.SERVICE_MERCHANT_KEY}.`
  });
  return true;
}

// ─── New: POST /api/transaction/initialize (security-critical) ─────────

/**
 * Server-side payment initialization. Authorised by tenant secret key.
 *
 * Replaces the old client-side amount-in-URL pattern with a one-time
 * access_code that resolves every detail server-side.
 *
 * Body: {amount, reference, currency, email, phone, callback_url}
 * Headers: Authorization: Bearer <secret_key>
 *
 * Validates callback_url against the tenant's allowed domains.
 * Returns {status, message, data: {access_code, reference, amount, ...}}
 */
app.post('/api/transaction/initialize', requireTenantAuth, async (req, res) => {
  const tenant = req.tenant;
  const { amount, reference, currency, email, phone, callback_url } = req.body;
  const subaccount = (req.body && req.body.subaccount) || (req.query && req.query.subaccount);

  // Validate required fields
  if (!email || !amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ status: false, message: 'A valid email and amount > 0 are required' });
  }

  // Validate callback_url against tenant's allowed domains
  if (callback_url) {
    const validation = tenants.validateCallbackUrl(tenant, callback_url);
    if (!validation.valid) {
      return res.status(400).json({
        status: false,
        message: `Invalid callback_url: ${validation.reason}`
      });
    }
  }

  // Use provided reference or generate one (must be unique per tenant)
  const finalReference = reference && String(reference).trim()
    ? String(reference).trim()
    : `${tenant.key.toUpperCase().replace(/-/g, '_')}-${Date.now().toString(36).toUpperCase()}-${Math.floor(10000 + Math.random() * 90000)}`;

  const finalCurrency = currency || tenant.currency || 'GHS';
  const finalCallbackUrl = callback_url || `${baseUrl(req)}/checkout.html`;

  // Initialize with Paystack using the tenant's own keys
  let paystackResult = null;
  let paystackError = null;

  if (tenant.paystack_secret_key) {
    try {
      // Credential selection is explicit. tenant.environment is display-only
      // and never gates test/live routing; the actual sk_test_/sk_live_ key does.
      paystackResult = await initializePaymentWithKey({
        amount: Number(amount),
        email,
        reference: finalReference,
        callback_url: `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(finalReference)}&merchant=${encodeURIComponent(tenant.key)}`,
        merchant: tenant.key,
        subaccount,
        currency: finalCurrency,
        secretKey: tenant.paystack_secret_key
      });
    } catch (error) {
      paystackError = error.message || String(error);
    }
  }

  if (paystackError) {
    // If Paystack is not fully configured, fall back to the local ledger
    console.log(`[TENANT-INIT] Paystack init failed for ${tenant.key}/${finalReference}: ${paystackError}`);
  }

  // Store the payment intent in the access code store (source of truth for amount)
  const accessCodeData = accessCodeStore.createAccessCode({
    amount: Number(amount),
    reference: finalReference,
    currency: finalCurrency,
    email,
    phone: phone || '',
    callback_url: finalCallbackUrl,
    tenant_key: tenant.key,
    merchant_display_name: tenant.display_name,
    merchant_brand_color: tenant.brand_color,
    merchant_logo_url: tenant.logo_url,
    paystack_authorization_url: paystackResult && paystackResult.data
      ? paystackResult.data.authorization_url || ''
      : '',
    paystack_access_code: paystackResult && paystackResult.data
      ? paystackResult.data.access_code || ''
      : ''
  });

  // Also record on the local ledger with tenant ownership
  ledger.addTransaction({
    reference: finalReference,
    customer: email,
    amount: Number(amount),
    channel: 'PENDING',
    status: 'PENDING',
    merchant: tenant.display_name,
    tenant_key: tenant.key,
    callback_url: finalCallbackUrl
  });

  console.log(`[TENANT-INIT] ${tenant.key}: Ref ${finalReference} | Amount ${finalCurrency} ${amount} | Email ${email}`);

  // Persist the checkout session so it survives cold starts. Same 30-minute
  // TTL as the in-memory store — the documented tenant contract (docs/
  // tenant-integration.md) is unchanged. Best-effort on purpose: a
  // persistence hiccup must not break tenant integrations — pay.html can
  // still complete via paystack_authorization_url — but the failure IS
  // logged loudly so a dropped link never looks like "the gateway ate it".
  paymentLinkStore.persistPaymentLink({
    accessCode: accessCodeData.access_code,
    payment: accessCodeData.payment,
    ttlMs: accessCodeStore.EXPIRY_MS
  }).then(result => {
    if (!result.ok) {
      console.error(`[TENANT-INIT] session persistence failed for ${tenant.key}/${finalReference}: ${result.reason}`);
    }
  }).catch(err => {
    console.error(`[TENANT-INIT] session persistence threw for ${tenant.key}/${finalReference}:`, err && err.message ? err.message : err);
  });

  // Return access_code — this is what pay.html reads
  res.status(200).json({
    status: true,
    message: 'Transaction initialized successfully',
    data: {
      access_code: accessCodeData.access_code,
      reference: finalReference,
      amount: Number(amount),
      currency: finalCurrency,
      merchant: tenant.key,
      merchant_display_name: tenant.display_name,
      merchant_brand_color: tenant.brand_color,
      merchant_logo_url: tenant.logo_url,
      paystack_authorization_url: paystackResult && paystackResult.data
        ? paystackResult.data.authorization_url
        : null,
      callback_url: finalCallbackUrl,
      checkout_url: `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(finalReference)}` +
        `&amount=${encodeURIComponent(Number(amount))}` +
        `&email=${encodeURIComponent(email)}` +
        `&merchant=${encodeURIComponent(tenant.key)}`,
      pay_url: `${baseUrl(req)}/pay.html?access_code=${encodeURIComponent(accessCodeData.access_code)}`
    }
  });
});

// ─── New: GET /api/transaction/verify/{reference} ──────────────────────

/**
 * Verify a transaction status. Authorised by tenant secret key.
 * Returns the same data shape as the webhook payload.
 * Tenant-scoped: a key from tenant A cannot see tenant B's transactions.
 */
app.get('/api/transaction/verify/:reference', requireTenantAuth, async (req, res) => {
  const tenant = req.tenant;
  const { reference } = req.params;

  if (!reference) {
    return res.status(400).json({ status: false, message: 'Reference is required' });
  }

  // Look up in the in-memory ledger first (fast path)
  let trx = ledger.findTransaction(reference);

  // Also try Supabase if available
  if (!trx && isSupabaseConfigured()) {
    try {
      const client = getSupabaseClient();
      if (client) {
        const { data, error } = await client
          .from('transactions')
          .select('*')
          .eq('reference', reference)
          .single();

        if (data && !error) {
          trx = transactionStore.toDashboardTransaction(data);
        }
      }
    } catch (_) {
      // Silently fall through
    }
  }

  // Try Paystack verify as a last resort
  if (!trx && tenant.paystack_secret_key) {
    try {
      // As with initialization, the configured credential — not the cosmetic
      // tenant.environment label — determines Paystack test/live mode.
      const paystackData = await verifyPaymentWithKey(reference, tenant.paystack_secret_key);

      if (paystackData && paystackData.status && paystackData.data) {
        const pd = paystackData.data;
        trx = {
          reference: pd.reference,
          customer: (pd.customer && pd.customer.email) || pd.email || 'unknown',
          amount: (Number(pd.amount) || 0) / 100,
          channel: pd.channel || 'Unknown',
          status: pd.status === 'success' ? 'SUCCESS' : pd.status === 'failed' ? 'FAILED' : (pd.status || 'PENDING').toUpperCase(),
          merchant: tenant.display_name,
          timestamp: pd.paid_at || pd.created_at || new Date().toISOString(),
          gateway_response: pd.gateway_response || '',
          paid_at: pd.paid_at || null,
          currency: pd.currency || tenant.currency
        };

        // Persist to ledger so future lookups are fast
        ledger.upsertTransaction(trx);
      }
    } catch (_) {
      // Silently fall through
    }
  }

  if (!trx) {
    return res.status(404).json({ status: false, message: 'Transaction reference not found.' });
  }

  // Enforce tenant scope: a tenant must only see its own transactions.
  // When tenant_key is stored on the transaction record, we check it. Old
  // valmontweb rows resolve to the canonical SKU tenant before comparison;
  // no historical ledger row is deleted or rewritten. If no key was stored,
  // resolve its merchant display name through the same alias-aware registry.
  const storedTransactionTenant = trx.tenant_key || null;
  const merchantTenant = !storedTransactionTenant && trx.merchant
    ? tenants.getTenantByIdentifier(trx.merchant)
    : null;
  const transactionTenant = storedTransactionTenant
    ? tenants.canonicalTenantKey(storedTransactionTenant)
    : (merchantTenant ? merchantTenant.key : null);
  if (transactionTenant && transactionTenant !== tenant.key) {
    return res.status(404).json({ status: false, message: 'Transaction reference not found.' });
  }

  // Build the response in the same shape as the webhook payload
  const status = String(trx.status || 'PENDING').toUpperCase();
  const isSuccess = ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(status);

  const response = {
    status: true,
    message: 'Transaction verified',
    data: {
      reference: trx.reference,
      status: isSuccess ? 'success' : status === 'FAILED' ? 'failed' : 'pending',
      amount: Number(trx.amount) || 0,
      currency: trx.currency || tenant.currency || 'GHS',
      channel: trx.channel || 'Unknown',
      paid_at: trx.paid_at || trx.timestamp || null,
      merchant: tenant.key,
      gateway_reference: trx.reference,
      customer: trx.customer || trx.customer_email || 'unknown'
    }
  };

  res.status(200).json(response);
});

// ─── New: GET /api/transaction/access/{access_code} ────────────────────

/**
 * Resolve an access_code to payment details. Used by pay.html to render
 * the payment form with server-side amounts (not user-editable).
 *
 * Looks in the in-memory hot cache first, then falls back to the durable
 * payment_links table — so a link keeps working on a cold serverless
 * instance or a different warm one than the instance that created it.
 */
// Rate-limited to make brute-forcing an access_code impractical.
app.get('/api/transaction/access/:access_code', rateLimit.limit('access-code', {
  max: 60, windowMs: 60 * 1000
}), async (req, res) => {
  const { access_code } = req.params;

  if (!access_code) {
    return res.status(400).json({ status: false, message: 'Access code is required' });
  }

  const resolved = await paymentLinkStore.resolvePaymentLink(access_code);
  const payment = resolved.payment;
  if (!payment) {
    return res.status(404).json({ status: false, message: 'Invalid or expired access code' });
  }

  // Get fresh tenant data (branding may have been updated). A durable link
  // created before the SKU migration can still carry tenant_key=valmontweb;
  // preserve its locked amount/reference but expose the one public identity.
  const storedTenantKey = payment.tenant_key;
  const merchantKey = tenants.canonicalTenantKey(storedTenantKey) || storedTenantKey;
  const isLegacyTenantAlias = tenants.isLegacyTenantKey(storedTenantKey);
  const tenant = tenants.getTenant(merchantKey);

  res.status(200).json({
    status: true,
    data: {
      access_code: access_code,
      amount: payment.amount,
      reference: payment.reference,
      currency: payment.currency,
      email: payment.email,
      phone: payment.phone,
      callback_url: payment.callback_url,
      merchant: merchantKey,
      // Branding captured at link-creation wins (that's what the operator
      // typed / the tenant API set); tenant config only fills in gaps. The
      // retired alias is the exception: old links now render the canonical
      // Valmont Web Services branding rather than revive a second identity.
      merchant_display_name: (isLegacyTenantAlias && tenant ? tenant.display_name : payment.merchant_display_name) || (tenant ? tenant.display_name : '') || 'Valmont-Pay',
      merchant_brand_color: (isLegacyTenantAlias && tenant ? tenant.brand_color : payment.merchant_brand_color) || (tenant ? tenant.brand_color : '#f68b1e'),
      merchant_logo_url: (isLegacyTenantAlias && tenant ? tenant.logo_url : payment.merchant_logo_url) || (tenant ? tenant.logo_url : '/logo.svg'),
      paystack_authorization_url: payment.paystack_authorization_url,
      paystack_access_code: payment.paystack_access_code
    }
  });
});

// ─── GET /api/config/pay — runtime posture for pay.html ────────────────
//
// pay.html asks this whether the retired legacy amount-in-URL flow has
// been re-opened on THIS deployment (ALLOW_LEGACY_AMOUNT_URL=1). The flag
// is server-side only and nothing in a request can set it. pay.html fails
// closed if this endpoint is unreachable, so the worst case is a rejected
// legacy link, never an accepted one.
app.get('/api/config/pay', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    status: true,
    data: {
      allow_legacy_amount_url: legacyLinkPolicy.legacyAmountUrlAllowed()
    }
  });
});

// ─── Valmont Web Services: mint a locked pay link from a SKU ───────────
//
// The agency site is anonymous — no secret key may ever ship in its
// browser bundle — but it still needs "Pay Stage 1" / "Pay in full"
// buttons. So it may only name a SKU. The price is looked up in
// lib/service-catalogue.js, server-side. An anonymous caller cannot pass
// an amount; if it sends one it is ignored (and logged).
//
//   GET  /api/v1/payment-link/catalogue   → the price list (public)
//   POST /api/v1/payment-link/sku         → { sku, email } → pay_url
//   POST /api/v1/payment-link             → admin-authed, same by SKU
//
// Every one of them returns pay.html?access_code=… — never an
// amount-in-URL link.

app.get('/api/v1/payment-link/catalogue', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    status: true,
    data: {
      merchant: serviceCatalogue.SERVICE_MERCHANT_NAME,
      merchant_key: serviceCatalogue.SERVICE_MERCHANT_KEY,
      currency: 'GHS',
      items: serviceCatalogue.listCatalogue()
    }
  });
});

/**
 * Mint a locked payment link for a catalogue SKU.
 *
 * Shared by the public (anonymous) endpoint and the admin one. The ONLY
 * price input is the SKU: `requestedAmount` exists purely so we can log
 * that a caller tried to name its own price, and is never charged.
 */
async function mintCatalogueLink({ req, sku, email, phone, callbackUrl, requestedAmount, issuedBy }) {
  const item = serviceCatalogue.lookupSku(sku);
  if (!item) {
    return {
      httpStatus: 400,
      body: {
        status: false,
        code: 'UNKNOWN_SKU',
        message: 'Unknown sku. Use one of the published service references.',
        data: { valid_skus: Object.keys(serviceCatalogue.CATALOGUE) }
      }
    };
  }

  if (requestedAmount !== undefined && requestedAmount !== null && String(requestedAmount).trim() !== '') {
    console.warn(
      `[SKU-LINK] Ignoring caller-supplied amount ${requestedAmount} for ${item.sku}; ` +
      `catalogue price is GHS ${item.amount}.`
    );
  }

  const customerEmail = String(email || '').trim();
  if (!customerEmail || !customerEmail.includes('@')) {
    return {
      httpStatus: 400,
      body: { status: false, code: 'EMAIL_REQUIRED', message: 'A valid customer email is required.' }
    };
  }

  const tenant = tenants.getTenant(item.merchant_key)
    || tenants.getTenantByIdentifier(item.merchant)
    || null;
  const reference = serviceCatalogue.buildReference(item.sku);
  const origin = baseUrl(req);
  const finalCallbackUrl = String(callbackUrl || '').trim();

  // A callback must belong to the tenant, exactly as on the tenant API.
  if (finalCallbackUrl && tenant) {
    const validation = tenants.validateCallbackUrl(tenant, finalCallbackUrl);
    if (!validation.valid) {
      return {
        httpStatus: 400,
        body: { status: false, code: 'CALLBACK_NOT_ALLOWED', message: `Invalid callback_url: ${validation.reason}` }
      };
    }
  }

  // Initialize with Paystack when the tenant has credentials, so pay.html
  // can open the inline checkout without a second round trip.
  let paystackResult = null;
  if (tenant && tenant.paystack_secret_key) {
    try {
      paystackResult = await initializePaymentWithKey({
        amount: item.amount,
        email: customerEmail,
        reference,
        callback_url: finalCallbackUrl
          || `${origin}/checkout.html?reference=${encodeURIComponent(reference)}&merchant=${encodeURIComponent(item.merchant_key)}`,
        merchant: item.merchant_key,
        subaccount: tenant.paystack_subaccount || undefined,
        currency: item.currency,
        secretKey: tenant.paystack_secret_key
      });
    } catch (error) {
      console.warn(`[SKU-LINK] Paystack init failed for ${reference}: ${error.message || error}`);
    }
  }

  // The access code is the lock: the amount now lives server-side only.
  const accessCodeData = accessCodeStore.createAccessCode({
    amount: item.amount,
    reference,
    currency: item.currency,
    email: customerEmail,
    phone: String(phone || '').trim(),
    callback_url: finalCallbackUrl,
    tenant_key: tenant ? tenant.key : item.merchant_key,
    merchant_display_name: (tenant && tenant.display_name) || item.merchant,
    merchant_brand_color: (tenant && tenant.brand_color) || '#f68b1e',
    merchant_logo_url: (tenant && tenant.logo_url) || '/logo.svg',
    paystack_authorization_url: paystackResult && paystackResult.data ? paystackResult.data.authorization_url || '' : '',
    paystack_access_code: paystackResult && paystackResult.data ? paystackResult.data.access_code || '' : ''
  });

  ledger.addTransaction({
    reference,
    customer: customerEmail,
    amount: item.amount,
    channel: 'PENDING',
    status: 'PENDING',
    merchant: (tenant && tenant.display_name) || item.merchant,
    tenant_key: tenant ? tenant.key : item.merchant_key,
    callback_url: finalCallbackUrl
  });

  // A link we hand to a client must outlive a cold start.
  const persistence = await paymentLinkStore.persistPaymentLink({
    accessCode: accessCodeData.access_code,
    payment: accessCodeData.payment,
    ttlMs: paymentLinkStore.linkTtlMs()
  });

  if (!persistence.ok) {
    console.error(`[SKU-LINK] ✗ ${reference} was NOT persisted — refusing to hand out a dead link:`, persistence.reason);
    return {
      httpStatus: 502,
      body: {
        status: false,
        code: 'LINK_NOT_DURABLE',
        message: 'The payment link could not be saved durably, so it was not generated. ' +
          'If this persists, apply scripts/supabase-payment-links-schema.sql to your Supabase project.',
        detail: persistence.reason
      }
    };
  }

  console.log(
    `[SKU-LINK] ${issuedBy}: ${item.sku} → ${reference} | ${item.currency} ${item.amount} | ${customerEmail}`
  );

  return {
    httpStatus: 200,
    body: {
      status: true,
      message: 'Payment link created',
      data: {
        sku: item.sku,
        label: item.label,
        plan: item.plan,
        stage: item.stage,
        reference,
        // Echoed for display only. The charge is driven by the stored
        // intent behind access_code, not by this number.
        amount: item.amount,
        currency: item.currency,
        merchant: item.merchant,
        merchant_key: item.merchant_key,
        access_code: accessCodeData.access_code,
        link_expires_at: persistence.expiresAt || null,
        link_durable: Boolean(persistence.durable),
        pay_url: `${origin}/pay.html?access_code=${encodeURIComponent(accessCodeData.access_code)}`,
        checkout_url: `${origin}/pay.html?access_code=${encodeURIComponent(accessCodeData.access_code)}`
      }
    }
  };
}

// Public, anonymous. Takes ONLY a sku (plus who to bill it to) — never an
// amount. This is what the Valmont Web Services storefront calls.
app.post('/api/v1/payment-link/sku', rateLimit.limit('sku-link', {
  max: 30, windowMs: 60 * 1000
}), async (req, res) => {
  const body = req.body || {};
  const result = await mintCatalogueLink({
    req,
    sku: body.sku || body.reference,
    email: body.email,
    phone: body.phone,
    callbackUrl: body.callback_url,
    requestedAmount: body.amount,
    issuedBy: 'public-sku'
  });
  res.set('Cache-Control', 'no-store');
  return res.status(result.httpStatus).json(result.body);
});

// Admin-authed equivalent, used by the dashboard's "Issue Stage 1 / full
// link" panel. Same catalogue, same lock — the operator picks a SKU, not
// a price.
app.post('/api/v1/payment-link', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const result = await mintCatalogueLink({
    req,
    sku: body.sku || body.reference,
    email: body.email,
    phone: body.phone,
    callbackUrl: body.callback_url,
    requestedAmount: body.amount,
    issuedBy: 'admin'
  });
  res.set('Cache-Control', 'no-store');
  return res.status(result.httpStatus).json(result.body);
});

// ─── POST /api/log/bad-amount — pay.html unit-mismatch audit endpoint ────
//
// Best-effort audit log. pay.html calls this via navigator.sendBeacon
// when the URL's `amount` parameter looks like pesewas (e.g. `amount=2300`
// for a GH₵23 cart) so we can see which client site is mis-configured.
// Always returns 200 — see api/log-bad-amount.js for the full contract.
app.all('/api/log/bad-amount', (req, res, next) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  return next();
});

app.post('/api/log/bad-amount', rateLimit.limit('bad-amount-log', {
  max: 20, windowMs: 60 * 1000
}), (req, res) => {
  try {
    const body = req.body || {};
    const rawAmount = typeof body.rawAmount === 'string' ? body.rawAmount.slice(0, 32) : null;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 64) : null;
    const suspectUnit = typeof body.suspectUnit === 'string' ? body.suspectUnit.slice(0, 16) : null;
    const merchant = typeof body.merchant === 'string' ? body.merchant.slice(0, 64) : null;
    const ref = typeof body.ref === 'string' ? body.ref.slice(0, 64) : null;
    const url = typeof body.url === 'string' ? body.url.slice(0, 512) : null;
    const userAgent = typeof body.userAgent === 'string' ? body.userAgent.slice(0, 256) : null;
    const path = typeof body.path === 'string' ? body.path.slice(0, 64) : null;

    if (reason === legacyLinkPolicy.LEGACY_UNSIGNED_REASON) {
      // A retired amount-in-URL link was opened. This is the migration
      // log: every line here is a storefront still pointing at the old
      // flow. See docs/tenant-integration.md § 3.
      console.warn(
        `[VALMONT-PAY][BAD-AMOUNT] unit=n/a reason=${reason} ` +
        `rawAmount=${rawAmount || 'none'} ` +
        `merchant=${merchant || 'unknown'} ref=${ref || 'none'} ` +
        `path=${path || 'unknown'} url=${url || 'unknown'} ` +
        `ua=${userAgent || 'unknown'}`
      );
    } else if (reason === 'looks-like-pesewas' && rawAmount) {
      console.warn(
        `[VALMONT-PAY][BAD-AMOUNT] unit=mismatch reason=${reason} ` +
        `rawAmount=${rawAmount} suspectUnit=${suspectUnit || 'pesewas'} ` +
        `merchant=${merchant || 'unknown'} ref=${ref || 'none'} ` +
        `path=${path || 'unknown'} url=${url || 'unknown'} ` +
        `ua=${userAgent || 'unknown'}`
      );
    }
  } catch (err) {
    console.warn('[VALMONT-PAY][BAD-AMOUNT] malformed body (ignored):', err && err.message ? err.message : err);
  }
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ success: true });
});

// ─── Update existing Paystack webhook to also forward to tenant ─────────

// We patch the existing webhook handler by wrapping the success path.
// The existing /api/webhook route processes Paystack events, and after
// a successful event we now also forward to the tenant's own webhook URL.

// ─── New: GET /api/tenants — list all tenants (sanitised) ──────────────

// PUBLIC, so checkout pages can render branding without a credential.
// Authenticated admins get the full operational record; anonymous callers
// get branding only — the settlement bank account, webhook URL, allowed
// domains and environment used to be world-readable here.
app.get('/api/tenants', (req, res) => {
  const full = tenants.listTenants();
  const authorized = isAuthorizedAdmin(req);
  res.status(200).json({
    status: true,
    data: authorized ? full : full.map(t => tenants.publicTenant(t))
  });
});

// ─── New: GET /api/tenants/{key} — get a single tenant ─────────────────

app.get('/api/tenants/:key', (req, res) => {
  const tenant = tenants.getTenant(req.params.key);
  if (!tenant) {
    return res.status(404).json({ status: false, message: 'Tenant not found' });
  }
  res.status(200).json({
    status: true,
    data: isAuthorizedAdmin(req) ? tenants.sanitiseTenant(tenant) : tenants.publicTenant(tenant)
  });
});

// ─── PUT /api/tenants/{key}/webhook — set webhook URL ─────────────────
// Updates in-memory AND persists to Supabase when available.
// Admin-guarded: a tenant's webhook URL controls where payment events
// (with amounts + customer references) are forwarded. Was previously open.
app.put('/api/tenants/:key/webhook', requireAdmin, async (req, res) => {
  if (rejectLegacyTenantAliasWrite(req.params.key, res)) return;
  const tenantKey = tenants.canonicalTenantKey(req.params.key);
  const { webhook_url } = req.body || {};
  if (!webhook_url) {
    return res.status(400).json({ status: false, message: 'webhook_url is required' });
  }

  try { new URL(webhook_url); }
  catch (_) {
    return res.status(400).json({ status: false, message: 'Invalid webhook URL format' });
  }

  const exists = tenants.getTenant(tenantKey);
  if (!exists) {
    return res.status(404).json({ status: false, message: 'Tenant not found' });
  }

  // Persist first, then rebuild the exact effective tenant used by every API
  // and by the forwarder. Never report success for a process-only change.
  const result = await tenantStore.updateTenant(tenantKey, { webhook_url });
  if (!result.ok) {
    return res.status(503).json({ status: false, message: result.reason });
  }

  const effective = tenants.applyDbTenant(tenantStore.rowToTenant(result.raw));
  res.status(200).json({
    status: true,
    message: 'Webhook URL updated',
    webhook_url: effective.webhook_url,
    data: tenants.sanitiseTenant(effective)
  });
});

// ─── New: POST /api/tenants/{key}/rotate-keys — rotate API secrets ─────
// CRITICAL: this endpoint returns freshly minted VALID tenant API secrets
// in its response. It was previously unauthenticated — a full credential-
// takeover primitive for any tenant. Admin-guarded now.

// ─── New: POST /api/tenants/{key}/rotate-keys — rotate API secrets ─────
// CRITICAL: this endpoint returns freshly minted VALID tenant API secrets
// in its response. It was previously unauthenticated — a full credential-
// takeover primitive for any tenant. Admin-guarded now.
//
// It also used to rotate the in-memory registry ONLY. On a serverless
// platform that rotation evaporated at the next cold start while the
// database still held the old key — an operator could "revoke" a leaked
// credential and have it silently come back to life. Rotation is now
// persisted first, exactly like POST /api/admin/tenants/{key}/rotate-keys,
// and fails loudly with 503 when there is no database to persist to.
app.post('/api/tenants/:key/rotate-keys', requireAdmin, async (req, res) => {
  if (rejectLegacyTenantAliasWrite(req.params.key, res)) return;
  const canonicalKey = tenants.canonicalTenantKey(req.params.key);

  if (!tenants.getTenant(canonicalKey)) {
    return res.status(404).json({ status: false, message: 'Tenant not found' });
  }

  const result = await tenantStore.rotateSecrets(canonicalKey);
  if (!result.ok) {
    return res.status(503).json({
      status: false,
      message: `Keys were NOT rotated: ${result.reason}`
    });
  }

  tenants.updateTenantInMemory(canonicalKey, {
    secret_keys: [result.secret_key_1, result.secret_key_2].filter(Boolean)
  });

  res.status(200).json({
    status: true,
    message: 'API keys rotated and saved. Both old (secret_2) and new (secret_1) are valid.',
    data: {
      secret_key_1: result.secret_key_1,
      secret_key_2: result.secret_key_2,
      note: 'Keep both keys valid during rotation. Switch your integration to secret_key_1, then rotate again to drop secret_key_2.'
    }
  });
});

// ─── Tenant admin CRUD (backed by Supabase) ─────────────────────────────
// POST /api/admin/tenants      — create a tenant
// GET  /api/admin/tenants      — list ALL tenants (including disabled)
// PUT  /api/admin/tenants/:key — update a tenant (display_name, webhook, etc.)
// DELETE /api/admin/tenants/:key — delete a tenant
// POST /api/admin/tenants/:key/disable  — soft-disable
// POST /api/admin/tenants/:key/enable   — re-enable
//
// These are admin-only endpoints. The admin HTML pages sit behind a
// login, but the API itself is now ACTUALLY guarded server-side: every
// /api/admin/* route requires the X-Admin-Key header to match
// ADMIN_PASSWORD (lib/admin-auth.js). Previously these were wide open —
// anyone could rotate tenant keys or create tenants without any credential.
// When ADMIN_PASSWORD is unset (local dev) the guard warns and passes.

const tenantStore = require('./lib/tenant-store');

if (!adminAuthEnforced()) {
  if (adminAuth.isMisconfigured()) {
    console.error(
      '[ADMIN-AUTH] FATAL POSTURE: ADMIN_PASSWORD is not set in a DEPLOYED environment. ' +
      'All admin endpoints will return 503 until it is configured.'
    );
  } else {
    console.warn('[ADMIN-AUTH] ADMIN_PASSWORD is not set — local dev posture, admin endpoints are open.');
  }
}

// Guard every /api/admin/* route EXCEPT the auth handshake itself, which
// must stay reachable to unauthenticated callers (it is how you become
// authenticated). login is separately rate-limited; session/logout leak
// nothing.
const ADMIN_AUTH_PUBLIC_PATHS = new Set(['/login', '/logout', '/session']);
app.use('/api/admin', (req, res, next) => {
  if (ADMIN_AUTH_PUBLIC_PATHS.has(req.path)) return next();
  return requireAdmin(req, res, next);
});

app.get('/api/admin/tenants', async (req, res) => {
  // First refresh from DB so the UI sees the latest. Report fallback state
  // explicitly; otherwise built-in defaults can be mistaken for database rows.
  await tenants.refreshFromDb();
  const database = tenants.getDbRefreshState();
  res.status(200).json({
    status: true,
    source: database.ok ? 'database+fallbacks' : 'defaults/env-fallback',
    database,
    data: tenants.listAllTenants()
  });
});

app.post('/api/admin/tenants', async (req, res) => {
  const body = req.body || {};
  const identity = tenants.validateTenantIdentityForCreate(body);
  if (!identity.valid) {
    return res.status(409).json({ status: false, code: 'CATALOGUE_MERCHANT_RESERVED', message: identity.reason });
  }
  const result = await tenantStore.createTenant(body);
  if (!result.ok) {
    return res.status(400).json({ status: false, message: result.reason });
  }
  // Sync through the same env > DB > default resolver the forwarder uses.
  const effective = tenants.applyDbTenant(result.raw ? tenantStore.rowToTenant(result.raw) : null);
  res.status(201).json({
    status: true,
    message: 'Tenant created',
    data: tenants.sanitiseTenant(effective),
    // Send secrets back ONCE so the admin can copy them — they're never shown again
    secrets: result.rawSecrets || null
  });
});

app.put('/api/admin/tenants/:key', async (req, res) => {
  const key = req.params.key;
  const body = req.body || {};
  const identity = tenants.validateTenantIdentityForUpdate(key, body);
  if (!identity.valid) {
    return res.status(409).json({ status: false, code: 'CATALOGUE_MERCHANT_RESERVED', message: identity.reason });
  }
  // Allow setting webhook_url via this endpoint too
  const result = await tenantStore.updateTenant(tenants.canonicalTenantKey(key), body);
  if (!result.ok) {
    return res.status(400).json({ status: false, message: result.reason });
  }
  const effective = tenants.applyDbTenant(tenantStore.rowToTenant(result.raw));
  res.status(200).json({
    status: true,
    message: 'Tenant updated',
    data: tenants.sanitiseTenant(effective)
  });
});

app.delete('/api/admin/tenants/:key', async (req, res) => {
  const key = req.params.key;
  const canonicalKey = tenants.canonicalTenantKey(key);
  // Protect the two current built-ins from accidental deletion. The retired
  // alias maps here too, so an old DB record is never deleted through it.
  if (['valmont-electricals', tenants.SERVICE_MERCHANT_KEY].includes(canonicalKey)) {
    return res.status(400).json({
      status: false,
      message: 'Built-in tenants cannot be deleted. Disable them instead.'
    });
  }
  const result = await tenantStore.deleteTenant(canonicalKey);
  if (!result.ok) {
    return res.status(400).json({ status: false, message: result.reason });
  }
  tenants.removeTenant(canonicalKey);
  res.status(200).json({ status: true, message: 'Tenant deleted' });
});

app.post('/api/admin/tenants/:key/disable', async (req, res) => {
  const key = req.params.key;
  if (rejectLegacyTenantAliasWrite(key, res)) return;
  const result = await tenantStore.updateTenant(tenants.canonicalTenantKey(key), { status: 'disabled' });
  if (!result.ok) return res.status(400).json({ status: false, message: result.reason });
  const effective = tenants.applyDbTenant(tenantStore.rowToTenant(result.raw));
  res.status(200).json({
    status: true,
    message: 'Tenant disabled',
    data: tenants.sanitiseTenant(effective)
  });
});

app.post('/api/admin/tenants/:key/enable', async (req, res) => {
  const key = req.params.key;
  if (rejectLegacyTenantAliasWrite(key, res)) return;
  const result = await tenantStore.updateTenant(tenants.canonicalTenantKey(key), { status: 'active' });
  if (!result.ok) return res.status(400).json({ status: false, message: result.reason });
  const effective = tenants.applyDbTenant(tenantStore.rowToTenant(result.raw));
  res.status(200).json({
    status: true,
    message: 'Tenant enabled',
    data: tenants.sanitiseTenant(effective)
  });
});

app.post('/api/admin/tenants/:key/rotate-keys', async (req, res) => {
  const key = req.params.key;
  if (rejectLegacyTenantAliasWrite(key, res)) return;
  const canonicalKey = tenants.canonicalTenantKey(key);
  const result = await tenantStore.rotateSecrets(canonicalKey);
  if (!result.ok) return res.status(400).json({ status: false, message: result.reason });
  tenants.updateTenantInMemory(canonicalKey, {
    secret_keys: [result.secret_key_1, result.secret_key_2].filter(Boolean)
  });
  res.status(200).json({
    status: true,
    message: 'Keys rotated',
    data: {
      secret_key_1: result.secret_key_1,
      secret_key_2: result.secret_key_2,
      webhook_signing_secret: result.webhook_signing_secret
    }
  });
});

// ─── New: GET /api/webhook-deliveries — inspect delivery attempts ──────

// Guarded: delivery records contain tenant webhook URLs and payment
// event payloads (references, amounts, customer data).
app.get('/api/webhook-deliveries', requireAdmin, (req, res) => {
  const { reference, tenant_key } = req.query;
  const filters = {};
  if (reference) filters.reference = reference;
  if (tenant_key) filters.tenant_key = tenants.canonicalTenantKey(tenant_key) || tenant_key;

  const log = webhookForwarder.getDeliveryLog(filters);
  res.status(200).json({ status: true, count: log.length, data: log });
});

// ─── New: POST /api/webhook-deliveries/{reference}/replay ──────────────
// Admin-guarded: re-POSTs a payment event to a tenant's webhook URL;
// left open it is a spoofed-event cannon aimed at tenant backends.

app.post('/api/webhook-deliveries/:reference/replay', requireAdmin, (req, res) => {
  const { reference } = req.params;
  const { tenant_key } = req.body;

  if (!tenant_key) {
    return res.status(400).json({ status: false, message: 'tenant_key is required' });
  }

  const tenant = tenants.getTenant(tenant_key);
  if (!tenant) {
    return res.status(404).json({ status: false, message: 'Tenant not found' });
  }

  // Build a payload from the ledger
  const trx = ledger.findTransaction(reference);
  if (!trx) {
    return res.status(404).json({ status: false, message: 'Transaction not found' });
  }

  const status = String(trx.status || 'PENDING').toUpperCase();
  const isSuccess = ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(status);

  const originalPayload = {
    event: isSuccess ? 'charge.success' : 'charge.failed',
    data: {
      reference: trx.reference,
      status: isSuccess ? 'success' : 'failed',
      amount: Number(trx.amount) || 0,
      currency: tenant.currency || 'GHS',
      channel: trx.channel || 'Unknown',
      paid_at: trx.timestamp || new Date().toISOString(),
      merchant: tenant.key,
      gateway_reference: trx.reference
    }
  };

  webhookForwarder.replayWebhook(tenant, reference, originalPayload);

  res.status(200).json({
    status: true,
    message: 'Webhook replay initiated',
    reference,
    tenant_key: tenant.key
  });
});

// ─── New: GET /api/transaction/return — return redirect endpoint ───────

/**
 * The return redirect after a Paystack checkout.
 * Appends ?ref=&status=success|failed|cancelled to the validated callback_url.
 * This is cosmetic only — the webhook is the source of truth.
 */
app.get('/api/transaction/return', (req, res) => {
  const { reference, status, merchant, callback_url } = req.query;

  if (!callback_url) {
    return res.status(400).json({ status: false, message: 'callback_url parameter is required' });
  }

  // Validate the callback_url against the tenant's allowed domains
  if (merchant) {
    const tenant = tenants.getTenant(String(merchant).toLowerCase());
    if (tenant) {
      const validation = tenants.validateCallbackUrl(tenant, callback_url);
      if (!validation.valid) {
        return res.status(400).json({ status: false, message: `Invalid callback_url: ${validation.reason}` });
      }
    }
  }

  try {
    const redirectUrl = new URL(callback_url);
    if (reference) redirectUrl.searchParams.set('ref', reference);

    const normalizedStatus = String(status || '').toLowerCase();
    if (['success', 'failed', 'cancelled'].includes(normalizedStatus)) {
      redirectUrl.searchParams.set('status', normalizedStatus);
    } else {
      redirectUrl.searchParams.set('status', 'success');
    }

    return res.redirect(302, redirectUrl.toString());
  } catch (_) {
    return res.status(400).json({ status: false, message: 'Invalid callback_url' });
  }
});

// ─── New: POST /api/transaction/paystack-webhook — Patched webhook ─────
// This patches the existing /api/webhook route to also forward events
// to the tenant's webhook URL. We monkey-patch after the existing route.

// ─── Serve frontend web routes ──────────────────────────────────────────
// The public landing page lives at index.html. It is a product page, not
// the admin login — a logged-out visitor to valmontpay.app/ sees what
// Valmont Pay is and how to get a merchant account. The dashboard and
// admin login stay at their own URLs.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// SEO / crawler files — served explicitly so they work on both the
// Express dev server and Vercel serverless (where express.static may
// not resolve __dirname the same way).
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'robots.txt'));
});
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'sitemap.xml'));
});

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'checkout.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'pay.html'));
});
// ─── Admin authentication ────────────────────────────────────────────────
//
// REMOVED: `GET /config/admin.js`. It served ADMIN_EMAIL and ADMIN_PASSWORD,
// in cleartext, to any unauthenticated caller — and since ADMIN_PASSWORD is
// also the X-Admin-Key shared secret, one anonymous GET defeated every admin
// guard in this file. `CORS: *` meant any website could read it from a
// visitor's browser. Credentials are now verified ONLY here, server-side.
//
// The password never reaches the browser. A successful login returns an
// opaque, random, expiring token in an httpOnly + SameSite=Strict cookie
// that JavaScript cannot read (so XSS cannot exfiltrate the session, and
// cross-site requests cannot ride it).
app.post(
  '/api/admin/login',
  rateLimit.limit('admin-login', {
    max: 5,
    windowMs: 15 * 60 * 1000,
    message: 'Too many login attempts. Wait 15 minutes and try again.'
  }),
  (req, res) => {
    const { email, password } = req.body || {};

    if (!process.env.ADMIN_PASSWORD) {
      return res.status(503).json({
        status: false,
        message: 'Admin login is not configured on this deployment (ADMIN_PASSWORD is unset).'
      });
    }

    if (!adminSession.verifyCredentials(email, password)) {
      // Deliberately identical response for a bad email and a bad password,
      // so the endpoint cannot be used to enumerate the admin address.
      console.warn(`[ADMIN-AUTH] Failed login attempt from ${rateLimit.clientKey(req)}`);
      return res.status(401).json({ status: false, message: 'Invalid email or password.' });
    }

    const { token, expiresAt } = adminSession.createSession(email);
    res.setHeader('Set-Cookie', adminSession.buildSessionCookie(token));
    res.set('Cache-Control', 'no-store');
    console.log(`[ADMIN-AUTH] Admin session established for ${adminSession.adminEmail()}`);
    return res.status(200).json({ status: true, message: 'Signed in.', expires_at: expiresAt });
  }
);

app.post('/api/admin/logout', (req, res) => {
  adminSession.destroySession(adminSession.sessionTokenFromRequest(req));
  res.setHeader('Set-Cookie', adminSession.buildClearCookie());
  return res.status(200).json({ status: true, message: 'Signed out.' });
});

// Lets the admin pages check "am I still logged in?" without shipping any
// secret. Returns only a boolean.
app.get('/api/admin/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    status: true,
    authenticated: adminSession.hasValidSession(req),
    login_configured: Boolean(process.env.ADMIN_PASSWORD)
  });
});

// The old endpoint is kept ONLY to return an explicit, loud error: a stale
// cached page requesting it must fail visibly rather than silently appear
// to work with an empty password.
app.get('/config/admin.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(410).type('application/javascript').send(
    '/* Removed for security: this endpoint used to publish ADMIN_PASSWORD to ' +
    'anyone. Admin login is now server-side via POST /api/admin/login. */\n' +
    'window.ADMIN_CONFIG = undefined;\n'
  );
});

app.get('/admin-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-login.html'));
});

app.get('/admin-login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-login.html'));
});

app.get('/pay.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'pay.html'));
});

// Multi-tenant admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Tenants admin page (also reachable as /tenants without .html)
app.get('/tenants', (req, res) => {
  res.sendFile(path.join(__dirname, 'tenants.html'));
});
app.get('/tenants.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'tenants.html'));
});

// Webhook diagnostic page (also reachable as /webhook-status.html via static).
app.get('/webhook-status', (req, res) => {
  res.sendFile(path.join(__dirname, 'webhook-status.html'));
});

// Start the Payment Gateway server
(async function boot() {
  // Pull admin-created tenants from Supabase into memory before accepting
  // traffic, so webhook forwarding and checkout work on first request.
  await tenants.refreshFromDb();

  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 VALMONT-PAY CORE GATEWAY STARTED LIVE!`);
    console.log(`🔗 API Base URL: http://localhost:${PORT}`);
    console.log(`📈 Merchant Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`🧑‍💼 Tenants Admin:    http://localhost:${PORT}/tenants.html`);
    console.log(`======================================================\n`);
  });
})();
