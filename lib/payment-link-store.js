/**
 * Durable payment-link store.
 *
 * ── The problem this solves ─────────────────────────────────────────────
 * The dashboard's "Generate link" button creates a pay.html?access_code=…
 * URL whose details live ONLY in the in-memory access-code store
 * (lib/access-code-store.js). On Vercel that memory belongs to one warm
 * serverless instance: a customer who opens the link 10 minutes later —
 * after a cold start or on a different instance — got "Payment Link
 * Invalid". Links also hard-expired after 30 minutes. A payment link you
 * WhatsApp to a client must outlive all of that.
 *
 * ── The design ──────────────────────────────────────────────────────────
 * Supabase is the durable source of truth (table `payment_links`, created
 * by scripts/supabase-payment-links-schema.sql). The in-memory store stays
 * as a hot cache and as the local-development fallback when Supabase is not
 * configured.
 *
 *   persistPaymentLink()  — write-through: memory (caller) + Supabase upsert.
 *   resolvePaymentLink()  — memory first, Supabase fallback, then hot-cache
 *                           rehydration so repeat opens are fast.
 *
 * Two TTL classes:
 *   - Link TTL (default 30 days, PAYMENT_LINK_TTL_HOURS): for links a
 *     merchant generates and sends to a client.
 *   - Session TTL (accessCodeStore.EXPIRY_MS, 30 min): for tenant API
 *     checkout sessions — durability across cold starts within the same
 *     session window, without changing the documented 30-minute contract
 *     in docs/tenant-integration.md.
 *
 * Errors NEVER throw: every failure returns { ok: false, reason, error } so
 * the caller decides whether persistence is mandatory (dashboard links:
 * yes — a link we cannot guarantee durable must not be handed out) or
 * best-effort (tenant sessions: a Paystack authorization_url fallback
 * exists).
 */

const { getSupabaseClient, isSupabaseConfigured } = require('./supabase');
const accessCodeStore = require('./access-code-store');

/** Test/DI hook: an explicitly injected client wins over the env-built one. */
let injectedClient = null;

/**
 * Inject a Supabase client (or a stub, in tests). Pass null to clear it and
 * go back to the lazily created client from lib/supabase.js.
 */
function setSupabaseClient(client) {
  injectedClient = client || null;
  return injectedClient;
}

/** Resolve the client to use: explicit option → injected → env-built. */
function resolveClient(explicitClient) {
  return explicitClient || injectedClient || getSupabaseClient();
}

const TABLE = 'payment_links';

/** Checkout links a merchant sends to a client live this long. */
const DEFAULT_LINK_TTL_HOURS = 24 * 30; // 30 days

/** Exact columns written to the payment_links table (fixed whitelist). */
const ROW_COLUMNS = [
  'access_code',
  'reference',
  'amount',
  'currency',
  'email',
  'phone',
  'callback_url',
  'tenant_key',
  'merchant_display_name',
  'merchant_brand_color',
  'merchant_logo_url',
  'paystack_authorization_url',
  'paystack_access_code',
  'status',
  'created_at',
  'expires_at'
];

/** Manual payment-link TTL (ms). Configurable; defaults to 30 days. */
function linkTtlMs() {
  const hours = Number(process.env.PAYMENT_LINK_TTL_HOURS);
  if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 3600 * 1000);
  return DEFAULT_LINK_TTL_HOURS * 3600 * 1000;
}

function round2(value) {
  const number = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100) / 100;
}

/** Map the access-code payment shape onto a payment_links row. */
function paymentToRow(accessCode, payment, ttlMs, nowIso) {
  const amount = round2(payment.amount);
  if (!accessCode || !payment.reference || amount === null) {
    return null;
  }

  const row = {
    access_code: String(accessCode),
    reference: String(payment.reference),
    amount,
    currency: payment.currency || 'GHS',
    email: payment.email || null,
    phone: payment.phone || null,
    callback_url: payment.callback_url || null,
    tenant_key: payment.tenant_key || null,
    merchant_display_name: payment.merchant_display_name || null,
    merchant_brand_color: payment.merchant_brand_color || null,
    merchant_logo_url: payment.merchant_logo_url || null,
    paystack_authorization_url: payment.paystack_authorization_url || null,
    paystack_access_code: payment.paystack_access_code || null,
    status: 'PENDING',
    created_at: nowIso,
    expires_at: new Date(Date.parse(nowIso) + ttlMs).toISOString()
  };

  // Whitelist: only declared columns ever leave this process.
  const clean = {};
  for (const column of ROW_COLUMNS) clean[column] = row[column];
  return clean;
}

