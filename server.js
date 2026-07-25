const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

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
  const { email, amount, callback_url } = req.body;
  
  if (!email || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ status: false, message: 'Invalid transaction details.' });
  }

  const reference = `VP-${Math.floor(100000 + Math.random() * 900000)}`;
  const newTransaction = {
    reference,
    customer: email,
    amount: parseFloat(amount),
    channel: 'PENDING',
    status: 'PENDING',
    callback_url: callback_url || null,
    timestamp: new Date().toISOString()
  };

  TRANSACTIONS.unshift(newTransaction);
  console.log(`[LEDGER] Transaction Initialized: Ref ${reference} | Amount GHS ${amount}`);

  // Return a secure checkout URL hosted on this gateway server
  res.status(200).json({
    status: true,
    message: 'Transaction initialized successfully',
    data: {
      reference,
      checkout_url: `http://localhost:${PORT}/checkout.html?reference=${reference}`
    }
  });
});

// API 2: Process Charge (Simulates MoMo USSD Prompt or Card Tokenization)
app.post('/api/v1/transaction/charge', (req, res) => {
  const { reference, channel, wallet_number, card_number } = req.body;

  const trx = TRANSACTIONS.find(t => t.reference === reference);
  if (!trx) {
    return res.status(404).json({ status: false, message: 'Transaction reference not found.' });
  }

  if (trx.status !== 'PENDING') {
    return res.status(400).json({ status: false, message: 'Transaction has already been processed.' });
  }

  trx.channel = channel;
  
  // Simulated Processing Delay & Random Outcomes (85% success rate for MoMo)
  const isSuccessful = Math.random() > 0.15;
  
  setTimeout(() => {
    if (isSuccessful) {
      trx.status = 'SUCCESS';
      MERCHANT_BALANCE += trx.amount; // Add settled funds to merchant account
      console.log(`[SETTLEMENT] Trans Ref ${reference} CLEARED successfully! Balance added.`);
      res.status(200).json({ status: true, message: 'Charge successful', reference, trx_status: 'SUCCESS' });
    } else {
      trx.status = 'FAILED';
      console.log(`[LEDGER] Trans Ref ${reference} DECLINED by network.`);
      res.status(200).json({ status: false, message: 'Transaction declined by mobile wallet operator.', reference, trx_status: 'FAILED' });
    }
  }, 3500); // 3.5 second simulated USSD prompt delay
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
