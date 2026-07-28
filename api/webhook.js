/**
 * Paystack webhook handler (Vercel serverless function).
 *
 * The signature must be calculated from the exact bytes Paystack sent, so body
 * parsing is disabled for this function and the raw request stream is read
 * before the JSON payload is parsed.
 */

import crypto from 'node:crypto';
import supabaseModule from '../lib/supabase.js';

const { getSupabaseClient } = supabaseModule;

// Vercel must not parse/re-serialize the payload before signature verification.
export const config = {
  api: {
    bodyParser: false
  }
};

/** Return a header value regardless of the casing used by a request mock. */
function getHeader(req, name) {
  const headers = req.headers || {};
  const directValue = headers[name.toLowerCase()];
  if (directValue !== undefined) {
    return Array.isArray(directValue) ? directValue[0] : directValue;
  }

  const matchingKey = Object.keys(headers).find(
    key => key.toLowerCase() === name.toLowerCase()
  );
  const value = matchingKey ? headers[matchingKey] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Read the exact request bytes. The fallbacks make the handler work with local
 * Express adapters and tests that provide req.rawBody or an already parsed
 * req.body, while production Vercel requests use the request stream.
 */
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');

  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Verify an HMAC SHA-512 signature without timing-sensitive string compares. */
export function verifySignature(rawBody, signature, secret = process.env.WEBHOOK_SECRET) {
  if (!secret || !signature || rawBody === undefined || rawBody === null) return false;

  const suppliedSignature = String(signature).trim().toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(suppliedSignature)) return false;

  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(suppliedSignature, 'hex');

  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

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

function getMerchantName(metadata) {
  if (!metadata || typeof metadata !== 'object') return 'Valmont-Pay';
  if (metadata.merchant) return String(metadata.merchant);
  if (metadata.merchant_name) return String(metadata.merchant_name);

  const merchantField = Array.isArray(metadata.custom_fields)
    ? metadata.custom_fields.find(field => field && field.variable_name === 'merchant')
    : null;
  return merchantField && merchantField.value
    ? String(merchantField.value)
    : 'Valmont-Pay';
}

function transactionFromEvent(eventName, data) {
  const amountInSubunits = Number(data.amount);
  if (!Number.isFinite(amountInSubunits) || amountInSubunits < 0) {
    throw new Error('Webhook payload contains an invalid amount');
  }

  return {
    reference: String(data.reference),
    merchant_name: getMerchantName(data.metadata),
    customer_email: data.customer?.email || data.email || 'unknown@customer',
    // Paystack reports GHS payments in pesewas (the smallest currency unit).
    amount: amountInSubunits / 100,
    payment_method: formatChannel(data.channel, data.authorization),
    status: eventName === 'charge.success' ? 'SUCCESS' : 'FAILED',
    paid_at:
      data.paid_at ||
      data.paidAt ||
      (eventName === 'charge.success' ? data.created_at || new Date().toISOString() : null)
  };
}

function configurationState() {
  return {
    webhookSecretConfigured: Boolean(process.env.WEBHOOK_SECRET),
    supabaseUrlConfigured: Boolean(process.env.SUPABASE_URL),
    supabaseKeyConfigured: Boolean(
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    )
  };
}

/**
 * Factory exported for an offline integration test. Production uses the shared
 * Supabase client; tests can inject a client without contacting Supabase.
 */
export function createWebhookHandler({ supabaseClient } = {}) {
  return async function webhookHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    console.log('[WEBHOOK] POST request received', {
      contentType: getHeader(req, 'content-type') || null,
      userAgent: getHeader(req, 'user-agent') || null
    });

    try {
      const rawBody = await readRawBody(req);
      const rawBodyText = rawBody.toString('utf8');
      console.log('[WEBHOOK] Request body:', rawBodyText);

      const envState = configurationState();
      console.log('[WEBHOOK] Environment configuration:', envState);

      const signature = getHeader(req, 'x-paystack-signature');
      const signatureIsValid = verifySignature(
        rawBody,
        signature,
        process.env.WEBHOOK_SECRET
      );
      console.log('[WEBHOOK] Signature verification result:', {
        valid: signatureIsValid,
        signaturePresent: Boolean(signature),
        secretConfigured: envState.webhookSecretConfigured
      });

      if (!envState.webhookSecretConfigured) {
        console.error('[WEBHOOK] Error: WEBHOOK_SECRET is not configured');
        return res.status(500).json({
          success: false,
          error: 'Webhook is not configured: WEBHOOK_SECRET is missing'
        });
      }

      if (!signatureIsValid) {
        console.error('[WEBHOOK] Error: webhook signature verification failed');
        return res.status(400).json({ success: false, error: 'Invalid webhook signature' });
      }

      let payload;
      try {
        payload = JSON.parse(rawBodyText);
      } catch (error) {
        console.error('[WEBHOOK] Error parsing request body:', error);
        return res.status(400).json({ success: false, error: 'Invalid JSON request body' });
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        console.error('[WEBHOOK] Error: request body is not a JSON object');
        return res.status(400).json({ success: false, error: 'Invalid webhook payload' });
      }

      const { event: eventName, data } = payload;
      if (!['charge.success', 'charge.failed'].includes(eventName)) {
        console.log('[WEBHOOK] Ignoring unsupported event:', eventName || 'unknown');
        return res.status(200).json({
          success: true,
          received: true,
          ignored: true,
          event: eventName || null
        });
      }

      if (!data || typeof data !== 'object' || !data.reference) {
        console.error('[WEBHOOK] Error: payload is missing transaction data/reference');
        return res.status(400).json({
          success: false,
          error: 'Webhook payload is missing transaction data or reference'
        });
      }

      let transaction;
      try {
        transaction = transactionFromEvent(eventName, data);
      } catch (error) {
        console.error('[WEBHOOK] Error mapping transaction:', error);
        return res.status(400).json({ success: false, error: error.message });
      }

      if (!envState.supabaseUrlConfigured || !envState.supabaseKeyConfigured) {
        console.error('[WEBHOOK] Error: Supabase environment variables are not configured');
        return res.status(500).json({
          success: false,
          error: 'Supabase is not configured: SUPABASE_URL and a Supabase key are required'
        });
      }

      const client = supabaseClient || getSupabaseClient();
      if (!client) {
        console.error('[WEBHOOK] Error: Supabase client could not be initialized');
        return res.status(500).json({
          success: false,
          error: 'Supabase client is not available'
        });
      }

      let insertResult;
      try {
        insertResult = await client
          .from('transactions')
          .insert([transaction])
          .select();
      } catch (error) {
        console.error('[WEBHOOK] Supabase insert threw an error:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to save transaction',
          message: error.message
        });
      }

      console.log('[WEBHOOK] Supabase insert result:', insertResult);

      if (insertResult.error) {
        console.error('[WEBHOOK] Supabase insert error:', insertResult.error);
        return res.status(500).json({
          success: false,
          error: 'Failed to save transaction',
          message: insertResult.error.message || String(insertResult.error)
        });
      }

      console.log('[WEBHOOK] Transaction saved successfully:', transaction.reference);
      return res.status(200).json({
        success: true,
        received: true,
        reference: transaction.reference,
        transaction: insertResult.data?.[0] || transaction
      });
    } catch (error) {
      console.error('[WEBHOOK] Unhandled error:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal webhook error',
        message: error.message
      });
    }
  };
}

export default createWebhookHandler();
