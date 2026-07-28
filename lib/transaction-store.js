/**
 * Shared transaction persistence helper.
 *
 * Every writer in this codebase (the dashboard checkout charge in server.js and
 * POST /api/transactions) funnels through here so a transaction row always has
 * EXACTLY the same shape in the database, and so a Supabase `{ error }` result
 * is never silently swallowed.
 *
 * The `transactions` table columns are, exactly:
 *
 *   reference       text  (unique — rows are upserted on this column)
 *   merchant_name   text
 *   customer_email  text
 *   amount          numeric
 *   payment_method  text
 *   status          text
 *   paid_at         timestamptz (null for anything that did not succeed)
 *
 * `updated_at` is deliberately NOT written: the deployed table does not have
 * that column, and sending it makes PostgREST reject the whole write with
 * PGRST204 ("Could not find the 'updated_at' column"), which is what made
 * successful checkouts never reach the dashboard.
 */

const {
  getSupabaseClient,
  supabaseConfigState,
  missingSupabaseEnvMessage
} = require('./supabase');

/** The one and only column list. Tests assert against this. */
const TRANSACTION_COLUMNS = Object.freeze([
  'reference',
  'merchant_name',
  'customer_email',
  'amount',
  'payment_method',
  'status',
  'paid_at'
]);

const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED']);

// Allows tests to inject a fake Supabase client without touching the network.
let clientOverride = null;

/** Test seam: inject (or clear, with null) the Supabase client used here. */
function setSupabaseClient(client) {
  clientOverride = client || null;
}

function resolveClient(explicitClient) {
  return explicitClient || clientOverride || getSupabaseClient();
}

function round2(value) {
  const numeric = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

function normalizeStatus(status) {
  return String(status || 'PENDING').toUpperCase();
}

function isSuccessStatus(status) {
  return SUCCESS_STATUSES.has(normalizeStatus(status));
}

/**
 * Map any internal/ledger-shaped transaction onto the exact database columns.
 * Accepts both the ledger field names (customer/channel/merchant/timestamp) and
 * the database field names, so callers can pass whichever they already hold.
 *
 * @returns {{reference:string, merchant_name:string, customer_email:string,
 *   amount:number, payment_method:string, status:string, paid_at:(string|null)}}
 */
function buildTransactionRecord(input = {}) {
  const status = normalizeStatus(input.status);
  const succeeded = isSuccessStatus(status);

  const paidAtSource =
    input.paid_at !== undefined && input.paid_at !== null
      ? input.paid_at
      : input.paidAt || input.timestamp || null;

  return {
    reference: input.reference == null ? '' : String(input.reference),
    merchant_name: String(input.merchant_name || input.merchant || 'Valmont-Pay'),
    customer_email: String(
      input.customer_email || input.customer || input.email || 'unknown@customer'
    ),
    amount: round2(input.amount),
    payment_method: String(input.payment_method || input.channel || 'N/A'),
    status,
    // Only a settled payment gets a paid_at timestamp.
    paid_at: succeeded ? paidAtSource || new Date().toISOString() : null
  };
}

/** Database row -> the shape dashboard.html renders. */
function toDashboardTransaction(row = {}) {
  return {
    reference: row.reference,
    customer: row.customer_email || row.customer || 'unknown@customer',
    customer_email: row.customer_email || row.customer || 'unknown@customer',
    amount: round2(row.amount),
    channel: row.payment_method || row.channel || 'N/A',
    payment_method: row.payment_method || row.channel || 'N/A',
    status: normalizeStatus(row.status),
    merchant: row.merchant_name || row.merchant || 'Valmont-Pay',
    merchant_name: row.merchant_name || row.merchant || 'Valmont-Pay',
    timestamp: row.paid_at || row.created_at || row.timestamp || null,
    paid_at: row.paid_at || null
  };
}

/** Postgres/PostgREST codes that mean "ON CONFLICT target is not usable". */
function isMissingUniqueConstraint(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '').toLowerCase();
  return (
    code === '42P10' ||
    message.includes('no unique or exclusion constraint') ||
    message.includes('on conflict specification')
  );
}

function describeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return error.message || error.details || error.hint || JSON.stringify(error);
}

/**
 * Persist one transaction. Upserts by `reference`, so replays (checkout charge
 * followed by a Paystack webhook, or a retried request) stay idempotent.
 *
 * NEVER throws and NEVER hides a Supabase `{ error }`: the caller receives
 * `{ ok:false, error }` and decides what to do about it.
 *
 * @returns {Promise<{ok:boolean, skipped:boolean, reason:(string|null),
 *   record:object, data:(object|null), error:(object|null)}>}
 */
