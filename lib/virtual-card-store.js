/**
 * Virtual Card store — MoMo-direct Valmont Pay cards.
 *
 * ── Two modes ─────────────────────────────────────────────────────────
 * 1. CLOSED-LOOP (Phase 1, today): card is internal-only, works on any
 *    Valmont Pay merchant checkout. No external license. balance_ghs is
 *    the source of truth. Card number is a Valmont BIN (4832 46..) and
 *    authorization is checked against this store, not Visa.
 *
 * 2. REAL VISA (Phase 2, via partner): card is issued by Strowallet /
 *    Maplerad / Flutterwave. We store provider_card_id + provider meta,
 *    and funding calls the provider's top-up API. The local balance
 *    mirrors the provider balance.
 *
 * ── Persistence ───────────────────────────────────────────────────────
 * Supabase tables (when configured): `virtual_cards` + `virtual_card_transactions`
 * + `virtual_wallets`. See scripts/supabase-virtual-cards-schema.sql.
 * In-memory Maps are hot cache + local-dev fallback.
 *
 * Every function returns { ok, ... } and never throws.
 */

const crypto = require('crypto');
const { getSupabaseClient, isSupabaseConfigured } = require('./supabase');

let injectedClient = null;
const cards = new Map(); // id -> card
const wallets = new Map(); // customer_email(lower) -> { balance_ghs, balance_usd }
const cardTx = new Map(); // cardId -> [tx]

function setSupabaseClient(client) {
  injectedClient = client || null;
  return injectedClient;
}
function resolveClient(explicit) {
  return explicit || injectedClient || getSupabaseClient();
}
function clearInMemory() {
  cards.clear();
  wallets.clear();
  cardTx.clear();
}

// ── helpers ───────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function genId() {
  return 'vc_' + crypto.randomBytes(8).toString('hex');
}

function genPan() {
  // Valmont test BIN 4832 46 — Luhn valid, but NOT a real Visa routing number.
  // Phase 2 replaces this with the provider-issued PAN.
  const bin = '483246';
  let partial = bin;
  for (let i = 0; i < 9; i++) partial += Math.floor(Math.random() * 10);
  // Luhn check digit
  let sum = 0, dbl = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = parseInt(partial[i], 10);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  const check = (10 - (sum % 10)) % 10;
  const pan = partial + String(check);
  // format 4-4-4-4
  return pan.replace(/(.{4})/g, '$1 ').trim();
}

