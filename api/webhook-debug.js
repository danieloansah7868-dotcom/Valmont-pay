/**
 * Webhook diagnostic endpoint — GET/POST /api/webhook-debug
 *
 * Helps debug webhook delivery issues without needing Paystack dashboard access.
 *
 * GET  → Shows configuration state, Supabase connectivity, and recent webhook health
 * POST → Simulates a Paystack webhook event (saves a test transaction to Supabase)
 *        Useful for verifying the entire webhook → Supabase pipeline works
 *
 * POST body (simulated Paystack event):
 *   {
 *     "event":  "charge.success",         // optional, defaults to "charge.success"
 *     "data": {
 *       "reference": "VP-TEST-123456",    // optional, auto-generated
 *       "amount":   5000,                 // optional, in pesewas (5000 = GHS 50)
 *       "email":    "test@example.com",   // optional
 *       "channel":  "mobile_money",       // optional
 *       "metadata": { "merchant": "Test Merchant" }  // optional
 *     }
 *   }
 *
 * NOTE: This endpoint skips real signature verification so it can be used for
 * testing. The POST is therefore guarded by the X-Admin-Key header (see
 * lib/admin-auth.js) — when ADMIN_PASSWORD is configured, simulated events
 * require admin authorization.
 */

import crypto from 'node:crypto';
import supabaseModule from '../lib/supabase.js';
import transactionStore from '../lib/transaction-store.js';
import baseUrlModule from '../lib/base-url.js';
import adminAuthModule from '../lib/admin-auth.js';

const { publicBaseUrl } = baseUrlModule;
const { isAuthorizedAdmin, unauthorizedPayload } = adminAuthModule;

const { getSupabaseClient, isSupabaseConfigured, supabaseConfigState, missingSupabaseEnvMessage } = supabaseModule;
const { saveTransaction, fetchTransactions } = transactionStore;

/**
 * Check if Supabase is reachable by attempting a simple query.
 */
async function checkSupabaseConnectivity() {
  const client = getSupabaseClient();
  if (!client) {
    return { ok: false, error: 'Supabase client is not initialized' };
  }

  try {
    const { data, error, count } = await client
      .from('transactions')
      .select('*', { count: 'exact', head: true });

    if (error) {
      return { ok: false, error: error.message, code: error.code };
    }

    return { ok: true, rowCount: count ?? (data ? data.length : 0) };
  } catch (thrown) {
    return { ok: false, error: thrown.message || String(thrown) };
  }
}

/**
 * Check webhook configuration state.
 */
