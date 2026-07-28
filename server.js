const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { initializePayment, verifyPayment, generateReference } = require('./lib/paystack');
const ledger = require('./lib/ledger');
const { handleWebhookEvent, toLedgerRecord } = require('./lib/webhook');
const { isSupabaseConfigured, supabaseConfigState, getSupabaseClient } = require('./lib/supabase');
const transactionStore = require('./lib/transaction-store');
const webhookLog = require('./lib/webhook-log');
const webhookDiagnostics = require('./lib/webhook-diagnostics');
const merchantApi = require('./lib/merchant-api');
const merchants = require('./lib/merchants');
const paymentsStore = require('./lib/payments');
const webhookDelivery = require('./lib/webhook-delivery');
const gateway = require('./lib/gateway');

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
// production domain, so links work locally AND on Vercel.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
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

// ---------------------------------------------------------------------------
// Valmont-Pay merchant API (v1)
//
//   POST /api/transaction/initialize        secret key  -> one-time access_code
//   GET  /api/transaction/verify/:reference secret key  -> canonical data shape
//   POST /api/checkout/resolve|complete     used by pay.html
//   /api/merchant/*                         dashboard (keys, webhook, deliveries)
//
// Mounted BEFORE the legacy /api/v1/* routes so the new contract wins, and
// after the static handlers so nothing shadows the checkout pages.
// ---------------------------------------------------------------------------
app.use((req, _res, next) => {
  // The router needs an absolute origin to build authorization_url.
  req.baseOrigin = baseUrl(req);
  next();
});
app.use('/api', merchantApi.router);

// Boot the merchant record (creating keys on first run) and start the webhook
// retry loop. On a serverless platform the loop only lives as long as the
// instance, which is why /api/webhooks/drain exists below.
merchants.getDefaultMerchant();
if (!IS_SERVERLESS) webhookDelivery.startScheduler();

/**
 * Drain due webhook retries on demand.
 *
 * A serverless deployment has no long-lived timer, so point a cron job (Vercel
 * Cron, GitHub Actions, cron-job.org — anything) at this endpoint every minute
 * and the ~24h retry schedule works exactly as documented. Protected by the
 * merchant secret key so it cannot be used to hammer merchant endpoints.
 */
app.post('/api/webhooks/drain', merchantApi.requireSecretKey, async (_req, res) => {
  const processed = await webhookDelivery.processDue();
  return res.status(200).json({ status: true, processed });
});

// LIVE TRANSACTION LEDGER (shared in-memory store, see lib/ledger.js)
// It starts EMPTY — no seeded demo rows, no fake starting balance. The
// settled balance is always derived by summing SUCCESSFUL transactions.
const TRANSACTIONS = ledger.TRANSACTIONS;

// API 1: Initialize Transaction
app.post('/api/v1/transaction/initialize', (req, res) => {
  const { email, amount, callback_url, merchant } = req.body;
  
  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ status: false, message: 'Invalid transaction details.' });
  }

  const reference = generateReference();
  const origin = baseUrl(req);
  const newTransaction = ledger.addTransaction({
    reference,
    customer: email,
    amount: parseFloat(amount),
    channel: 'PENDING',
    status: 'PENDING',
    merchant: merchant || 'Valmont-Pay',
    callback_url: callback_url || `${origin}/checkout.html`
  });
  console.log(`[LEDGER] Transaction Initialized: Ref ${reference} | Merchant ${newTransaction.merchant} | Amount GHS ${newTransaction.amount}`);

  // Return a secure checkout URL hosted on this gateway server.
  // The reference, real amount, email and merchant are all carried through.
  res.status(200).json({
    status: true,
    message: 'Transaction initialized successfully',
    data: {
      reference,
      amount: newTransaction.amount,
      merchant: newTransaction.merchant,
      callback_url: newTransaction.callback_url,
      checkout_url: `${origin}/checkout.html?reference=${encodeURIComponent(reference)}` +
        `&amount=${encodeURIComponent(newTransaction.amount)}` +
        `&email=${encodeURIComponent(email)}` +
        `&merchant=${encodeURIComponent(newTransaction.merchant)}`
    }
  });
});

