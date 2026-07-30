/**
 * SINGLE SOURCE OF TRUTH for the Supabase `transactions` table.
 *
 * Every writer in this codebase goes through this module — the dashboard
 * checkout (POST /api/v1/transaction/charge in server.js), the Paystack webhook
 * (api/webhook.js), the verify-payment safety net (api/verify-payment.js), the
 * debug/manual endpoints and POST /api/transactions. Keeping the column mapping
 * in exactly one place is what stops those paths from drifting apart and
 * writing different shapes into the same table.
 *
 * CommonJS on purpose: server.js `require()`s it, and the ESM serverless
 * functions under /api default-import it.
 *
 * ── The table contract ────────────────────────────────────────────────────
 *
 *   reference       text, UNIQUE  → rows are UPSERTED on this column, so
 *                                   Paystack retries and webhook/verify races
 *                                   are idempotent instead of duplicating.
 *   merchant_name   text          → defaults to 'Valmont-Pay'
 *   customer_email  text          → defaults to 'unknown@customer'
 *   amount          numeric(12,2) → GH₵, rounded to 2dp (NEVER pesewas)
 *   payment_method  text          → e.g. 'Momo (MTN)', 'Credit/Debit Card'
 *   status          text          → SUCCESS / FAILED / PENDING (upper-cased)
 *   paid_at         timestamptz   → set for settled payments, null otherwise
 *
 * ⚠️  Those seven columns are the ENTIRE payload. In particular the deployed
 * table has no `updated at` column, and PostgREST rejects the *whole* write
 * with PGRST204 when it is sent — which is precisely why successful checkouts
 * once never appeared on the dashboard. buildTransactionRecord() therefore
 * constructs the row from a fixed whitelist rather than spreading caller input,
 * so no stray field can ever reach the table. scripts/checkout-supabase-test.mjs
 * enforces this statically.
 *
 * Errors are NEVER swallowed. A Supabase/RLS rejection comes back as
 * `{ ok: false, reason, error }` so the caller can fail loudly, instead of an
 * empty dashboard that looks like "no sales yet".
 */

const { getSupabaseClient, isSupabaseConfigured, missingSupabaseEnvMessage } = require('./supabase');

/** The exact columns written to `transactions`, in order. */
const TRANSACTION_COLUMNS = [
  'reference',
  'merchant_name',
  'customer_email',
  'amount',
  'payment_method',
  'status',
  'paid_at'
];

/** Statuses that mean money actually settled. */
const SUCCESS_STATUSES = ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'];

const DEFAULT_MERCHANT = 'Valmont-Pay';
const DEFAULT_CUSTOMER = 'unknown@customer';

/** Test/DI hook: an explicitly injected client wins over the env-built one. */
let injectedClient = null;

/**
 * Inject a Supabase client (or a stub, in tests). Pass null to clear it and go
 * back to the lazily created client from lib/supabase.js.
 */
function setSupabaseClient(client) {
  injectedClient = client || null;
  return injectedClient;
}

/** Resolve the client to use: explicit option → injected → env-built. */
function resolveClient(explicitClient) {
  return explicitClient || injectedClient || getSupabaseClient();
}