function getWebhookConfigState(req) {
  const webhookSecret = process.env.PAYSTACK_SECRET_KEY || process.env.WEBHOOK_SECRET || '';
  const paystackKey = process.env.PAYSTACK_SECRET_KEY || '';

  return {
    webhookSecretConfigured: Boolean(webhookSecret),
    webhookSecretSource: process.env.PAYSTACK_SECRET_KEY
      ? 'PAYSTACK_SECRET_KEY'
      : process.env.WEBHOOK_SECRET
        ? 'WEBHOOK_SECRET (legacy fallback)'
        : null,
    paystackSecretKeyConfigured: Boolean(paystackKey),
    paystackSecretKeyPrefix: paystackKey ? `${paystackKey.substring(0, 12)}...` : null,
    // Host-first: a stale PUBLIC_BASE_URL (e.g. a dead .vercel.app hostname)
    // must never be recommended as the Paystack webhook URL again.
    expectedWebhookUrl: `${publicBaseUrl(req)}/api/webhook`
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Diagnostic GET — show configuration and connectivity status
    const supabaseConfig = supabaseConfigState();
    const webhookConfig = getWebhookConfigState(req);
    const supabaseConnection = await checkSupabaseConnectivity();

    const diagnostics = {
      success: true,
      timestamp: new Date().toISOString(),
      environment: {
        vercel: Boolean(process.env.VERCEL),
        vercelEnv: process.env.VERCEL_ENV || 'local',
        nodeVersion: process.version
      },
      supabase: {
        configured: supabaseConfig.configured,
        urlConfigured: supabaseConfig.urlConfigured,
        keyConfigured: supabaseConfig.keyConfigured,
        credentialType: supabaseConfig.credentialType,
        connectivity: supabaseConnection
      },
      webhook: webhookConfig,
      issues: [],
      recommendations: []
    };

    // Identify issues
    if (!supabaseConfig.configured) {
      diagnostics.issues.push('Supabase is not fully configured');
      diagnostics.recommendations.push(
        'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables'
      );
    }

    if (!supabaseConnection.ok) {
      diagnostics.issues.push(`Supabase connectivity check failed: ${supabaseConnection.error}`);
      diagnostics.recommendations.push(
        'Verify your Supabase URL is correct and the service role key has access to the transactions table'
      );
    }

    if (!webhookConfig.webhookSecretConfigured) {
      diagnostics.issues.push('No webhook signing secret configured');
      diagnostics.recommendations.push(
        'Set PAYSTACK_SECRET_KEY in Vercel environment variables — Paystack signs webhooks with this key'
      );
    }

    if (!webhookConfig.paystackSecretKeyConfigured) {
      diagnostics.issues.push('PAYSTACK_SECRET_KEY is not set');
      diagnostics.recommendations.push(
        'Get your Paystack secret key from https://dashboard.paystack.com/#/settings/developer/api-keys'
      );
    }

    // General recommendations
    if (diagnostics.issues.length === 0) {
      diagnostics.recommendations.push(
        'Configuration looks good. In Paystack Dashboard → Settings → Preferences → Webhooks, ensure your webhook URL is: ' +
          (typeof webhookConfig.expectedWebhookUrl === 'string' && webhookConfig.expectedWebhookUrl.startsWith('http')
            ? webhookConfig.expectedWebhookUrl
            : 'https://<your-vercel-domain>/api/webhook')
      );
      diagnostics.recommendations.push(
        'Use POST /api/webhook-debug with a test event to verify the full pipeline works end-to-end'
      );
    }

    return res.status(diagnostics.issues.length ? 200 : 200).json(diagnostics);
  }

  if (req.method === 'POST') {
    // Simulated webhook POST — test the Supabase write pipeline
    if (!isSupabaseConfigured()) {
      const message = missingSupabaseEnvMessage() || 'Supabase is not configured';
      return res.status(500).json({
        success: false,
        error: 'Supabase is not configured',
        message
      });
    }

    // Admin-guarded: this POST simulates webhook events and writes SUCCESS
    // rows straight into the ledger. Open over the internet it lets anyone
    // inflate the dashboard with fake settled money.
    if (!isAuthorizedAdmin(req)) {
      return res.status(401).json(unauthorizedPayload());
    }

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    } catch (error) {
      return res.status(400).json({ success: false, error: 'Invalid JSON request body' });
    }

    const eventName = body.event || 'charge.success';
    const data = body.data || {};

    // Build a realistic Paystack-shaped payload
    const reference = data.reference || `VP-DEBUG-${Date.now().toString(36).toUpperCase()}`;
    const amount = data.amount || 5000; // 5000 pesewas = GHS 50.00
    const channel = data.channel || 'mobile_money';
    const email = data.email || data.customer_email || 'test@example.com';
    const merchant = (data.metadata && data.metadata.merchant) || 'Debug Test Merchant';

    // Map to transaction-store shape (same as the real webhook does)
    const amountInGhs = Number(amount) / 100;
    const transaction = {
      reference,
      merchant_name: merchant,
      customer_email: email,
      amount: Math.round(amountInGhs * 100) / 100,
      payment_method: channel === 'mobile_money' ? 'Mobile Money' : channel === 'card' ? 'Credit/Debit Card' : channel,
      status: eventName === 'charge.success' ? 'SUCCESS' : 'FAILED',
      paid_at: eventName === 'charge.success' ? new Date().toISOString() : null
    };

    console.log('[WEBHOOK-DEBUG] Simulating webhook event:', eventName, transaction);

    const client = getSupabaseClient();
    if (!client) {
      return res.status(500).json({
        success: false,
        error: 'Supabase client is not available'
      });
    }

    const result = await saveTransaction(transaction, {
      client,
      context: 'WEBHOOK-DEBUG'
    });

    if (!result.ok) {
      console.error('[WEBHOOK-DEBUG] Supabase write failed:', result.error);
      return res.status(500).json({
        success: false,
        error: 'Failed to save simulated transaction',
        message: result.reason,
        detail: result.error
      });
    }

    console.log('[WEBHOOK-DEBUG] Simulated transaction saved:', reference);

    return res.status(200).json({
      success: true,
      message: 'Simulated webhook event processed successfully',
      reference,
      event: eventName,
      transaction: result.data || transaction,
      note: 'This bypasses signature verification — the real /api/webhook requires a valid x-paystack-signature header'
    });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
