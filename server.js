const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { initializePayment, verifyPayment, generateReference } = require('./lib/paystack');

const app = express();
const PORT = process.env.PORT || 3000;

// Build absolute URLs from the incoming request instead of hardcoding the
// production domain, so links work locally AND on Vercel.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// Enable Cross-Origin Resource Sharing & JSON Parsing
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// IN-MEMORY TRANSACTION DATABASE & BALANCE (Our Ledger)
let MERCHANT_BALANCE = 12450.00; // Starting virtual balance in GHS
const TRANSACTIONS = [
  {
    reference: 'VP-849201',
    customer: 'kofi.mensah@gmail.com',
    amount: 4500.00,
    channel: 'Mobile Money (MTN)',
    status: 'SUCCESS',
    timestamp: new Date(Date.now() - 24 * 3600 * 1000).toISOString() // 1 day ago
  },
  {
    reference: 'VP-582910',
    customer: 'ama.gh@yahoo.com',
    amount: 1250.00,
    channel: 'Mobile Money (Telecel)',
    status: 'SUCCESS',
    timestamp: new Date(Date.now() - 6 * 3600 * 1000).toISOString() // 6 hours ago
  },
  {
    reference: 'VP-128491',
    customer: 'abena.boateng@outlook.com',
    amount: 6700.00,
    channel: 'Credit/Debit Card',
    status: 'FAILED',
    timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString() // 2 hours ago
  }
];

// API 1: Initialize Transaction
app.post('/api/v1/transaction/initialize', (req, res) => {
  const { email, amount, callback_url, merchant } = req.body;
  
  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ status: false, message: 'Invalid transaction details.' });
  }

  const reference = generateReference();
  const origin = baseUrl(req);
  const newTransaction = {
    reference,
    customer: email,
    amount: parseFloat(amount),
    channel: 'PENDING',
    status: 'PENDING',
    merchant: merchant || 'Valmont-Pay',
    callback_url: callback_url || `${origin}/checkout.html`,
    timestamp: new Date().toISOString()
  };

  TRANSACTIONS.unshift(newTransaction);
  console.log(`[LEDGER] Transaction Initialized: Ref ${reference} | Merchant ${newTransaction.merchant} | Amount GHS ${newTransaction.amount}`);

  // Return a secure checkout URL hosted on this gateway server.
  // The reference, real amount, email and merchant are all carried through.
  res.status(200).json({
    status: true,
    message: 'Transaction initialized successfully',
    data: {
      reference,
      amount: newTransaction.amount,
      merchant: newTransaction.merchant,
      callback_url: newTransaction.callback_url,
      checkout_url: `${origin}/checkout.html?reference=${encodeURIComponent(reference)}` +
        `&amount=${encodeURIComponent(newTransaction.amount)}` +
        `&email=${encodeURIComponent(email)}` +
        `&merchant=${encodeURIComponent(newTransaction.merchant)}`
    }
  });
});

// API 2: Process Charge (Simulates MoMo USSD Prompt or Card Tokenization)
app.post('/api/v1/transaction/charge', (req, res) => {
  const { reference, channel, wallet_number, card_number, amount } = req.body;

  let trx = TRANSACTIONS.find(t => t.reference === reference);

  // Issue 3 fix: a checkout opened directly by reference (e.g. after a Paystack
  // redirect) used to 404 here and surface as "Transaction Failed". Register the
  // transaction on the fly instead of rejecting it.
  if (!trx && reference) {
    trx = {
      reference,
      customer: req.body.email || 'unknown@customer',
      amount: parseFloat(amount) || 0,
      channel: 'PENDING',
      status: 'PENDING',
      merchant: req.body.merchant || 'Valmont-Pay',
      timestamp: new Date().toISOString()
    };
    TRANSACTIONS.unshift(trx);
  }

  if (!trx) {
    return res.status(404).json({ status: false, message: 'Transaction reference not found.' });
  }

  if (trx.status !== 'PENDING') {
    return res.status(400).json({ status: false, message: 'Transaction has already been processed.' });
  }

  // Keep the ledger amount in sync with what the customer actually confirmed
  const confirmedAmount = parseFloat(amount);
  if (!isNaN(confirmedAmount) && confirmedAmount > 0) {
    trx.amount = confirmedAmount;
  }

  trx.channel = channel || 'Unknown';

  const isCard = /card/i.test(trx.channel);
  const digits = String(isCard ? card_number || '' : wallet_number || '').replace(/\D/g, '');

  // Issue 3 fix: outcomes are now deterministic instead of a random 15% decline,
  // so a valid test card / test wallet always clears.
  let declineReason = null;
  if (isCard) {
    if (digits.length < 12) declineReason = 'Invalid card number. Please check and try again.';
    // Paystack's documented "declined" test card
    else if (digits === '4084080000000409') declineReason = 'Card declined by issuer.';
  } else if (digits.length < 9) {
    declineReason = 'Invalid mobile money number. Please check and try again.';
  }

  setTimeout(() => {
    if (!declineReason) {
      trx.status = 'SUCCESS';
      MERCHANT_BALANCE += trx.amount; // Add settled funds to merchant account
      console.log(`[SETTLEMENT] Trans Ref ${reference} CLEARED for GHS ${trx.amount}! Balance added.`);
      res.status(200).json({
        status: true,
        message: 'Charge successful',
        reference,
        amount: trx.amount,
        trx_status: 'SUCCESS'
      });
    } else {
      trx.status = 'FAILED';
      console.log(`[LEDGER] Trans Ref ${reference} DECLINED: ${declineReason}`);
      res.status(200).json({ status: false, message: declineReason, reference, trx_status: 'FAILED' });
    }
  }, 2000); // simulated USSD prompt delay
});

