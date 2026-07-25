import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

function verifySignature(rawBody, signature, secretKey = process.env.PAYSTACK_SECRET_KEY) {
  if (!secretKey || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = req.body;
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.rawBody || JSON.stringify(event);

  if (process.env.PAYSTACK_SECRET_KEY) {
    if (!verifySignature(rawBody, signature)) {
      console.warn('[WEBHOOK] Rejected event with invalid signature.');
      return res.status(401).json({ status: false, message: 'Invalid signature' });
    }
  } else {
    console.warn('[WEBHOOK] PAYSTACK_SECRET_KEY not set — skipping signature verification.');
  }

  if (event.event === 'charge.success') {
    const data = event.data;
    const { error } = await supabase
      .from('transactions')
      .insert([{
        reference: data.reference,
        merchant_name: data.metadata?.merchant || 'Valmont-Pay',
        customer_email: data.customer?.email || data.email || 'unknown@customer',
        amount: typeof data.amount === 'number' ? data.amount / 100 : parseFloat(data.amount) || 0,
        payment_method: formatChannel(data.channel, data.authorization),
        status: 'SUCCESS',
        paid_at: data.paid_at || data.paidAt || new Date().toISOString()
      }]);

    if (error) {
      console.error('Failed to save transaction:', error);
      return res.status(500).json({ error: 'Failed to save transaction' });
    }

    console.log('Transaction saved:', data.reference);
  }

  if (event.event === 'charge.failed') {
    const data = event.data;
    const { error } = await supabase
      .from('transactions')
      .insert([{
        reference: data.reference,
        merchant_name: data.metadata?.merchant || 'Valmont-Pay',
        customer_email: data.customer?.email || data.email || 'unknown@customer',
        amount: typeof data.amount === 'number' ? data.amount / 100 : parseFloat(data.amount) || 0,
        payment_method: formatChannel(data.channel, data.authorization),
        status: 'FAILED'
      }]);

    if (error) {
      console.error('Failed to save failed transaction:', error);
    }
  }

  res.status(200).json({ received: true });
}
