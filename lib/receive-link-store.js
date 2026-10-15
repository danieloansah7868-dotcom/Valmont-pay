/**
 * Receive Links — "Pay Me" directly to your MoMo or Bank.
 *
 * A receiver (you) creates a link that says where money should land:
 *   - MoMo:  0544000000 (MTN/Telecel/AT) → instant via Paystack Transfer API
 *   - Bank:  GCB 1234567890 or Paystack subaccount ACCT_… → T+1 settlement
 *   - Any entitled account: the receiver names the settlement destination
 *
 * Payer opens the link, pays via MoMo / Card / Bank Transfer through
 * Paystack (same engine as pay.html), funds land directly to the
 * entitled account — Valmont Pay never holds the money.
 *
 * Persistence: Supabase `receive_links` when configured, else in-memory.
 * Used same pattern as payment_link_store / virtual_card_store.
 */

const crypto = require('crypto');
const { getSupabaseClient, isSupabaseConfigured } = require('./supabase');

let injectedClient = null;
const mem = new Map(); // code -> record

function setSupabaseClient(c) { injectedClient = c || null; return injectedClient; }
function resolveClient(explicit) { return explicit || injectedClient || getSupabaseClient(); }
function clearInMemory() { mem.clear(); }

function genCode() { return 'rv_' + crypto.randomBytes(8).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function round2(v){ const n=typeof v==='number'?v:parseFloat(v); if(!Number.isFinite(n)) return null; return Math.round(n*100)/100; }

function buildRecord(input) {
  const receiver_email = String(input.receiver_email || input.email || '').trim().toLowerCase();
  if (!receiver_email || !receiver_email.includes('@')) return null;
  const destination_type = String(input.destination_type || 'momo').toLowerCase(); // momo | bank | subaccount
  if (!['momo','bank','subaccount'].includes(destination_type)) return null;

  let destination = '';
  if (destination_type === 'momo') destination = String(input.momo_number || input.phone || '').trim();
  else if (destination_type === 'bank') destination = String(input.bank_account || input.destination || '').trim();
  else destination = String(input.subaccount || input.destination || '').trim();
  if (!destination) return null;

  const amount = input.amount != null && String(input.amount).trim() !== '' ? round2(input.amount) : null;
  // null = "let payer choose", otherwise fixed

  return {
    code: input.code || genCode(),
    receiver_email,
    receiver_name: String(input.receiver_name || receiver_email.split('@')[0]).slice(0,60),
    destination_type,
    destination, // phone or bank string or ACCT_...
    amount, // null or number
    currency: 'GHS',
    note: String(input.note || '').slice(0,280),
    status: 'active',
    created_at: input.created_at || nowIso(),
    expires_at: input.expires_at || new Date(Date.now() + 30*24*3600*1000).toISOString(), // 30 days
  };
}

async function createReceiveLink(input, options={}) {
  const rec = buildRecord(input);
  if (!rec) return { ok:false, reason:'Valid receiver_email and destination (momo_number / bank_account / subaccount) are required.' };
  mem.set(rec.code, rec);

  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      const { error } = await client.from('receive_links').upsert({
        code: rec.code,
        receiver_email: rec.receiver_email,
        receiver_name: rec.receiver_name,
        destination_type: rec.destination_type,
        destination: rec.destination,
        amount: rec.amount,
        currency: rec.currency,
        note: rec.note,
        status: rec.status,
        created_at: rec.created_at,
        expires_at: rec.expires_at
      }, { onConflict:'code' });
      if (error) console.warn('[RECEIVE] supabase upsert failed:', error.message);
    } catch(e){ console.warn('[RECEIVE] supabase threw:', e.message); }
  }
  return { ok:true, record: rec };
}

async function getReceiveLink(code, options={}) {
  const k = String(code||'').trim();
  if (!k) return null;
  if (mem.has(k)) return mem.get(k);
  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      const { data, error } = await client.from('receive_links').select('*').eq('code', k).limit(1);
      if (!error && data && data.length) {
        const r = data[0];
        const rec = {
          code: r.code,
          receiver_email: r.receiver_email,
          receiver_name: r.receiver_name,
          destination_type: r.destination_type,
          destination: r.destination,
          amount: r.amount != null ? Number(r.amount) : null,
          currency: r.currency || 'GHS',
          note: r.note || '',
          status: r.status || 'active',
          created_at: r.created_at,
          expires_at: r.expires_at
        };
        mem.set(k, rec);
        return rec;
      }
    } catch(_){}
  }
  return null;
}

async function listReceiveLinks(filter={}, options={}) {
  const email = String(filter.receiver_email||filter.email||'').toLowerCase().trim();
  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      let q = client.from('receive_links').select('*').order('created_at',{ascending:false}).limit(50);
      if (email) q = q.eq('receiver_email', email);
      const { data, error } = await q;
      if (!error && Array.isArray(data)) {
        for (const r of data) {
          mem.set(r.code, {
            code:r.code, receiver_email:r.receiver_email, receiver_name:r.receiver_name,
            destination_type:r.destination_type, destination:r.destination,
            amount: r.amount!=null?Number(r.amount):null, currency:r.currency||'GHS',
            note:r.note||'', status:r.status||'active', created_at:r.created_at, expires_at:r.expires_at
          });
        }
        const list = data.map(r=>({
          code:r.code, receiver_email:r.receiver_email, receiver_name:r.receiver_name,
          destination_type:r.destination_type, destination:r.destination,
          amount: r.amount!=null?Number(r.amount):null, currency:r.currency||'GHS',
          note:r.note||'', status:r.status||'active', created_at:r.created_at, expires_at:r.expires_at
        }));
        return { ok:true, links: email?list.filter(l=>l.receiver_email===email):list };
      }
    } catch(e){ console.warn('[RECEIVE] list supabase failed:', e.message); }
  }
  let list = Array.from(mem.values());
  if (email) list = list.filter(r=>r.receiver_email===email);
  list.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  return { ok:true, links: list };
}

module.exports = { buildRecord, createReceiveLink, getReceiveLink, listReceiveLinks, setSupabaseClient, clearInMemory, _mem: mem };