// API 3: Verify Transaction Status
app.get('/api/v1/transaction/verify/:reference', (req, res) => {
  const { reference } = req.params;
  const trx = TRANSACTIONS.find(t => t.reference === reference);
  
  if (!trx) {
    return res.status(404).json({ status: false, message: 'Transaction reference not found.' });
  }

  res.status(200).json({
    status: true,
    message: 'Transaction verified',
    data: {
      reference: trx.reference,
      customer: trx.customer,
      amount: trx.amount,
      channel: trx.channel,
      status: trx.status,
      timestamp: trx.timestamp
    }
  });
});

// API 3b: Paystack-backed endpoints (same contract as the /api serverless
// functions, so local development and Vercel behave identically).
app.post('/api/initialize-payment', async (req, res) => {
  const { email, merchant, callback_url } = req.body || {};
  const amount = parseFloat(req.body && req.body.amount);
  const reference = (req.body && req.body.reference) || generateReference();

  if (!email || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
  }

  console.log('Reference:', reference);

  try {
    const data = await initializePayment({
      amount,
      email,
      reference,
      merchant,
      callback_url:
        callback_url ||
        `${baseUrl(req)}/checkout.html?reference=${encodeURIComponent(reference)}` +
          `&merchant=${encodeURIComponent(merchant || 'Valmont-Pay')}`
    });

    if (data.status) {
      return res.status(200).json({
        success: true,
        paymentUrl: data.data.authorization_url,
        reference: data.data.reference || reference,
        amount
      });
    }
    return res.status(400).json({ success: false, error: data.message || 'Failed to initialize payment' });
  } catch (error) {
    console.error('Payment initialization error:', error.message);
    const missingKey = error.code === 'MISSING_SECRET_KEY';
    return res.status(500).json({
      success: false,
      error: missingKey ? 'Payment provider is not configured. Set PAYSTACK_SECRET_KEY.' : 'Internal server error'
    });
  }
});

app.get('/api/verify-payment', async (req, res) => {
  const { reference } = req.query;
  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing transaction reference' });
  }

  console.log('Reference:', reference);

  try {
    const data = await verifyPayment(reference);
    return res.status(200).json(data);
  } catch (error) {
    console.error('Payment verification error:', error.message);
    const missingKey = error.code === 'MISSING_SECRET_KEY';
    return res.status(500).json({
      status: false,
      message: missingKey ? 'Payment provider is not configured. Set PAYSTACK_SECRET_KEY.' : 'Internal server error'
    });
  }
});

// API 4: Get Ledger and Account Balance (For Dashboard)
app.get('/api/v1/merchant/dashboard', (req, res) => {
  res.status(200).json({
    status: true,
    data: {
      balance: MERCHANT_BALANCE,
      currency: 'GHS',
      transactions: TRANSACTIONS
    }
  });
});

// Serve frontend web routes
app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
});

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'checkout.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'pay.html'));
});

app.get('/pay.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'pay.html'));
});

// Start the Payment Gateway server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 VALMONT-PAY CORE GATEWAY STARTED LIVE!`);
  console.log(`🔗 API Base URL: http://localhost:${PORT}`);
  console.log(`📈 Merchant Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`======================================================\n`);
});
