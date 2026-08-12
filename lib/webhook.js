/**
 * Paystack webhook handler.
 *
 * This is how REAL payments get onto the ledger. Paystack POSTs an event here
 * whenever a transaction succeeds/fails; we verify the signature, map the
 * payload onto our ledger shape and upsert it. The dashboard then picks it up
 * from /api/transactions.
 *
 * Signature verification: Paystack signs the raw request body with HMAC SHA512
 * using your secret key and sends it as the `x-paystack-signature` header.
 */

const crypto = require('crypto');
const ledger = require('./ledger');

/** Human-friendly channel label for the dashboard. */
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
  return channel;
}

/** Map a Paystack event name onto our ledger status. */
function statusFromEvent(event, data) {
  if (event === 'charge.success') return 'SUCCESS';
  if (event === 'charge.failed' || event === 'transaction.failed') return 'FAILED';
  const paystackStatus = data && data.status ? String(data.status).toLowerCase() : '';
  if (paystackStatus === 'success') return 'SUCCESS';
  if (paystackStatus === 'failed' || paystackStatus === 'reversed') return 'FAILED';
  if (paystackStatus === 'abandoned') return 'ABANDONED';
  return 'PENDING';
}

/**
 * Verify the `x-paystack-signature` header against the raw body.
 * Returns true when it matches, false otherwise.
 */
function getWebhookSecret() {
  // Paystack signs with its own secret key, so that credential is authoritative.
  // WEBHOOK_SECRET remains only as a legacy local/custom-event fallback.
  return process.env.PAYSTACK_SECRET_KEY || process.env.WEBHOOK_SECRET || '';
}

function verifySignature(rawBody, signature, secretKey = getWebhookSecret()) {
  if (!secretKey || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Turn a Paystack `data` object into a ledger record. */
function toLedgerRecord(event, data) {
  return {
    reference: data.reference,
    customer: (data.customer && data.customer.email) || data.email || 'unknown@customer',
    // Paystack reports pesewas — convert back to GH₵
    amount: typeof data.amount === 'number' ? data.amount / 100 : parseFloat(data.amount) || 0,
    channel: formatChannel(data.channel, data.authorization),
    status: statusFromEvent(event, data),
    merchant: (data.metadata && data.metadata.merchant) || undefined,
    timestamp: data.paid_at || data.paidAt || data.created_at || new Date().toISOString()
  };
}

/**
 * Core handler, framework agnostic so both server.js (Express) and
 * api/webhook.js (Vercel serverless) can share it.
 *
 * @returns {{statusCode:number, body:object}}
 */
function handleWebhookEvent(body, signature, rawBody) {
  const payload = typeof body === 'string' ? safeParse(body) : body;

  if (!payload || typeof payload !== 'object') {
    return { statusCode: 400, body: { status: false, message: 'Invalid webhook payload' } };
  }

  // Signature check is mandatory. No signing secret means the endpoint is
  // misconfigured — refuse the event rather than accepting unsigned traffic.
  // The exact raw request bytes are verified, never a re-serialized payload.
  const secret = getWebhookSecret();
  if (!secret) {
    console.error('[WEBHOOK] No signing secret configured — refusing the event.');
    return { statusCode: 500, body: { status: false, message: 'Webhook is not configured' } };
  }
  const raw = rawBody || JSON.stringify(payload);
  if (!verifySignature(raw, signature, secret)) {
    console.warn('[WEBHOOK] Rejected event with an invalid signature.');
    return { statusCode: 400, body: { status: false, message: 'Invalid signature' } };
  }

  const { event, data } = payload;

  if (!data || !data.reference) {
    return { statusCode: 400, body: { status: false, message: 'Webhook payload is missing a reference' } };
  }

  const record = ledger.upsertTransaction(toLedgerRecord(event, data));

  console.log(
    `[WEBHOOK] ${event || 'unknown event'} -> ${record.reference} | ${record.status} | GHS ${record.amount} | balance GHS ${ledger.getBalance()}`
  );

  // Always 200 so Paystack stops retrying once we have recorded the event.
  return {
    statusCode: 200,
    body: { status: true, received: true, reference: record.reference, transaction: record }
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

module.exports = {
  handleWebhookEvent,
  verifySignature,
  getWebhookSecret,
  toLedgerRecord,
  formatChannel,
  statusFromEvent
};
