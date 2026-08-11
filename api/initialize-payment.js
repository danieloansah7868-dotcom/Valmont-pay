import paystack from '../lib/paystack.js';
import baseUrlModule from '../lib/base-url.js';

const { initializePayment, generateReference } = paystack;
const { publicBaseUrl } = baseUrlModule;

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
  const { email, merchant, phone, callback_url: callbackUrl } = body;
  // Paystack subaccount (body or query) — enables split settlement (e.g. ACCT_... for automatic 98%/2% splits).
  const subaccount = body.subaccount || (req.query && req.query.subaccount);

  // The amount always comes from the request, never from a hardcoded default.
  const amount = parseFloat(body.amount);

  // Keep the caller's reference when supplied so the checkout page, our ledger
  // and Paystack all refer to the exact same transaction.
  const reference = body.reference || generateReference();

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
        `${baseUrl(req)}/pay.html?reference=${encodeURIComponent(reference)}` +
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
            ? `${baseUrl(req)}/pay.html?reference=${encodeURIComponent(data.data.reference)}&amount=${encodeURIComponent(amount)}&email=${encodeURIComponent(email)}&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
            : null,
          checkout_url: data.data.reference
            ? `${baseUrl(req)}/pay.html?reference=${encodeURIComponent(data.data.reference)}&amount=${encodeURIComponent(amount)}&email=${encodeURIComponent(email)}&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
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
