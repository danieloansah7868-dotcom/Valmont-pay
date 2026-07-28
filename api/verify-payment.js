/**
 * Vercel serverless function — GET /api/verify-payment?reference=...
 *
 * Verifies a Paystack transaction by reference. On success, ALSO persists the
 * transaction to Supabase so the dashboard can display it.
 *
 * This is the SAFETY NET for the webhook: when Paystack redirects the customer
 * back to the checkout page, the frontend calls this endpoint. If the webhook
 * hasn't fired yet (or isn't configured), this write ensures the payment still
 * reaches the dashboard. The upsert by `reference` keeps it idempotent — the
 * webhook and this endpoint can both write the same transaction without
 * duplicating it.
 */

import paystackModule from '../lib/paystack.js';
import transactionStore from '../lib/transaction-store.js';
import supabaseModule from '../lib/supabase.js';

const { verifyPayment } = paystackModule;
const { saveTransaction } = transactionStore;
const { getSupabaseClient, isSupabaseConfigured } = supabaseModule;

/** Map a Paystack channel + authorization to a human-friendly label. */
function formatChannel(channel, authorization) {
  if (!channel) return 'Unknown';
  const normalized = String(channel).toLowerCase();
  if (normalized === 'mobile_money') {
    const bank = authorization && (authorization.bank || authorization.sender_bank);
    return bank ? `Mobile Money (${bank})` : 'Mobile Money';
  }
  if (normalized === 'card') {
    const brand = authorization && authorization.card_type;
    return brand ? `Card (${brand})` : 'Credit/Debit Card';
  }
  if (normalized === 'bank_transfer') return 'Bank Transfer';
  if (normalized === 'bank') return 'Bank';
  if (normalized === 'ussd') return 'USSD';
  if (normalized === 'qr') return 'QR';
  return String(channel);
}

/** Extract the merchant name from Paystack metadata. */
function getMerchantName(metadata) {
  if (!metadata || typeof metadata !== 'object') return 'Valmont-Pay';
  if (metadata.merchant) return String(metadata.merchant);
  if (metadata.merchant_name) return String(metadata.merchant_name);
  const merchantField = Array.isArray(metadata.custom_fields)
    ? metadata.custom_fields.find(f => f && f.variable_name === 'merchant')
    : null;
  return merchantField && merchantField.value ? String(merchantField.value) : 'Valmont-Pay';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing transaction reference' });
  }

  console.log('[VERIFY-PAYMENT] Reference:', reference);

  try {
    const data = await verifyPayment(reference);

    const paystackTrx = data && data.data ? data.data : null;
    const isSuccess = Boolean(
      data && data.status && paystackTrx && paystackTrx.status === 'success'
    );

    // ── CRITICAL FIX: Persist the verified transaction to Supabase ──
    //
    // This is the fallback for when webhooks aren't configured or haven't fired
    // yet. The checkout page calls this endpoint after Paystack redirects back,
    // so this write is often the ONLY thing that puts the payment in front of
    // the merchant. The upsert by `reference` keeps it idempotent with the
    // webhook handler — both can write the same transaction safely.
    let persisted = null;
    if (paystackTrx && paystackTrx.reference && isSupabaseConfigured()) {
      const client = getSupabaseClient();

      if (client) {
        const transaction = {
          reference: paystackTrx.reference,
          merchant_name: getMerchantName(paystackTrx.metadata),
          customer_email: paystackTrx.customer?.email || paystackTrx.email || 'unknown@customer',
          // Paystack returns amounts in pesewas — convert to GHS
          amount: (Number(paystackTrx.amount) || 0) / 100,
          payment_method: formatChannel(paystackTrx.channel, paystackTrx.authorization),
          status: isSuccess ? 'SUCCESS' : (paystackTrx.status || 'PENDING').toUpperCase(),
          paid_at: isSuccess
            ? (paystackTrx.paid_at || paystackTrx.paidAt || new Date().toISOString())
            : null
        };

        const result = await saveTransaction(transaction, {
          client,
          context: 'VERIFY-PAYMENT'
        });

        persisted = {
          ok: result.ok,
          reference: result.record.reference,
          error: result.ok ? null : result.reason
        };

        if (result.ok) {
          console.log('[VERIFY-PAYMENT] Transaction persisted to Supabase:', transaction.reference);
        } else {
          console.error('[VERIFY-PAYMENT] Failed to persist transaction:', result.reason, result.error);
        }
      }
    } else if (!isSupabaseConfigured()) {
      console.warn('[VERIFY-PAYMENT] Supabase is not configured — transaction not persisted');
    }

    // Surface a simple, flattened summary alongside the raw Paystack payload so
    // the frontend does not have to dig through the response shape.
    return res.status(200).json({
      ...data,
      success: isSuccess,
      summary: paystackTrx
        ? {
            reference: paystackTrx.reference,
            status: paystackTrx.status,
            // Paystack returns pesewas — convert back to GHS for display
            amount: paystackTrx.amount / 100,
            currency: paystackTrx.currency,
            email: paystackTrx.customer ? paystackTrx.customer.email : null,
            channel: paystackTrx.channel,
            paid_at: paystackTrx.paid_at,
            merchant:
              paystackTrx.metadata && paystackTrx.metadata.merchant
                ? paystackTrx.metadata.merchant
                : null
          }
        : null,
      persisted
    });
  } catch (error) {
    console.error('[VERIFY-PAYMENT] Payment verification error for reference', reference, error);

    if (error.code === 'MISSING_SECRET_KEY') {
      return res.status(500).json({
        status: false,
        message: 'Payment provider is not configured. Set PAYSTACK_SECRET_KEY.'
      });
    }

    return res.status(500).json({ status: false, message: 'Internal server error' });
  }
}
