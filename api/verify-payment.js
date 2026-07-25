import paystack from '../lib/paystack.js';

const { verifyPayment } = paystack;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing transaction reference' });
  }

  console.log('Reference:', reference);

  try {
    const data = await verifyPayment(reference);

    const paystackTrx = data && data.data ? data.data : null;

    // Surface a simple, flattened summary alongside the raw Paystack payload so
    // the frontend does not have to dig through the response shape.
    return res.status(200).json({
      ...data,
      success: Boolean(data && data.status && paystackTrx && paystackTrx.status === 'success'),
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
        : null
    });
  } catch (error) {
    console.error('Payment verification error for reference', reference, error);

    if (error.code === 'MISSING_SECRET_KEY') {
      return res.status(500).json({
        status: false,
        message: 'Payment provider is not configured. Set PAYSTACK_SECRET_KEY.'
      });
    }

    return res.status(500).json({ status: false, message: 'Internal server error' });
  }
}
