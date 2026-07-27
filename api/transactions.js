import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default async function handler(req, res) {
  // Handle GET - fetch transactions
  if (req.method === 'GET') {
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch transactions:', error);
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }

    // Map Supabase fields to the format the dashboard expects
    const mapped = transactions.map(t => ({
      reference: t.reference,
      customer: t.customer_email,
      amount: t.amount,
      channel: t.payment_method || 'N/A',
      status: t.status,
      merchant: t.merchant_name,
      timestamp: t.paid_at || t.created_at
    }));

    return res.status(200).json(mapped);
  }

  // Handle POST - record/save a transaction
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { reference, customer, amount, channel, status, merchant } = body;

    if (!reference) {
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    // Upsert transaction to Supabase
    const { data, error } = await supabase
      .from('transactions')
      .upsert({
        reference,
        customer_email: customer || null,
        amount: parseFloat(amount) || 0,
        payment_method: channel || 'N/A',
        status: status || 'PENDING',
        merchant_name: merchant || 'Valmont-Pay',
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'reference'
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to save transaction:', error);
      return res.status(500).json({ success: false, error: 'Failed to save transaction' });
    }

    return res.status(200).json({ success: true, data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
