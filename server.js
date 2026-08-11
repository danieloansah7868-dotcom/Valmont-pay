const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
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
const accessCodeStore = require('./lib/access-code-store');
const webhookForwarder = require('./lib/tenant-webhook-forwarder');
const notifier = require('./lib/notifier');
const paymentLinkStore = require('./lib/payment-link-store');
const { publicBaseUrl } = require('./lib/base-url');
const { requireAdmin, isAuthorizedAdmin, unauthorizedPayload, adminAuthEnforced } = require('./lib/admin-auth');

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

// Enable Cross-Origin Resource Sharing & JSON Parsing
app.use(cors());
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
app.post('/api/v1/transaction/initialize', async (req, res) => {
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

// API 3b: Paystack-backed endpoints (same contract as the /api serverless
// functions, so local development and Vercel behave identically).
app.post('/api/initialize-payment', async (req, res) => {
  const { email, merchant, phone, callback_url } = req.body || {};
  const amount = parseFloat(req.body && req.body.amount);
  const reference = (req.body && req.body.reference) || generateReference();
  // Paystack subaccount (body or query) — enables split settlement (e.g. ACCT_... for automatic 98%/2% splits).
  const subaccount = (req.body && req.body.subaccount) || (req.query && req.query.subaccount);

  if (!email || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
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
      callback_url:
        callback_url ||
        `${baseUrl(req)}/pay.html?reference=${encodeURIComponent(reference)}` +
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
  const { reference } = req.query;
  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing transaction reference' });
  }

  console.log('Reference:', reference);

  try {
    const data = await verifyPayment(reference);

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
app.get('/api/transactions', async (req, res) => {
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

// POST /api/transactions — admin-only ledger write.
// Mirrors api/transactions.js (the Vercel serverless function) so local and
// deployed behavior are identical.
//
// PURE GATEWAY: only admins may write arbitrary transaction rows.
// All customer-facing payment creation must go through the authenticated
// initialize endpoints (POST /api/transaction/initialize, POST /api/v1/transaction/initialize)
// or the Paystack webhook. Upserts by `reference`.
app.post('/api/transactions', async (req, res) => {
  const body = req.body || {};
  if (!body.reference) {
    return res.status(400).json({ success: false, error: 'Reference is required' });
  }

  // PURE GATEWAY: every write is admin-only. Gateway transactions
  // originate only from Paystack webhook or tenant-auth initialize.
  // Public PENDING / PENDING order injection is blocked.
  if (!isAuthorizedAdmin(req)) {
    return res.status(401).json(unauthorizedPayload());
  }

  // Without Supabase (local dev) persist to the in-memory ledger for gateway-local testing.
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
  const finalCallbackUrl = callback_url || '';

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
        callback_url: finalCallbackUrl || `${baseUrl(req)}/pay.html?reference=${encodeURIComponent(finalReference)}&merchant=${encodeURIComponent(tenant.key)}`,
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
      checkout_url: `${baseUrl(req)}/pay.html?access_code=${encodeURIComponent(accessCodeData.access_code)}`,
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
  // When tenant_key is stored on the transaction record, we check it.
  // If not stored (older records), we fall back to checking the merchant name.
  const transactionTenant = trx.tenant_key || (
    trx.merchant ? String(trx.merchant).toLowerCase().replace(/\s+/g, '-') : null
  );
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
app.get('/api/transaction/access/:access_code', async (req, res) => {
  const { access_code } = req.params;

  if (!access_code) {
    return res.status(400).json({ status: false, message: 'Access code is required' });
  }

  const resolved = await paymentLinkStore.resolvePaymentLink(access_code);
  const payment = resolved.payment;
  if (!payment) {
    return res.status(404).json({ status: false, message: 'Invalid or expired access code' });
  }

  // Get fresh tenant data (branding may have been updated)
  const tenant = tenants.getTenant(payment.tenant_key);

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
      merchant: payment.tenant_key,
      // Branding captured at link-creation wins (that's what the operator
      // typed / the tenant API set); tenant config only fills in gaps.
      merchant_display_name: payment.merchant_display_name || (tenant ? tenant.display_name : '') || 'Valmont-Pay',
      merchant_brand_color: payment.merchant_brand_color || (tenant ? tenant.brand_color : '#f68b1e'),
      merchant_logo_url: payment.merchant_logo_url || (tenant ? tenant.logo_url : '/logo.svg'),
      paystack_authorization_url: payment.paystack_authorization_url,
      paystack_access_code: payment.paystack_access_code
    }
  });
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

app.post('/api/log/bad-amount', (req, res) => {
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

    if (reason === 'looks-like-pesewas' && rawAmount) {
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

app.get('/api/tenants', (req, res) => {
  res.status(200).json({
    status: true,
    data: tenants.listTenants()
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
    data: tenants.sanitiseTenant(tenant)
  });
});

// ─── PUT /api/tenants/{key}/webhook — set webhook URL ─────────────────
// Updates in-memory AND persists to Supabase when available.
// Admin-guarded: a tenant's webhook URL controls where payment events
// (with amounts + customer references) are forwarded. Was previously open.
app.put('/api/tenants/:key/webhook', requireAdmin, async (req, res) => {
  const { webhook_url } = req.body || {};
  if (!webhook_url) {
    return res.status(400).json({ status: false, message: 'webhook_url is required' });
  }

  try { new URL(webhook_url); }
  catch (_) {
    return res.status(400).json({ status: false, message: 'Invalid webhook URL format' });
  }

  const exists = tenants.getTenant(req.params.key);
  if (!exists) {
    return res.status(404).json({ status: false, message: 'Tenant not found' });
  }

  // Persist first, then rebuild the exact effective tenant used by every API
  // and by the forwarder. Never report success for a process-only change.
  const result = await tenantStore.updateTenant(req.params.key, { webhook_url });
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

app.post('/api/tenants/:key/rotate-keys', requireAdmin, (req, res) => {
  const result = tenants.rotateTenantSecrets(req.params.key);
  if (!result) {
    return res.status(404).json({ status: false, message: 'Tenant not found' });
  }

  res.status(200).json({
    status: true,
    message: 'API keys rotated. Both old (secret_1) and new (secret_2) are valid.',
    data: {
      secret_key_1: result.secret_1,
      secret_key_2: result.secret_2,
      note: 'Keep both keys valid during rotation. Switch your integration to secret_key_2, then revoke secret_key_1.'
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
  console.warn('[ADMIN-AUTH] ADMIN_PASSWORD is not set — admin API endpoints are OPEN. Set it before deploying.');
}
app.use('/api/admin', requireAdmin);

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
  // Allow setting webhook_url via this endpoint too
  const result = await tenantStore.updateTenant(key, body);
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
  // Protect the two seed tenants from accidental deletion; admin can still
  // disable them via the toggle.
  if (['valmont-electricals', 'valmontweb'].includes(key.toLowerCase())) {
    return res.status(400).json({
      status: false,
      message: 'Built-in tenants cannot be deleted. Disable them instead.'
    });
  }
  const result = await tenantStore.deleteTenant(key);
  if (!result.ok) {
    return res.status(400).json({ status: false, message: result.reason });
  }
  tenants.removeTenant(key);
  res.status(200).json({ status: true, message: 'Tenant deleted' });
});

app.post('/api/admin/tenants/:key/disable', async (req, res) => {
  const key = req.params.key;
  const result = await tenantStore.updateTenant(key, { status: 'disabled' });
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
  const result = await tenantStore.updateTenant(key, { status: 'active' });
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
  const result = await tenantStore.rotateSecrets(key);
  if (!result.ok) return res.status(400).json({ status: false, message: result.reason });
  tenants.updateTenantInMemory(key, {
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

app.get('/api/webhook-deliveries', (req, res) => {
  const { reference, tenant_key } = req.query;
  const filters = {};
  if (reference) filters.reference = reference;
  if (tenant_key) filters.tenant_key = tenant_key;

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
    tenant_key
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
app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
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
// Runtime config for admin-login.html: credentials come from the ADMIN_EMAIL and
// ADMIN_PASSWORD environment variables so no secrets live in the source tree.
app.get('/config/admin.js', (req, res) => {
  const config = {
    email: process.env.ADMIN_EMAIL || 'support@valmontpay.com',
    password: process.env.ADMIN_PASSWORD || ''
  };
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`window.ADMIN_CONFIG = ${JSON.stringify(config)};`);
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