/** Round to 2dp; GH₵ amounts are never fractions of a pesewa. */
function round2(value) {
  const number = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function normalizeStatus(status) {
  return String(status || 'PENDING').toUpperCase();
}

/** Did this transaction settle? Only settled rows carry a paid_at / balance. */
function isSuccessfulStatus(status) {
  return SUCCESS_STATUSES.includes(normalizeStatus(status));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

/**
 * Map ANY of the shapes used around the codebase onto the seven table columns.
 *
 * Accepts both the internal/ledger shape (`merchant`, `customer`, `channel`,
 * `timestamp`) and the already-mapped table shape (`merchant_name`,
 * `customer_email`, `payment_method`, `paid_at`), so callers can hand over
 * whichever they happen to hold.
 *
 * Returns EXACTLY the seven columns — never a spread of the input.
 */
function buildTransactionRecord(input) {
  const source = input || {};
  const status = normalizeStatus(source.status);
  const settled = isSuccessfulStatus(status);

  const timestamp = firstNonEmpty(source.paid_at, source.timestamp, source.paidAt);

  return {
    reference: firstNonEmpty(source.reference) || null,
    merchant_name: firstNonEmpty(source.merchant_name, source.merchant) || DEFAULT_MERCHANT,
    customer_email:
      firstNonEmpty(source.customer_email, source.customer, source.email) || DEFAULT_CUSTOMER,
    amount: round2(source.amount),
    payment_method: firstNonEmpty(source.payment_method, source.channel) || 'Unknown',
    status,
    // Settled payments carry a timestamp; everything else is explicitly null so
    // a FAILED/PENDING row can never look like it was paid.
    paid_at: settled ? timestamp || new Date().toISOString() : null
  };
}

/** Turn a Supabase row back into the shape dashboard.html renders. */
function toDashboardTransaction(row) {
  const source = row || {};
  return {
    reference: source.reference,
    merchant: firstNonEmpty(source.merchant_name, source.merchant) || DEFAULT_MERCHANT,
    customer: firstNonEmpty(source.customer_email, source.customer) || DEFAULT_CUSTOMER,
    amount: round2(source.amount),
    channel: firstNonEmpty(source.payment_method, source.channel) || 'Unknown',
    status: normalizeStatus(source.status),
    timestamp: source.paid_at || source.timestamp || source.created_at || null
  };
}

/** Settled balance: the sum of SUCCESSFUL rows only, to 2dp. */
function calculateBalance(transactions) {
  const rows = Array.isArray(transactions) ? transactions : [];
  return round2(
    rows
      .filter(t => isSuccessfulStatus(t && t.status))
      .reduce((total, t) => total + (parseFloat(t && t.amount) || 0), 0)
  );
}

/** The payload shape the dashboard and /api/transactions return. */
function buildLedgerPayload(transactions) {
  const rows = Array.isArray(transactions) ? transactions : [];
  return {
    balance: calculateBalance(rows),
    currency: 'GHS',
    count: rows.length,
    successful: rows.filter(t => isSuccessfulStatus(t && t.status)).length,
    transactions: rows
  };
}

/** Normalize whatever Supabase returned into a single row (or null). */
function firstRow(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data.length ? data[0] : null;
  return data;
}

/** Turn a Supabase error object into a readable single-line reason. */
function describeError(error) {
  if (!error) return 'Unknown Supabase error';
  const parts = [error.message, error.details, error.hint].filter(Boolean);
  const text = parts.join(' — ');
  return text || JSON.stringify(error);
}

/**
 * Upsert a transaction into Supabase, keyed on `reference`.
 *
 * @param {object} input            loose or table-shaped transaction
 * @param {object} [options]
 * @param {object} [options.client] Supabase client override (DI/tests)
 * @param {string} [options.context] label used in logs, e.g. 'CHECKOUT'
 * @returns {Promise<{ok:boolean, record:object, data:object|null,
 *                    error:object|null, reason:string|null, skipped:boolean}>}
 *
 * Never throws — every failure path is reported through the return value so a
 * caller can decide whether to 500 the request.
 */
async function saveTransaction(input, options = {}) {
  const context = options.context || 'TRANSACTION-STORE';
  const record = buildTransactionRecord(input);

  const fail = (reason, error = null, skipped = false) => {
    console.error(`[${context}] Supabase write failed for ${record.reference || '(no reference)'}: ${reason}`);
    return { ok: false, record, data: null, error, reason, skipped };
  };

  // A row without a reference cannot be upserted (the conflict target) and
  // would break idempotency, so reject it before touching the network.
  if (!record.reference) {
    return fail('A transaction reference is required');
  }

  if (!isSupabaseConfigured()) {
    return fail(missingSupabaseEnvMessage() || 'Supabase is not configured', null, true);
  }

  const client = resolveClient(options.client);
  if (!client) {
    return fail('Supabase client is not available', null, true);
  }

  let data;
  let error;
  try {
    ({ data, error } = await client
      .from('transactions')
      .upsert(record, { onConflict: 'reference' })
      .select());
  } catch (thrown) {
    return fail(thrown && thrown.message ? thrown.message : String(thrown), thrown);
  }

  // An RLS denial or a missing column comes back HERE, as a returned error
  // rather than a rejection. Ignoring it is what silently loses payments.
  if (error) {
    return fail(describeError(error), error);
  }

  const row = firstRow(data);
  console.log(`[${context}] Saved ${record.reference} (${record.status}) to Supabase`);
  return { ok: true, record, data: row, error: null, reason: null, skipped: false };
}

/**
 * Read every transaction, newest first, already mapped into the dashboard shape.
 *
 * @returns {Promise<{ok:boolean, transactions:Array, rows:Array,
 *                    error:object|null, reason:string|null}>}
 *
 * A read error is reported as `ok: false` — never as an innocent empty list,
 * which would render as "no transactions yet" and hide a broken deployment.
 */
async function fetchTransactions(options = {}) {
  const context = options.context || 'TRANSACTION-STORE';

  const fail = (reason, error = null) => {
    console.error(`[${context}] Supabase read failed: ${reason}`);
    return { ok: false, transactions: [], rows: [], error, reason };
  };

  if (!isSupabaseConfigured()) {
    return fail(missingSupabaseEnvMessage() || 'Supabase is not configured');
  }

  const client = resolveClient(options.client);
  if (!client) {
    return fail('Supabase client is not available');
  }

  let data;
  let error;
  try {
    ({ data, error } = await client
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false }));
  } catch (thrown) {
    return fail(thrown && thrown.message ? thrown.message : String(thrown), thrown);
  }

  if (error) {
    return fail(describeError(error), error);
  }

  const rows = Array.isArray(data) ? data : [];
  return {
    ok: true,
    transactions: rows.map(toDashboardTransaction),
    rows,
    error: null,
    reason: null
  };
}

module.exports = {
  TRANSACTION_COLUMNS,
  SUCCESS_STATUSES,
  buildTransactionRecord,
  toDashboardTransaction,
  buildLedgerPayload,
  calculateBalance,
  saveTransaction,
  fetchTransactions,
  setSupabaseClient,
  isSuccessfulStatus
};
