import paystack from '../lib/paystack.js';
import baseUrlModule from '../lib/base-url.js';
import paymentLinkStore from '../lib/payment-link-store.js';
import legacyLinkPolicy from '../lib/legacy-link-policy.js';
import tenantRegistry from '../lib/tenants.js';

const { initializePayment, generateReference } = paystack;
const { publicBaseUrl } = baseUrlModule;
const { resolvePaymentLink } = paymentLinkStore;
const { legacyAmountUrlAllowed, legacyRejectionPayload, refererIsLegacyAmountUrl } = legacyLinkPolicy;

// Build absolute URLs from the incoming request. The (allowlisted) request
// host always wins over PUBLIC_BASE_URL so a stale env var can never send
// customers to a dead domain (see lib/base-url.js).
function baseUrl(req) {
  return publicBaseUrl(req);
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Get data from the request (Vercel parses JSON bodies, but be defensive)
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { email, phone, callback_url: callbackUrl } = body;
  let merchant = body.merchant;
  // Paystack subaccount (body or query) — enables split settlement (e.g. ACCT_... for automatic 98%/2% splits).
  let subaccount = body.subaccount || (req.query && req.query.subaccount);

  // The amount always comes from the request, never from a hardcoded default.
  let amount = parseFloat(body.amount);

  // Keep the caller's reference when supplied so the checkout page, our ledger
  // and Paystack all refer to the exact same transaction.
  let reference = body.reference || generateReference();

  // ─── AMOUNT AUTHORITY ─────────────────────────────────────────────
  // body.amount is NOT gospel — it comes from a browser that may have
  // read it out of the address bar.
  //
  //   1. access_code present → the stored payment intent wins. Amount,
  //      reference and merchant are re-read from it and the body values
  //      are ignored, so editing ?amount= on an access-code URL cannot
  //      change what is charged.
  //   2. No access_code but the request came from a legacy
  //      pay.html?amount=… page → refuse, unless the operator set
  //      ALLOW_LEGACY_AMOUNT_URL=1 on this deployment.
  //
  // See lib/legacy-link-policy.js and docs/tenant-integration.md § 3.
  // ──────────────────────────────────────────────────────────────────
  const accessCode = typeof body.access_code === 'string' ? body.access_code.trim() : '';

  if (accessCode) {
    const resolved = await resolvePaymentLink(accessCode);
    const intent = resolved && resolved.payment;
    if (!intent) {
      return res.status(404).json({
        success: false,
        code: 'ACCESS_CODE_INVALID',
        error: 'This payment link is invalid or has expired. Ask the merchant for a new link.'
      });
    }

    const storedAmount = parseFloat(intent.amount);
    if (!Number.isFinite(storedAmount) || storedAmount <= 0) {
      return res.status(409).json({
        success: false,
        code: 'ACCESS_CODE_AMOUNT_MISSING',
        error: 'The stored payment intent has no usable amount. Ask the merchant for a new link.'
      });
    }

    if (Number.isFinite(amount) && Math.round(amount * 100) !== Math.round(storedAmount * 100)) {
      console.warn(
        `[INIT-PAYMENT] Ignoring client amount ${amount} for access_code ${accessCode}; ` +
        `charging the stored ${storedAmount}.`
      );
    }

    amount = storedAmount;
    reference = intent.reference || reference;
    merchant = intent.tenant_key || intent.merchant_display_name || merchant;
    const intentTenant = tenantRegistry.getTenant(intent.tenant_key);
    subaccount = subaccount || (intentTenant && intentTenant.paystack_subaccount) || undefined;
  } else if (
    !legacyAmountUrlAllowed() &&
    refererIsLegacyAmountUrl(req.headers && req.headers.referer)
  ) {
    console.warn(
      '[INIT-PAYMENT] Refused a legacy unsigned pay.html request. ' +
      `referer=${req.headers.referer} amount=${body.amount} merchant=${body.merchant || 'unknown'}`
    );
    return res.status(403).json(legacyRejectionPayload());
  }

  // Validate required fields
  if (!email || !reference) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }

  // Issue 3: always log the reference we are about to send to Paystack.
  console.log('Reference:', reference);
  console.log('Amount (GHS):', amount, '-> pesewas:', Math.round(amount * 100));

  try {
    // Call Paystack API to initialize payment.
    // The helper forwards `reference` and multiplies the amount by 100.
    // `subaccount` (when present) enables Paystack split settlement (e.g. ACCT_... for automatic 98%/2% splits).
    const data = await initializePayment({
      amount,
      email,
      reference,
      merchant,
      phone,
      subaccount,
      callback_url:
        callbackUrl ||
        `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(reference)}` +
          `&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
    });

    if (data.status) {
      // Success - return the payment URL with all necessary params for checkout
      return res.status(200).json({
        success: true,
        paymentUrl: data.data.authorization_url,
        accessCode: data.data.access_code,
        // Echo back the reference Paystack accepted so the client can verify it later
        reference: data.data.reference || reference,
        amount,
        merchant: merchant || 'Valmont-Pay',
        // Include checkout_url with all params so the client has everything it needs
        data: {
          reference: data.data.reference || reference,
          amount,
          merchant: merchant || 'Valmont-Pay',
          callback_url: data.data.reference
            ? `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(data.data.reference)}&amount=${encodeURIComponent(amount)}&email=${encodeURIComponent(email)}&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
            : null,
          checkout_url: data.data.reference
            ? `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(data.data.reference)}&amount=${encodeURIComponent(amount)}&email=${encodeURIComponent(email)}&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
            : data.data.authorization_url
        }
      });
    }

    // Paystack returned an error
    console.error('[PAYSTACK] Initialization rejected for', reference, '->', data.message);
    return res.status(400).json({
      success: false,
      reference,
      error: data.message || 'Failed to initialize payment'
    });
  } catch (error) {
    console.error('Payment initialization error for reference', reference, error);

    if (error.code === 'MISSING_SECRET_KEY') {
      return res.status(500).json({
        success: false,
        error: 'Payment provider is not configured. Set PAYSTACK_SECRET_KEY.'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}
