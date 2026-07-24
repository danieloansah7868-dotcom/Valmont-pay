export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get data from the request
  const { amount, email, reference } = req.body;

  // Validate required fields
  if (!amount || !email || !reference) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Call Paystack API to initialize payment
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: email,
        amount: amount * 100, // Paystack works in pesewas (kobo), so multiply by 100
        reference: reference,
        callback_url: `${process.env.VERCEL_URL || 'http://localhost:3000'}/payment-success`
      })
    });

    const data = await response.json();

    if (data.status) {
      // Success - return the payment URL
      return res.status(200).json({
        success: true,
        paymentUrl: data.data.authorization_url,
        reference: data.data.reference
      });
    } else {
      // Paystack returned an error
      return res.status(400).json({
        success: false,
        error: data.message || 'Failed to initialize payment'
      });
    }
  } catch (error) {
    console.error('Payment initialization error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}
