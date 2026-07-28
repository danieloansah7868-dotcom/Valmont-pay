/**
 * Manual transaction endpoint — POST /api/manual-transaction
 *
 * Temporary workaround that lets you insert a transaction directly into
 * Supabase without going through Paystack. Useful for:
 *   - Testing the dashboard while debugging the webhook
 *   - Recording cash/in-person payments
 *   - Backfilling transactions that the webhook missed
 *
 * Accepts POST with a JSON body:
 *   {
 *     "reference":      "VP-MANUAL-123456",   // required, unique
 *     "merchant_name":  "Valmont Electricals", // optional, defaults to "Valmont-Pay"
 *     "customer_email": "buyer@example.com",   // optional, defaults to "manual@entry"
 *     "amount":         150.00,                // required, in GHS (major units)
 *     "payment_method": "Cash",                // optional, defaults to "Manual Entry"
 *     "status":         "SUCCESS",             // optional, defaults to "SUCCESS"
 *     "paid_at":        "2026-07-28T..."       // optional, defaults to now (if SUCCESS)
 *   }
 *
 * Returns the saved row on success.
 */

import transactionStore from '../lib/transaction-store.js';
import supabaseModule from '../lib/supabase.js';

const { saveTransaction } = transactionStore;
const { getSupabaseClient, isSupabaseConfigured, supabaseConfigState, missingSupabaseEnvMessage } = supabaseModule;

/**
 * Generate a unique reference for manual entries that don't provide one.
 */
function generateManualReference() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(1000 + Math.random() * 9000).toString();
  return `VP-MANUAL-${ts}-${rand}`;
}

/**
 * Validate admin credentials if ADMIN_EMAIL and ADMIN_PASSWORD are set.
 * Returns true if auth is not configured (permissive) or if credentials match.
 */
function checkAdminAuth(req) {
  const expectedEmail = process.env.ADMIN_EMAIL;
  const expectedPassword = process.env.ADMIN_PASSWORD;

  // If admin credentials aren't configured, allow the request (dev mode).
  if (!expectedEmail && !expectedPassword) return true;

  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const [email, ...passwordParts] = decoded.split(':');
    const password = passwordParts.join(':');
    return email === expectedEmail && password === expectedPassword;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
      message: 'Send a POST request with transaction data'
    });
  }

  // Check admin auth if credentials are configured
  if (!checkAdminAuth(req)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Provide admin credentials via HTTP Basic auth (Authorization: Basic <base64(email:password)>)'
    });
  }

  // Verify Supabase is configured
  if (!isSupabaseConfigured()) {
    const message = missingSupabaseEnvMessage() || 'Supabase is not configured';
    console.error('[MANUAL-TRANSACTION]', message, supabaseConfigState());
    return res.status(500).json({
      success: false,
      error: 'Supabase is not configured',
      message
    });
  }

  // Parse the request body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch (error) {
    console.error('[MANUAL-TRANSACTION] Invalid JSON body:', error);
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON request body'
    });
  }

  // Validate required fields
  const amount = parseFloat(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({
      success: false,
      error: 'A valid amount (number >= 0) is required',
      received: body.amount
    });
  }

  // Build the transaction record
  const transaction = {
    reference: body.reference || generateManualReference(),
    merchant_name: body.merchant_name || body.merchant || 'Valmont-Pay',
    customer_email: body.customer_email || body.customer || body.email || 'manual@entry',
    amount,
    payment_method: body.payment_method || body.channel || 'Manual Entry',
    status: (body.status || 'SUCCESS').toUpperCase(),
    paid_at: body.paid_at || (body.status !== 'FAILED' ? new Date().toISOString() : null)
  };

  console.log('[MANUAL-TRANSACTION] Saving transaction:', transaction.reference, {
    amount: transaction.amount,
    status: transaction.status,
    merchant: transaction.merchant_name
  });

  // Save to Supabase
  const client = getSupabaseClient();
  if (!client) {
    return res.status(500).json({
      success: false,
      error: 'Supabase client is not available'
    });
  }

  const result = await saveTransaction(transaction, {
    client,
    context: 'MANUAL'
  });

  if (!result.ok) {
    console.error('[MANUAL-TRANSACTION] Failed to save:', result.error);
    return res.status(500).json({
      success: false,
      error: 'Failed to save transaction',
      message: result.reason,
      detail: result.error
    });
  }

  console.log('[MANUAL-TRANSACTION] Saved successfully:', transaction.reference);
  return res.status(200).json({
    success: true,
    reference: transaction.reference,
    data: result.data || transaction,
    message: 'Transaction saved to Supabase successfully'
  });
}