/** Map a payment_links row back onto the access-code payment shape. */
function rowToPayment(row) {
  if (!row) return null;
  return {
    access_code: row.access_code,
    amount: Number(row.amount),
    reference: row.reference,
    currency: row.currency || 'GHS',
    email: row.email || '',
    phone: row.phone || '',
    callback_url: row.callback_url || '',
    tenant_key: row.tenant_key || null,
    merchant_display_name: row.merchant_display_name || '',
    merchant_brand_color: row.merchant_brand_color || '#f68b1e',
    merchant_logo_url: row.merchant_logo_url || '/logo.svg',
    paystack_authorization_url: row.paystack_authorization_url || '',
    paystack_access_code: row.paystack_access_code || ''
  };
}

/**
 * Durably persist a payment link / checkout session.
 *
 * @param {object} args
 * @param {string} args.accessCode
 * @param {object} args.payment      - the access-code-store payment shape.
 * @param {number} args.ttlMs        - lifetime for this row.
 * @param {object} [args.client]     - injected Supabase client (tests).
 * @returns {Promise<{ok:boolean, durable:boolean, reason?:string, error?:any, expiresAt?:string}>}
 */
async function persistPaymentLink({ accessCode, payment, ttlMs, client }) {
  const row = paymentToRow(accessCode, payment || {}, ttlMs || linkTtlMs(), new Date().toISOString());
  if (!row) {
    return { ok: false, durable: false, reason: 'invalid-payment-data' };
  }

  if (!isSupabaseConfigured() && !resolveClient(client)) {
    // Local development without Supabase: the in-memory store (already
    // written by the caller) is the whole story. Not an error — but the
    // caller must not pretend the link is durable.
    return { ok: true, durable: false, reason: 'supabase-not-configured', expiresAt: row.expires_at };
  }

  const resolvedClient = resolveClient(client);
  if (!resolvedClient) {
    return { ok: false, durable: false, reason: 'supabase-client-unavailable' };
  }

  try {
    const { error } = await resolvedClient
      .from(TABLE)
      .upsert(row, { onConflict: 'access_code' });

    if (error) {
      const reason = /payment_links|schema cache|PGRST205|42P01/i.test(String(error.message || error))
        ? 'payment_links-table-missing'
        : 'supabase-upsert-rejected';
      return { ok: false, durable: false, reason, error, expiresAt: row.expires_at };
    }

    return { ok: true, durable: true, expiresAt: row.expires_at };
  } catch (error) {
    return { ok: false, durable: false, reason: 'supabase-upsert-threw', error };
  }
}

/**
 * Resolve an access_code to its payment details: memory → Supabase.
 * Supabase hits rehydrate the in-memory cache so repeat opens are cheap.
 * Expired rows resolve to null (caller renders "link expired").
 *
 * @param {string} accessCode
 * @param {object} [options]
 * @param {object} [options.client] - injected Supabase client (tests).
 * @returns {Promise<{payment:object|null, source:'memory'|'supabase'|'none', expired?:boolean}>}
 */
async function resolvePaymentLink(accessCode, options = {}) {
  if (!accessCode) return { payment: null, source: 'none' };

  // Hot path: still warm in this instance's memory.
  const memoryHit = accessCodeStore.peekAccessCode(accessCode);
  if (memoryHit) return { payment: memoryHit, source: 'memory' };

  const client = resolveClient(options.client) || null;
  if (!client) return { payment: null, source: 'memory' };

  let data = null;
  try {
    const result = await client
      .from(TABLE)
      .select('*')
      .eq('access_code', String(accessCode))
      .single();
    data = result && result.data ? result.data : null;
    if (result && result.error) {
      // PGRST116 = "0 rows" for .single() — a plain miss, not an error.
      const code = result.error.code || '';
      if (code !== 'PGRST116' && !/0 rows|JSON object requested/i.test(String(result.error.message))) {
        console.error('[PAYMENT-LINKS] resolve failed:', result.error.message || result.error);
      }
    }
  } catch (error) {
    console.error('[PAYMENT-LINKS] resolve threw:', error && error.message ? error.message : error);
    return { payment: null, source: 'supabase' };
  }

  if (!data) return { payment: null, source: 'supabase' };

  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) {
    return { payment: null, source: 'supabase', expired: true };
  }

  const payment = rowToPayment(data);

  // Rehydrate the hot cache. NOTE: the in-memory entry carries the
  // access-code store's own 30-minute TTL, so long-lived links fall back
  // to Supabase again after half an hour of idle time — by design, the
  // database row (with its own expires_at) stays authoritative.
  try {
    accessCodeStore.createAccessCode(payment);
  } catch (_) {
    // Cache rehydration is best-effort; the DB read already succeeded.
  }

  return { payment, source: 'supabase' };
}

module.exports = {
  TABLE,
  ROW_COLUMNS,
  DEFAULT_LINK_TTL_HOURS,
  linkTtlMs,
  paymentToRow,
  rowToPayment,
  persistPaymentLink,
  resolvePaymentLink,
  setSupabaseClient
};
