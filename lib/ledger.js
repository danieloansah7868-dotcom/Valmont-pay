/**
 * Shared in-memory transaction ledger.
 *
 * This is the process-local view of transactions. It is intentionally simple:
 * a single array, shared by reference, so server.js and lib/webhook.js observe
 * exactly the same rows.
 *
 * IMPORTANT: this store is per-instance and NOT durable. On Vercel it dies with
 * the request/lambda, which is why every writer also persists through
 * lib/transaction-store.js into Supabase. Treat this as a fast cache for the
 * lifetime of one process, never as the source of truth.
 *
 * The ledger starts EMPTY — no seeded demo rows, no fake starting balance. The
 * settled balance is always derived by summing SUCCESSFUL transactions.
 */

/** Statuses that represent money that has actually settled. */
const SUCCESS_STATUSES = ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'];

/**
 * The live rows. Exported by reference because server.js aliases it
 * (`const TRANSACTIONS = ledger.TRANSACTIONS`) and mutates rows in place, so it
 * must never be reassigned — only emptied with `length = 0`.
 */
const TRANSACTIONS = [];

/** Round to 2dp so 0.1 + 0.2 sums to 0.3, not 0.30000000000000004. */
function round2(value) {
  const number = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function normalizeStatus(status) {
  return String(status || 'PENDING').toUpperCase();
}

function isSuccessful(transaction) {
  return SUCCESS_STATUSES.includes(normalizeStatus(transaction && transaction.status));
}

/** Build a normalized ledger row from a loose input object. */
function normalizeTransaction(input) {
  const source = input || {};
  const transaction = {
    reference: source.reference,
    customer: source.customer || source.customer_email || source.email || 'unknown@customer',
    amount: round2(source.amount),
    channel: source.channel || source.payment_method || 'Unknown',
    status: normalizeStatus(source.status),
    merchant: source.merchant || source.merchant_name || 'Valmont-Pay',
    timestamp: source.timestamp || source.paid_at || new Date().toISOString()
  };

  // Carry through optional fields (callback_url, tenant_key, currency,
  // gateway_response, paid_at, ...) without letting them clobber the
  // normalized ones above.
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key in transaction) continue;
    transaction[key] = value;
  }

  return transaction;
}

/** Find a transaction by reference. Returns the LIVE object, not a copy. */
function findTransaction(reference) {
  if (!reference) return null;
  return TRANSACTIONS.find(t => t.reference === reference) || null;
}

/**
 * Append a transaction. Returns the stored row.
 * If the reference already exists it is updated instead of duplicated, which
 * keeps the ledger idempotent under retries.
 */
function addTransaction(input) {
  const transaction = normalizeTransaction(input);
  const existing = findTransaction(transaction.reference);
  if (existing) return upsertTransaction(input);
  TRANSACTIONS.push(transaction);
  return transaction;
}

/**
 * Insert or update a transaction by reference.
 *
 * Only fields that are actually provided overwrite what is already stored, so a
 * status-only update (e.g. `{ reference, status: 'SUCCESS' }`) keeps the amount,
 * customer and channel captured at initialization time.
 *
 * Mutates the existing row in place so callers holding a reference to it (like
 * the checkout settlement timer in server.js) observe the change.
 */
function upsertTransaction(input) {
  const source = input || {};
  const existing = findTransaction(source.reference);

  if (!existing) {
    const transaction = normalizeTransaction(source);
    TRANSACTIONS.push(transaction);
    return transaction;
  }

  if (source.customer || source.customer_email || source.email) {
    existing.customer = source.customer || source.customer_email || source.email;
  }
  if (source.amount !== undefined && source.amount !== null && source.amount !== '') {
    existing.amount = round2(source.amount);
  }
  if (source.channel || source.payment_method) {
    existing.channel = source.channel || source.payment_method;
  }
  if (source.status) {
    existing.status = normalizeStatus(source.status);
  }
  if (source.merchant || source.merchant_name) {
    existing.merchant = source.merchant || source.merchant_name;
  }
  if (source.timestamp || source.paid_at) {
    existing.timestamp = source.timestamp || source.paid_at;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (['reference', 'customer', 'customer_email', 'email', 'amount', 'channel',
      'payment_method', 'status', 'merchant', 'merchant_name', 'timestamp'].includes(key)) {
      continue;
    }
    existing[key] = value;
  }

  return existing;
}

/** Every transaction, successful or not, newest last (insertion order). */
function listTransactions() {
  return TRANSACTIONS;
}

/** Settled balance: the sum of SUCCESSFUL transactions only, to 2dp. */
function getBalance() {
  return round2(
    TRANSACTIONS.filter(isSuccessful).reduce((total, t) => total + (parseFloat(t.amount) || 0), 0)
  );
}

/** The payload shape the dashboard and /api/v1/merchant/dashboard expect. */
function getLedgerSnapshot() {
  const transactions = listTransactions();
  return {
    balance: getBalance(),
    currency: 'GHS',
    count: transactions.length,
    successful: transactions.filter(isSuccessful).length,
    transactions: [...transactions]
  };
}

/** Test helper — empty the ledger without breaking the shared array reference. */
function resetLedger() {
  TRANSACTIONS.length = 0;
}

module.exports = {
  TRANSACTIONS,
  SUCCESS_STATUSES,
  addTransaction,
  upsertTransaction,
  findTransaction,
  listTransactions,
  getBalance,
  getLedgerSnapshot,
  resetLedger,
  isSuccessful
};
