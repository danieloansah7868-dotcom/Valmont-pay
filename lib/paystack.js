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

const crypto = require('crypto');

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
 *
 * Format: VP-<base36-time>-<8-hex-random>, e.g. VP-MB3K7Z1A-9F4C2E18.
 * The old VP-<6 random digits> scheme had only ~900k values: with
 * reference-keyed upserts, a collision would overwrite a real transaction.
 * Time + 32 random bits make collisions practically impossible while
 * staying within Paystack's reference constraints.
 */
function generateReference() {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `VP-${timePart}-${randomPart}`;
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
 * @param {string} [params.subaccount] - Paystack subaccount code (e.g.
 *        ACCT_xxxxxxxxxxxx). When set, Paystack automatically splits every
 *        settlement between the subaccount and the main account, so merchants
 *        like merchants with a configured subaccount get automatic split settlement (98%/2%).
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
  subaccount,
  plan,
  channels,
  recurring,
  mandate_type,
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
  if (plan) payload.plan = plan;
  if (Array.isArray(channels) && channels.length > 0) payload.channels = channels;
  // Paystack subaccount → automatic split settlement (e.g. 98%/2%).
  if (subaccount) payload.subaccount = subaccount;
  if (merchant || phone || recurring || mandate_type) {
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
    if (recurring) {
      payload.metadata.recurring = true;
    }
    if (mandate_type) {
      payload.metadata.mandate_type = mandate_type;
    }
  }

  console.log('[PAYSTACK] Initializing payment ->', {
    reference: payload.reference,
    amount: payload.amount,
    currency: payload.currency,
    email: payload.email,
    merchant: merchant || null,
    subaccount: subaccount || null
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

/**
 * Charge an authorization code for a merchant-initiated recurring debit / standing mandate.
 * Uses Paystack's /transaction/charge_authorization endpoint.
 *
 * @param {object} params
 * @param {string} params.authorization_code - Reusable Paystack authorization code
 * @param {string} params.email - Customer email address
 * @param {number} params.amount - Major units (e.g. 50.00)
 * @param {string} [params.reference] - Unique transaction reference
 * @param {string} [params.currency='GHS'] - Currency code
 * @param {string} [params.subaccount] - Paystack subaccount code
 * @param {string} [params.merchant] - Merchant name
 * @param {object} [params.metadata] - Custom metadata
 * @param {string} [params.secretKey] - Tenant-specific Paystack secret key
 */
async function chargeAuthorizationWithKey({
  authorization_code,
  email,
  amount,
  reference,
  currency = 'GHS',
  subaccount,
  merchant,
  metadata = {},
  secretKey
}) {
  const key = secretKey || getSecretKey();
  if (!key) {
    const error = new Error('No Paystack secret key available for this tenant.');
    error.code = 'MISSING_SECRET_KEY';
    throw error;
  }

  const txReference = reference || generateReference();
  const payload = {
    authorization_code,
    email,
    amount: toSubunits(amount),
    reference: txReference,
    currency
  };

  if (subaccount) payload.subaccount = subaccount;

  payload.metadata = { ...metadata, custom_fields: [] };
  if (merchant) {
    payload.metadata.merchant = merchant;
    payload.metadata.custom_fields.push({
      display_name: 'Merchant',
      variable_name: 'merchant',
      value: merchant
    });
  }

  console.log('[PAYSTACK] Charging authorization ->', {
    reference: txReference,
    amount: payload.amount,
    currency: payload.currency,
    email: payload.email,
    authorization_code: `${String(authorization_code).slice(0, 8)}...`,
    merchant: merchant || null,
    subaccount: subaccount || null
  });

  const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/charge_authorization`, {
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
 * Charge an authorization using the global PAYSTACK_SECRET_KEY env var.
 * Kept for backward compatibility.
 */
async function chargeAuthorization(params) {
  return chargeAuthorizationWithKey(params);
}

module.exports = {
  PAYSTACK_BASE_URL,
  getSecretKey,
  toSubunits,
  generateReference,
  initializePayment,
  initializePaymentWithKey,
  verifyPayment,
  verifyPaymentWithKey,
  chargeAuthorization,
  chargeAuthorizationWithKey
};
