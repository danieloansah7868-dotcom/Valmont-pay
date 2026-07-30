/**
 * Shared Paystack helper (CommonJS so it can be required by server.js and
 * imported by the ESM serverless functions inside /api).
 *
 * Paystack works in the smallest currency unit (pesewas for GHS, kobo for NGN),
 * so every amount leaving this module is multiplied by 100.
 *
 * Supports multi-tenant: call initializePaymentWithKey() to use a specific
 * tenant's Paystack key instead of the global PAYSTACK_SECRET_KEY.
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

/**
 * Initialize a payment with Paystack using the provided secret key.
 * This is the multi-tenant aware version — pass the tenant's own Paystack key.
 *
 * @param {object} params
 * @param {number} params.amount - Major units (e.g. 50.00)
 * @param {string} params.email
 * @param {string} params.reference
 * @param {string} [params.callback_url]
 * @param {string} [params.merchant]
 * @param {string} [params.currency='GHS']
 * @param {string} [params.secretKey] - Tenant-specific Paystack secret key.
 *        Falls back to process.env.PAYSTACK_SECRET_KEY.
 */
async function initializePaymentWithKey({
  amount,
  email,
  reference,
  callback_url: callbackUrl,
  merchant,
  phone,
  currency = 'GHS',
  secretKey
}) {
  const key = secretKey || getSecretKey();
  if (!key) {
    const error = new Error('No Paystack secret key available for this tenant.');
    error.code = 'MISSING_SECRET_KEY';
    throw error;
  }

  const payload = {
    email,
    amount: toSubunits(amount),
    reference,
    currency
  };

  if (callbackUrl) payload.callback_url = callbackUrl;
  if (merchant || phone) {
    payload.metadata = { custom_fields: [] };
    if (merchant) {
      payload.metadata.merchant = merchant;
      payload.metadata.custom_fields.push({
        display_name: 'Merchant',
        variable_name: 'merchant',
        value: merchant
      });
    }
    if (phone) {
      payload.metadata.phone = phone;
      payload.metadata.custom_fields.push({
        display_name: 'Mobile Money Number',
        variable_name: 'momo_number',
        value: phone
      });
    }
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
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  return response.json();
}

/**
 * Initialize a payment using the global PAYSTACK_SECRET_KEY env var.
 * Kept for backward compatibility.
 */
async function initializePayment(params) {
  return initializePaymentWithKey(params);
}

/**
 * Verify a payment with Paystack using the provided secret key.
 * This is the multi-tenant aware version.
 *
 * @param {string} reference
 * @param {string} [secretKey] - Tenant-specific Paystack secret key.
 *        Falls back to process.env.PAYSTACK_SECRET_KEY.
 */
async function verifyPaymentWithKey(reference, secretKey) {
  const key = secretKey || getSecretKey();
  if (!key) {
    const error = new Error('No Paystack secret key available for this tenant.');
    error.code = 'MISSING_SECRET_KEY';
    throw error;
  }

  console.log('[PAYSTACK] Verifying payment -> Reference:', reference);

  const response = await fetch(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${key}`
      }
    }
  );

  return response.json();
}

/**
 * Verify a payment using the global PAYSTACK_SECRET_KEY env var.
 * Kept for backward compatibility.
 */
async function verifyPayment(reference) {
  return verifyPaymentWithKey(reference);
}

module.exports = {
  PAYSTACK_BASE_URL,
  getSecretKey,
  toSubunits,
  generateReference,
  initializePayment,
  initializePaymentWithKey,
  verifyPayment,
  verifyPaymentWithKey
};