// API 2: Process Charge (Simulates MoMo USSD Prompt or Card Tokenization)
app.post('/api/v1/transaction/charge', (req, res) => {
  const { reference, channel, wallet_number, card_number, amount } = req.body;

  let trx = TRANSACTIONS.find(t => t.reference === reference);

  // Issue 3 fix: a checkout opened directly by reference (e.g. after a Paystack
  // redirect) used to 404 here and surface as "Transaction Failed". Register the
  // transaction on the fly instead of rejecting it.
  if (!trx && reference) {
    trx = ledger.addTransaction({
      reference,
      customer: req.body.email || 'unknown@customer',
      amount: parseFloat(amount) || 0,
      channel: 'PENDING',
      status: 'PENDING',
      merchant: req.body.merchant || 'Valmont-Pay'
    });
  }

  if (!trx) {
    return res.status(404).json({ status: false, message: 'Transaction reference not found.' });
  }

  if (trx.status !== 'PENDING') {
    return res.status(400).json({ status: false, message: 'Transaction has already been processed.' });
  }

  // Keep the ledger amount in sync with what the customer actually confirmed
  const confirmedAmount = parseFloat(amount);
  if (!isNaN(confirmedAmount) && confirmedAmount > 0) {
    trx.amount = confirmedAmount;
  }

  trx.channel = channel || 'Unknown';

  const isCard = /card/i.test(trx.channel);
  const digits = String(isCard ? card_number || '' : wallet_number || '').replace(/\D/g, '');

  // Issue 3 fix: outcomes are now deterministic instead of a random 15% decline,
  // so a valid test card / test wallet always clears.
  let declineReason = null;
  if (isCard) {
    if (digits.length < 12) declineReason = 'Invalid card number. Please check and try again.';
    // Paystack's documented "declined" test card
    else if (digits === '4084080000000409') declineReason = 'Card declined by issuer.';
  } else if (digits.length < 9) {
    declineReason = 'Invalid mobile money number. Please check and try again.';
  }

  /**
   * Persist the checkout transaction to Supabase through the SHARED helper, so
   * this route writes exactly the same columns as POST /api/transactions.
   *
   * This route is the dashboard's own checkout and it does NOT go through
   * Paystack, so no webhook ever fires for it — this write is the only thing
   * that puts the payment in front of the merchant.
   */
  async function persistToSupabase(transactionData) {
    const result = await transactionStore.saveTransaction(
      {
        reference: transactionData.reference,
        merchant: transactionData.merchant,
        customer: transactionData.customer,
        amount: transactionData.amount,
        channel: transactionData.channel,
        status: transactionData.status,
        timestamp: transactionData.timestamp
      },
      { context: 'CHECKOUT' }
    );

    if (!result.ok) {
      console.error(
        `[CHECKOUT] Transaction ${transactionData.reference} was NOT persisted:`,
        result.reason,
        { supabase: supabaseConfigState() }
      );
    }

    return result;
  }

  setTimeout(async () => {
    if (!declineReason) {
      trx.status = 'SUCCESS';
      // The balance is derived from the ledger (sum of SUCCESS rows), so
      // flipping the status above is all it takes to settle the funds.
      console.log(`[SETTLEMENT] Trans Ref ${reference} CLEARED for GHS ${trx.amount}! New balance GHS ${ledger.getBalance()}.`);

      // Persist to Supabase so the dashboard can see the payment.
      const persistence = await persistToSupabase(trx);

      // On Vercel the in-memory ledger dies with the request, so a failed write
      // means the money would silently vanish from the dashboard. Fail loudly
      // instead of telling the customer the charge cleared.
      if (!persistence.ok && IS_SERVERLESS) {
        return res.status(500).json({
          status: false,
          message:
            'Payment could not be recorded. Please contact support before retrying.',
          reference,
          amount: trx.amount,
          trx_status: 'FAILED',
          error: 'Failed to persist transaction',
          detail: persistence.reason
        });
      }

      return res.status(200).json({
        status: true,
        message: 'Charge successful',
        reference,
        amount: trx.amount,
        trx_status: 'SUCCESS',
        persisted: persistence.ok
      });
    }

    trx.status = 'FAILED';
    console.log(`[LEDGER] Trans Ref ${reference} DECLINED: ${declineReason}`);

    // Failed attempts are recorded too, so the ledger tells the whole story.
    const persistence = await persistToSupabase(trx);

    return res.status(200).json({
      status: false,
      message: declineReason,
      reference,
      trx_status: 'FAILED',
      persisted: persistence.ok
    });
  }, CHARGE_SETTLEMENT_DELAY_MS); // simulated USSD prompt delay
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
  const { email, merchant, callback_url } = req.body || {};
  const amount = parseFloat(req.body && req.body.amount);
  const reference = (req.body && req.body.reference) || generateReference();

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
      callback_url:
        callback_url ||
        `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(reference)}` +
          `&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
    });

    if (data.status) {
      return res.status(200).json({
        success: true,
        paymentUrl: data.data.authorization_url,
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
    process.env.WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY
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
    warnings.push('WEBHOOK_SECRET is unset — falling back to PAYSTACK_SECRET_KEY (this is fine for Paystack).');
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
    signingSecretConfigured: Boolean(process.env.WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY),
    signingSecretSource: process.env.WEBHOOK_SECRET ? 'WEBHOOK_SECRET'
      : process.env.PAYSTACK_SECRET_KEY ? 'PAYSTACK_SECRET_KEY' : null,
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
    console.error(`[WEBHOOK ${requestId}] STEP 5/6 SIGNATURE — ✗ signature mismatch. Check that WEBHOOK_SECRET (if set) equals PAYSTACK_SECRET_KEY, and that the key mode (test/live) matches the Paystack dashboard mode that sent this event.`);
  }

  // ── Fan the Paystack event out to the MERCHANT's webhook ──
  //
  // Paystack tells us a payment reached a terminal state; gateway.settle() is
  // the single place that records it and enqueues exactly one outbound webhook
  // per (reference, event). Because both the transition and the enqueue are
  // idempotent, Paystack retrying this delivery does NOT produce a second
  // merchant webhook. The reference is passed through untouched.
  if (result.statusCode === 200 && req.body && req.body.data && req.body.data.reference) {
    const paystackData = req.body.data;
    const eventName = String(req.body.event || '');
    const terminalStatus = eventName.startsWith('refund.')
      ? paymentsStore.STATUS.REFUNDED
      : eventName === 'charge.success' || paystackData.status === 'success'
        ? paymentsStore.STATUS.SUCCESS
        : eventName === 'charge.failed' || paystackData.status === 'failed'
          ? paymentsStore.STATUS.FAILED
          : null;

    if (terminalStatus) {
      const reference = String(paystackData.reference);
      // A payment Paystack knows about but we never initialized (e.g. started
      // before this deployment) still deserves a merchant webhook, so create
      // the record from the Paystack payload — which IS trustworthy, unlike a
      // query string, because it arrived over a signed channel.
      if (!paymentsStore.get(reference)) {
        const merchantRecord = merchants.getDefaultMerchant();
        paymentsStore.initialize({
          merchant: merchantRecord,
          mode: String(process.env.PAYSTACK_SECRET_KEY || '').includes('_test_') ? 'test' : 'live',
          amount: Number(paystackData.amount),
          reference,
          email: (paystackData.customer && paystackData.customer.email) || paystackData.email,
          currency: paystackData.currency,
          callback_url:
            (paystackData.metadata && paystackData.metadata.callback_url) || null,
          source: 'paystack'
        });
      }

      const settlement = gateway.settle(reference, {
        status: terminalStatus,
        channel: paystackData.channel || null,
        gateway_reference: paystackData.id ? String(paystackData.id) : paystackData.reference,
        paid_at: paystackData.paid_at || paystackData.paidAt || null,
        failure_reason: paystackData.gateway_response || null
      });

      console.log(
        `[WEBHOOK ${requestId}] MERCHANT-FANOUT — ${reference} ${settlement.changed ? 'settled' : 'already terminal (no duplicate webhook)'}` +
          (settlement.delivery ? ` -> ${settlement.delivery.state}` : '')
      );
    }
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

      if (!persistence.ok) {
        console.error(`[WEBHOOK ${requestId}] STEP 6/6 SUPABASE — ✗ Supabase rejected ${record.reference}: ${persistence.reason}. Common causes: Row Level Security blocking the anon key (use SUPABASE_SERVICE_ROLE_KEY), a missing column, or a type mismatch.`);
      }
    }
  } else if (result.statusCode === 200) {
    console.log(`[WEBHOOK ${requestId}] STEP 6/6 SUPABASE — skipped (no transaction to save, or Supabase is not configured)`);
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
  const webhookSecret = process.env.WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY || '';
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
      webhookSecretSource: process.env.WEBHOOK_SECRET
        ? 'WEBHOOK_SECRET'
        : process.env.PAYSTACK_SECRET_KEY ? 'PAYSTACK_SECRET_KEY' : null,
      paystackSecretKeyConfigured: Boolean(paystackKey),
      expectedWebhookUrl: process.env.PUBLIC_BASE_URL
        ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/webhook`
        : 'https://<your-vercel-domain>/api/webhook'
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

app.post('/api/webhook-debug', async (req, res) => {
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
// Temporary workaround that inserts a transaction directly into Supabase.
app.post('/api/manual-transaction', async (req, res) => {
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

// Serve frontend web routes
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

// Merchant settings: webhook URL, API keys, delivery log with replay.
app.get('/merchant', (req, res) => {
  res.sendFile(path.join(__dirname, 'merchant.html'));
});

// Webhook diagnostic page (also reachable as /webhook-status.html via static).
app.get('/webhook-status', (req, res) => {
  res.sendFile(path.join(__dirname, 'webhook-status.html'));
});

// Start the Payment Gateway server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 VALMONT-PAY CORE GATEWAY STARTED LIVE!`);
  console.log(`🔗 API Base URL: http://localhost:${PORT}`);
  console.log(`📈 Merchant Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`======================================================\n`);
});
