import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  res.status(200).json(mapped);
}