async function saveTransaction(input, options = {}) {
  const record = buildTransactionRecord(input);
  const context = options.context || 'TRANSACTION';

  if (!record.reference) {
    const error = { message: 'A transaction reference is required' };
    console.error(`[${context}] Refusing to persist a transaction without a reference`, record);
    return { ok: false, skipped: false, reason: 'missing-reference', record, data: null, error };
  }

  const client = resolveClient(options.client);
  if (!client) {
    const reason = missingSupabaseEnvMessage() || 'Supabase client is not available';
    console.error(`[${context}] Cannot persist ${record.reference} — ${reason}`, {
      supabase: supabaseConfigState()
    });
    return {
      ok: false,
      skipped: true,
      reason,
      record,
      data: null,
      error: { message: reason }
    };
  }

  console.log(`[${context}] Persisting transaction to Supabase:`, record);

  let result;
  try {
    result = await client
      .from('transactions')
      .upsert(record, { onConflict: 'reference' })
      .select();
  } catch (thrown) {
    console.error(`[${context}] Supabase upsert threw for ${record.reference}:`, thrown);
    return {
      ok: false,
      skipped: false,
      reason: 'exception',
      record,
      data: null,
      error: { message: thrown && thrown.message ? thrown.message : String(thrown) }
    };
  }

  console.log(`[${context}] Supabase upsert result for ${record.reference}:`, result);

  // Some deployments never added the UNIQUE(reference) constraint that
  // `onConflict` needs. Fall back to a plain insert rather than losing the row.
  if (result && result.error && isMissingUniqueConstraint(result.error)) {
    console.warn(
      `[${context}] transactions.reference has no unique constraint — retrying as a plain insert`,
      result.error
    );
    try {
      result = await client.from('transactions').insert([record]).select();
      console.log(`[${context}] Supabase insert fallback result for ${record.reference}:`, result);
    } catch (thrown) {
      console.error(`[${context}] Supabase insert fallback threw for ${record.reference}:`, thrown);
      return {
        ok: false,
        skipped: false,
        reason: 'exception',
        record,
        data: null,
        error: { message: thrown && thrown.message ? thrown.message : String(thrown) }
      };
    }
  }

  if (result && result.error) {
    console.error(`[${context}] Supabase rejected ${record.reference}:`, result.error);
    return {
      ok: false,
      skipped: false,
      reason: describeError(result.error),
      record,
      data: null,
      error: result.error
    };
  }

  const rows = result && Array.isArray(result.data) ? result.data : result && result.data ? [result.data] : [];
  console.log(`[${context}] Transaction saved: ${record.reference} (${record.status})`);
  return { ok: true, skipped: false, reason: null, record, data: rows[0] || record, error: null };
}

/**
 * Read every persisted transaction, newest first, already mapped into the
 * dashboard's expected shape. Read errors are surfaced, never swallowed.
 *
 * @returns {Promise<{ok:boolean, skipped:boolean, reason:(string|null),
 *   transactions:Array<object>, error:(object|null)}>}
 */
async function fetchTransactions(options = {}) {
  const context = options.context || 'TRANSACTIONS';
  const client = resolveClient(options.client);

  if (!client) {
    const reason = missingSupabaseEnvMessage() || 'Supabase client is not available';
    console.error(`[${context}] Cannot read transactions — ${reason}`, {
      supabase: supabaseConfigState()
    });
    return { ok: false, skipped: true, reason, transactions: [], error: { message: reason } };
  }

  let result;
  try {
    result = await client
      .from('transactions')
      .select('*')
      .order('paid_at', { ascending: false, nullsFirst: false });
  } catch (thrown) {
    console.error(`[${context}] Supabase read threw:`, thrown);
    return {
      ok: false,
      skipped: false,
      reason: 'exception',
      transactions: [],
      error: { message: thrown && thrown.message ? thrown.message : String(thrown) }
    };
  }

  if (result && result.error) {
    console.error(`[${context}] Supabase read error:`, result.error);
    return {
      ok: false,
      skipped: false,
      reason: describeError(result.error),
      transactions: [],
      error: result.error
    };
  }

  const rows = Array.isArray(result && result.data) ? result.data : [];
  console.log(`[${context}] Loaded ${rows.length} transaction(s) from Supabase`);
  return {
    ok: true,
    skipped: false,
    reason: null,
    transactions: rows.map(toDashboardTransaction),
    error: null
  };
}

/** Balance = the sum of every SUCCESSFUL transaction, rounded to 2dp. */
function calculateBalance(transactions = []) {
  return round2(
    transactions
      .filter(t => isSuccessStatus(t && t.status))
      .reduce((total, t) => total + (parseFloat(t && t.amount) || 0), 0)
  );
}

/** The payload shape both /api/transactions implementations return. */
function buildLedgerPayload(transactions = []) {
  const sorted = [...transactions].sort((a, b) => {
    const left = Date.parse((a && a.timestamp) || '') || 0;
    const right = Date.parse((b && b.timestamp) || '') || 0;
    return right - left;
  });

  return {
    balance: calculateBalance(sorted),
    currency: 'GHS',
    count: sorted.length,
    successful: sorted.filter(t => isSuccessStatus(t && t.status)).length,
    transactions: sorted
  };
}

module.exports = {
  TRANSACTION_COLUMNS,
  buildTransactionRecord,
  toDashboardTransaction,
  saveTransaction,
  fetchTransactions,
  calculateBalance,
  buildLedgerPayload,
  isSuccessStatus,
  normalizeStatus,
  round2,
  setSupabaseClient
};
