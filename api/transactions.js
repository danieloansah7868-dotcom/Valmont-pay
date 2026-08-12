/**
 * Vercel serverless function — /api/transactions
 *
 * GET  → fetch every transaction from Supabase, in the shape dashboard.html renders
 * POST → upsert a transaction into Supabase (by `reference`)
 *
 * Both directions go through lib/transaction-store.js, the single place that
 * knows the `transactions` table shape, so this endpoint and the dashboard
 * checkout (POST /api/v1/transaction/charge in server.js) can never drift apart.
 *
 * NOTE: vercel.json currently routes /api/transactions to server.js. This
 * function is kept in lockstep with it so either wiring behaves identically.
 */

import supabaseModule from '../lib/supabase.js';
import transactionStore from '../lib/transaction-store.js';
import adminAuthModule from '../lib/admin-auth.js';
import secretsModule from '../lib/insecure-secrets.js';
import sessionModule from '../lib/admin-session.js';

const { isSupabaseConfigured, missingSupabaseEnvMessage, supabaseConfigState } = supabaseModule;
const { saveTransaction, fetchTransactions, buildLedgerPayload } = transactionStore;
const { isAuthorizedAdmin, unauthorizedPayload } = adminAuthModule;
const { isProductionRuntime } = secretsModule;
const { safeEqual } = sessionModule;

export default async function handler(req, res) {
  // Cross-origin support: the storefront (e.g. example-store.com)
  // records Cash on Delivery / Manual MoMo orders (status PENDING_MOMO) and the
  // admin panel reconciles them, both via this endpoint on the gateway origin.
  const requestOrigin = req.headers && req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-valmontpay-signature, x-admin-key, x-storefront-key');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Environment is checked up front so a misconfigured deployment returns a
  // clear error instead of an empty dashboard that looks like "no sales yet".
  if (!isSupabaseConfigured()) {
    const message = missingSupabaseEnvMessage() || 'Supabase is not configured';
    console.error('[TRANSACTIONS]', message, supabaseConfigState());
    return res.status(500).json({
      success: false,
      status: false,
      error: 'Supabase is not configured',
      message,
      transactions: [],
      data: []
    });
  }

  if (req.method === 'GET') {
    if (!isAuthorizedAdmin(req)) {
      return res.status(401).json(unauthorizedPayload());
    }
    const result = await fetchTransactions({ context: 'TRANSACTIONS' });

    if (!result.ok) {
      return res.status(500).json({
        success: false,
        status: false,
        error: 'Failed to fetch transactions',
        message: result.reason,
        transactions: [],
        data: []
      });
    }

    const payload = buildLedgerPayload(result.transactions);
    return res.status(200).json({
      success: true,
      status: true,
      source: 'supabase',
      ...payload,
      data: payload.transactions
    });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    } catch (error) {
      console.error('[TRANSACTIONS] Invalid JSON body:', error);
      return res.status(400).json({ success: false, error: 'Invalid JSON request body' });
    }

    if (!body.reference) {
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    // Terminal-status writes change what the dashboard counts as settled
    // money. Public storefronts may only ever create/amend NON-terminal
    // rows (PENDING, PENDING_MOMO); marking an order PAID/CANCELLED/etc.
    // requires the admin key. Mirrors server.js POST /api/transactions.
    const TERMINAL_STATUSES = ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'];
    const requestedStatus = String(body.status || 'PENDING').toUpperCase();
    if (TERMINAL_STATUSES.includes(requestedStatus) && !isAuthorizedAdmin(req)) {
      return res.status(401).json(unauthorizedPayload());
    }
    if (!TERMINAL_STATUSES.includes(requestedStatus) && !isAuthorizedAdmin(req)) {
      const storefrontKey = process.env.STOREFRONT_WRITE_KEY || '';
      const presented = String((req.headers && (req.headers['x-storefront-key'] || req.headers['X-Storefront-Key'])) || '');
      if (isProductionRuntime()) {
        if (!storefrontKey || !presented || !safeEqual(presented, storefrontKey)) {
          return res.status(401).json({
            success: false,
            error: 'Storefront authorization required. Send X-Storefront-Key (STOREFRONT_WRITE_KEY).'
          });
        }
      }
    }

    const result = await saveTransaction(body, { context: 'TRANSACTIONS' });

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
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
