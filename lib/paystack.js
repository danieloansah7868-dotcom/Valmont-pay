/**
 * Shared Paystack helper (CommonJS so it can be required by server.js and
 * imported by the ESM serverless functions inside /api).
 *
 * Paystack works in the smallest currency unit (pesewas for GHS, kobo for NGN),
 * so every amount leaving this module is multiplied by 100.
 */

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function getSecretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const error = new Error('PAYSTACK_SECRET_KEY is not configured on the server.');
    error.code = 'MISSING_SECRET_KEY';
    throw error;
  }
  return key;
}

/**
 * Convert a major-unit amount (GH₵ 50.00) into pesewas (5000).
 * Rounding avoids floating point artefacts such as 50.1 * 100 = 5009.999...
 */
function toSubunits(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * Generate a gateway reference. Kept in one place so pay.html, the local
 * ledger and Paystack always agree on the format.
 */
function generateReference() {
  return `VP-${Math.floor(100000 + Math.random() * 900000)}`;
}

async function initializePayment({
  amount,
  email,
  reference,
  callback_url: callbackUrl,
  merchant,
  currency = 'GHS'
}) {
  const secretKey = getSecretKey();

  const payload = {
    email,
    // Paystack works in pesewas (kobo), so multiply by 100
    amount: toSubunits(amount),
    // The reference MUST be forwarded, otherwise Paystack generates its own
    // and our ledger can never be reconciled / verified.
    reference,
    currency
  };

  if (callbackUrl) payload.callback_url = callbackUrl;
  if (merchant) {
    payload.metadata = {
      merchant,
      custom_fields: [
        {
          display_name: 'Merchant',
          variable_name: 'merchant',
          value: merchant
        }
      ]
    };
  }

  console.log('[PAYSTACK] Initializing payment ->', {
    reference: payload.reference,
    amount: payload.amount,
    currency: payload.currency,
    email: payload.email,
    merchant: merchant || null
  });

  const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  return response.json();
}

async function verifyPayment(reference) {
  const secretKey = getSecretKey();

  console.log('[PAYSTACK] Verifying payment -> Reference:', reference);

  const response = await fetch(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${secretKey}`
      }
    }
  );

  return response.json();
}

module.exports = {
  PAYSTACK_BASE_URL,
  getSecretKey,
  toSubunits,
  generateReference,
  initializePayment,
  verifyPayment
};