function genExpiry() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 3);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${yy}`;
}
function genCvv() {
  return String(100 + Math.floor(Math.random() * 900));
}
function maskPan(pan) {
  const digits = String(pan).replace(/\s/g, '');
  return '•••• •••• •••• ' + digits.slice(-4);
}
function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}
function round2(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// Approx rate used for GHS→USD display. Real funding uses live FX or provider rate.
const DEFAULT_FX_GHS_PER_USD = 15.8;
function fxRate() {
  const r = parseFloat(process.env.VIRTUAL_CARD_FX_RATE);
  if (Number.isFinite(r) && r > 0) return r;
  return DEFAULT_FX_GHS_PER_USD;
}

// ── wallet ────────────────────────────────────────────────────────────
function getWallet(email) {
  const key = normalizeEmail(email);
  if (!key) return { balance_ghs: 0, balance_usd: 0, email: '' };
  if (!wallets.has(key)) wallets.set(key, { email: key, balance_ghs: 0, balance_usd: 0, updated_at: nowIso() });
  return wallets.get(key);
}

async function topUpWallet(email, amountGhs, options = {}) {
  const key = normalizeEmail(email);
  if (!key) return { ok: false, reason: 'customer_email is required' };
  const amt = round2(amountGhs);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'amount must be > 0' };

  const w = getWallet(key);
  w.balance_ghs = round2(w.balance_ghs + amt);
  w.balance_usd = round2(w.balance_ghs / fxRate());
  w.updated_at = nowIso();

  // persist wallet if supabase available
  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      await client.from('virtual_wallets').upsert({
        customer_email: key,
        balance_ghs: w.balance_ghs,
        balance_usd: w.balance_usd,
        updated_at: w.updated_at
      }, { onConflict: 'customer_email' });
    } catch (e) {
      // non-fatal: in-memory is source of truth for MVP
      console.warn('[VIRTUAL-CARD] wallet upsert failed:', e.message || e);
    }
  }

  return { ok: true, wallet: { ...w } };
}

// ── card record ───────────────────────────────────────────────────────
function buildCardRecord(input) {
  const email = normalizeEmail(input.customer_email || input.email);
  if (!email) return null;
  const pan = input.pan || genPan();
  return {
    id: input.id || genId(),
    customer_email: email,
    holder_name: String(input.holder_name || input.holderName || email.split('@')[0] || 'Valmont User').slice(0, 48),
    pan,
    pan_masked: maskPan(pan),
    last4: String(pan).replace(/\s/g, '').slice(-4),
    expiry: input.expiry || genExpiry(),
    cvv: input.cvv || genCvv(),
    currency: (String(input.currency || 'USD').toUpperCase() === 'GHS' ? 'GHS' : 'USD'),
    balance_ghs: round2(input.balance_ghs || 0),
    balance_usd: round2(input.balance_usd || 0),
    status: String(input.status || 'active').toLowerCase(), // active|frozen|terminated
    spending_limit_usd: input.spending_limit_usd != null ? round2(input.spending_limit_usd) : null,
    tenant_key: input.tenant_key || null,
    provider: input.provider || 'internal', // internal | strowallet | maplerad
    provider_card_id: input.provider_card_id || null,
    provider_meta: input.provider_meta || null,
    created_at: input.created_at || nowIso(),
    updated_at: nowIso()
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────
async function createVirtualCard(input, options = {}) {
  const record = buildCardRecord(input || {});
  if (!record) return { ok: false, reason: 'customer_email is required' };

  // funding at creation is optional
  if (input.initial_funding_ghs) {
    const init = round2(input.initial_funding_ghs);
    if (init > 0) {
      if (record.currency === 'GHS') record.balance_ghs = init;
      else record.balance_usd = round2(init / fxRate());
      record.balance_ghs = round2(record.balance_ghs || init);
      if (!record.balance_usd) record.balance_usd = round2(init / fxRate());
    }
  } else {
    // ensure usd mirrors ghs
    if (record.balance_ghs && !record.balance_usd) record.balance_usd = round2(record.balance_ghs / fxRate());
    if (record.balance_usd && !record.balance_ghs) record.balance_ghs = round2(record.balance_usd * fxRate());
  }

  cards.set(record.id, record);
  if (!cardTx.has(record.id)) cardTx.set(record.id, []);

  // Supabase persist
  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      const { error } = await client.from('virtual_cards').upsert({
        id: record.id,
        customer_email: record.customer_email,
        holder_name: record.holder_name,
        pan_masked: record.pan_masked,
        last4: record.last4,
        expiry: record.expiry,
        currency: record.currency,
        balance_ghs: record.balance_ghs,
        balance_usd: record.balance_usd,
        status: record.status,
        spending_limit_usd: record.spending_limit_usd,
        tenant_key: record.tenant_key,
        provider: record.provider,
        provider_card_id: record.provider_card_id,
        created_at: record.created_at,
        updated_at: record.updated_at
        // NOTE: full PAN/CVV are NEVER persisted durably in MVP; provider vault holds them in Phase 2.
      }, { onConflict: 'id' });
      if (error) console.warn('[VIRTUAL-CARD] supabase upsert failed:', error.message || error);
    } catch (e) {
      console.warn('[VIRTUAL-CARD] supabase upsert threw:', e.message || e);
    }
  }

  return { ok: true, card: sanitizeForClient(record, { reveal: Boolean(input.reveal) }) , raw: record };
}

function sanitizeForClient(record, opts = {}) {
  const reveal = Boolean(opts.reveal);
  return {
    id: record.id,
    customer_email: record.customer_email,
    holder_name: record.holder_name,
    pan: reveal ? record.pan : record.pan_masked,
    pan_masked: record.pan_masked,
    last4: record.last4,
    expiry: record.expiry,
    cvv: reveal ? record.cvv : '•••',
    currency: record.currency,
    balance_ghs: record.balance_ghs,
    balance_usd: record.balance_usd,
    fx_rate: fxRate(),
    status: record.status,
    spending_limit_usd: record.spending_limit_usd,
    provider: record.provider,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

async function getVirtualCard(id, options = {}) {
  const key = String(id || '').trim();
  if (!key) return null;
  if (cards.has(key)) return cards.get(key);
  // try supabase
  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      const { data, error } = await client.from('virtual_cards').select('*').eq('id', key).limit(1);
      if (!error && data && data.length) {
        const row = data[0];
        // rehydrate minimal record (PAN not stored durably, so masked only)
        const rec = {
          id: row.id,
          customer_email: row.customer_email,
          holder_name: row.holder_name,
          pan: row.pan_masked,
          pan_masked: row.pan_masked,
          last4: row.last4,
          expiry: row.expiry,
          cvv: '•••',
          currency: row.currency,
          balance_ghs: Number(row.balance_ghs) || 0,
          balance_usd: Number(row.balance_usd) || 0,
          status: row.status,
          spending_limit_usd: row.spending_limit_usd,
          tenant_key: row.tenant_key,
          provider: row.provider || 'internal',
          provider_card_id: row.provider_card_id || null,
          created_at: row.created_at,
          updated_at: row.updated_at
        };
        cards.set(key, rec);
        return rec;
      }
    } catch (_) {}
  }
  return null;
}

async function listVirtualCards(filters = {}, options = {}) {
  const email = normalizeEmail(filters.customer_email || filters.email);
  const status = filters.status ? String(filters.status).toLowerCase() : null;

  // prefer supabase when configured and email filter present
  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      let q = client.from('virtual_cards').select('*').order('created_at', { ascending: false });
      if (email) q = q.eq('customer_email', email);
      if (status) q = q.eq('status', status);
      if (filters.tenant_key) q = q.eq('tenant_key', String(filters.tenant_key));
      const { data, error } = await q;
      if (!error && Array.isArray(data)) {
        // hydrate cache
        for (const row of data) {
          const rec = {
            id: row.id,
            customer_email: row.customer_email,
            holder_name: row.holder_name,
            pan: row.pan_masked,
            pan_masked: row.pan_masked,
            last4: row.last4,
            expiry: row.expiry,
            cvv: '•••',
            currency: row.currency,
            balance_ghs: Number(row.balance_ghs) || 0,
            balance_usd: Number(row.balance_usd) || 0,
            status: row.status,
            spending_limit_usd: row.spending_limit_usd,
            tenant_key: row.tenant_key,
            provider: row.provider || 'internal',
            provider_card_id: row.provider_card_id,
            created_at: row.created_at,
            updated_at: row.updated_at
          };
          cards.set(rec.id, rec);
        }
        let out = data.map(r => {
          const rec = cards.get(r.id);
          return sanitizeForClient(rec);
        });
        return { ok: true, cards: out };
      }
    } catch (e) {
      console.warn('[VIRTUAL-CARD] list supabase failed, falling back to memory:', e.message || e);
    }
  }

  // memory fallback
  let out = Array.from(cards.values());
  if (email) out = out.filter(c => c.customer_email === email);
  if (status) out = out.filter(c => c.status === status);
  if (filters.tenant_key) out = out.filter(c => c.tenant_key === String(filters.tenant_key));
  out.sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { ok: true, cards: out.map(c => sanitizeForClient(c)) };
}

async function updateCard(id, patch, options = {}) {
  const rec = await getVirtualCard(id, options);
  if (!rec) return { ok: false, reason: 'Card not found', status: 404 };
  if (rec.status === 'terminated') return { ok: false, reason: 'Card is terminated and cannot be modified', status: 409 };

  if (patch.status) {
    const s = String(patch.status).toLowerCase();
    if (!['active','frozen','terminated'].includes(s)) return { ok: false, reason: 'Invalid status', status: 400 };
    rec.status = s;
  }
  if (patch.spending_limit_usd !== undefined) {
    if (patch.spending_limit_usd === null || patch.spending_limit_usd === '') rec.spending_limit_usd = null;
    else {
      const lim = round2(patch.spending_limit_usd);
      if (!Number.isFinite(lim) || lim <= 0) return { ok: false, reason: 'spending_limit_usd must be > 0 or null', status: 400 };
      rec.spending_limit_usd = lim;
    }
  }
  if (patch.balance_ghs !== undefined || patch.balance_usd !== undefined) {
    // internal only — not exposed via public API, used by fund flow
    if (patch.balance_ghs !== undefined) rec.balance_ghs = round2(patch.balance_ghs);
    if (patch.balance_usd !== undefined) rec.balance_usd = round2(patch.balance_usd);
  }
  rec.updated_at = nowIso();
  cards.set(rec.id, rec);

  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      await client.from('virtual_cards').update({
        status: rec.status,
        spending_limit_usd: rec.spending_limit_usd,
        balance_ghs: rec.balance_ghs,
        balance_usd: rec.balance_usd,
        updated_at: rec.updated_at
      }).eq('id', rec.id);
    } catch (e) {
      console.warn('[VIRTUAL-CARD] update supabase failed:', e.message || e);
    }
  }
  return { ok: true, card: sanitizeForClient(rec) };
}

// ── funding ───────────────────────────────────────────────────────────
async function fundCard(id, amountGhs, meta = {}, options = {}) {
  const rec = await getVirtualCard(id, options);
  if (!rec) return { ok: false, reason: 'Card not found', status: 404 };
  if (rec.status === 'terminated') return { ok: false, reason: 'Card is terminated', status: 409 };
  if (rec.status === 'frozen') return { ok: false, reason: 'Card is frozen — unfreeze before funding', status: 409 };

  const amt = round2(amountGhs);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'amount must be > 0', status: 400 };
  if (amt < 10) return { ok: false, reason: 'Minimum funding is GH₵ 10', status: 400 };

  const rate = fxRate();
  const usd = round2(amt / rate);

  // Phase 2 hook: if provider is not internal, call provider top-up API here.
  // For MVP we just credit locally. Provider integration is a single function
  // swap — see docs/virtual-cards.md.
  if (rec.provider !== 'internal') {
    // TODO: call Strowallet/Maplerad top-up. On success, mirror provider balance.
    console.log(`[VIRTUAL-CARD] provider funding stub for ${rec.provider} card ${rec.id}: GH₵${amt} → $${usd}`);
  }

  rec.balance_ghs = round2(rec.balance_ghs + amt);
  rec.balance_usd = round2(rec.balance_usd + usd);
  rec.updated_at = nowIso();
  cards.set(rec.id, rec);

  // record transaction
  const tx = {
    id: 'vctx_' + crypto.randomBytes(6).toString('hex'),
    card_id: rec.id,
    type: 'funding',
    amount_ghs: amt,
    amount_usd: usd,
    fx_rate: rate,
    momo_number: meta.momo_number || meta.phone || null,
    reference: meta.reference || ('VC-FUND-' + Date.now()),
    status: 'success',
    created_at: nowIso()
  };
  if (!cardTx.has(rec.id)) cardTx.set(rec.id, []);
  cardTx.get(rec.id).unshift(tx);

  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      await client.from('virtual_cards').update({
        balance_ghs: rec.balance_ghs,
        balance_usd: rec.balance_usd,
        updated_at: rec.updated_at
      }).eq('id', rec.id);
      // best-effort tx log
      await client.from('virtual_card_transactions').insert({
        id: tx.id,
        card_id: tx.card_id,
        type: tx.type,
        amount_ghs: tx.amount_ghs,
        amount_usd: tx.amount_usd,
        fx_rate: tx.fx_rate,
        momo_number: tx.momo_number,
        reference: tx.reference,
        status: tx.status,
        created_at: tx.created_at
      });
    } catch (e) {
      console.warn('[VIRTUAL-CARD] fund supabase persist failed:', e.message || e);
    }
  }

  return { ok: true, card: sanitizeForClient(rec), transaction: tx, fx_rate: rate };
}

async function spendCard(id, amountUsd, meta = {}, options = {}) {
  const rec = await getVirtualCard(id, options);
  if (!rec) return { ok: false, reason: 'Card not found', status: 404 };
  if (rec.status !== 'active') return { ok: false, reason: `Card is ${rec.status}`, status: 409 };

  const amt = round2(amountUsd);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'amount must be > 0', status: 400 };
  if (rec.spending_limit_usd && amt > rec.spending_limit_usd) {
    return { ok: false, reason: `Amount exceeds per-transaction limit of $${rec.spending_limit_usd}`, status: 400 };
  }
  if (rec.balance_usd < amt) return { ok: false, reason: 'Insufficient card balance', status: 402 };

  const ghs = round2(amt * fxRate());
  rec.balance_usd = round2(rec.balance_usd - amt);
  rec.balance_ghs = round2(rec.balance_ghs - ghs);
  if (rec.balance_ghs < 0) rec.balance_ghs = 0;
  rec.updated_at = nowIso();
  cards.set(rec.id, rec);

  const tx = {
    id: 'vctx_' + crypto.randomBytes(6).toString('hex'),
    card_id: rec.id,
    type: 'purchase',
    amount_ghs: ghs,
    amount_usd: amt,
    fx_rate: fxRate(),
    merchant: meta.merchant || 'Online Purchase',
    reference: meta.reference || ('VC-SPEND-' + Date.now()),
    status: 'success',
    created_at: nowIso()
  };
  if (!cardTx.has(rec.id)) cardTx.set(rec.id, []);
  cardTx.get(rec.id).unshift(tx);

  const client = resolveClient(options.client);
  if (client && isSupabaseConfigured()) {
    try {
      await client.from('virtual_cards').update({
        balance_ghs: rec.balance_ghs,
        balance_usd: rec.balance_usd,
        updated_at: rec.updated_at
      }).eq('id', rec.id);
      await client.from('virtual_card_transactions').insert({
        id: tx.id,
        card_id: tx.card_id,
        type: tx.type,
        amount_ghs: tx.amount_ghs,
        amount_usd: tx.amount_usd,
        fx_rate: tx.fx_rate,
        merchant: tx.merchant,
        reference: tx.reference,
        status: tx.status,
        created_at: tx.created_at
      });
    } catch (e) {
      console.warn('[VIRTUAL-CARD] spend persist failed:', e.message || e);
    }
  }

  return { ok: true, card: sanitizeForClient(rec), transaction: tx };
}

async function getCardTransactions(id, options = {}) {
  const rec = await getVirtualCard(id, options);
  if (!rec) return { ok: false, reason: 'Card not found', status: 404 };
  let list = cardTx.get(id) || [];
  // try supabase if local is empty
  if (!list.length) {
    const client = resolveClient(options.client);
    if (client && isSupabaseConfigured()) {
      try {
        const { data, error } = await client.from('virtual_card_transactions').select('*').eq('card_id', id).order('created_at', { ascending: false }).limit(50);
        if (!error && Array.isArray(data) && data.length) {
          list = data;
          cardTx.set(id, list);
        }
      } catch (_) {}
    }
  }
  return { ok: true, transactions: list };
}

module.exports = {
  DEFAULT_FX_GHS_PER_USD,
  fxRate,
  maskPan,
  getWallet,
  topUpWallet,
  createVirtualCard,
  getVirtualCard,
  listVirtualCards,
  updateCard,
  fundCard,
  spendCard,
  getCardTransactions,
  sanitizeForClient,
  setSupabaseClient,
  clearInMemory,
  // expose for tests
  _cards: cards,
  _wallets: wallets,
  _cardTx: cardTx
};
