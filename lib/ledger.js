/**
 * Shared in-memory transaction ledger.
 *
 * IMPORTANT: this ledger starts EMPTY. There is no seed/demo/test data and no
 * starting balance — every row you see in the dashboard comes from a real
 * transaction that passed through this gateway (initialize -> charge, or a
 * Paystack webhook / verification callback).
 *
 * The balance is never stored as a mutable running total that can drift out of
 * sync with the ledger; it is always DERIVED by summing successful
 * transactions. That way "balance" can never show money the ledger cannot
 * account for.
 *
 * NOTE ON PERSISTENCE: this is process memory, so it resets when the server
 * restarts (and on serverless platforms it is per-instance). Swap the store
 * below for Postgres/Redis/Mongo when you need durable settlement records.
 */

/** @type {Array<object>} the one and only ledger. Starts empty. */
const TRANSACTIONS = [];

const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED']);

function normalizeStatus(status) {
  return String(status || 'PENDING').toUpperCase();
}

function isSuccessful(transaction) {
  return SUCCESS_STATUSES.has(normalizeStatus(transaction && transaction.status));
}

/** Round to 2dp so repeated float additions never produce 4499.999999999999. */
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Every transaction currently on the ledger, newest first. */
function listTransactions() {
  return TRANSACTIONS;
}

function findTransaction(reference) {
  if (!reference) return undefined;
  return TRANSACTIONS.find(t => t.reference === reference);
}

/**
 * The settled wallet balance = the sum of every SUCCESSFUL transaction.
 * An empty ledger therefore yields exactly 0.
 */
function getBalance() {
  return round2(
    TRANSACTIONS.filter(isSuccessful).reduce((total, t) => total + (Number(t.amount) || 0), 0)
  );
}

/** Add a brand new transaction to the top of the ledger. */
function addTransaction(transaction) {
  const record = {
    reference: transaction.reference,
    customer: transaction.customer || 'unknown@customer',
    amount: round2(transaction.amount),
    channel: transaction.channel || 'PENDING',
    status: normalizeStatus(transaction.status),
    merchant: transaction.merchant || 'Valmont-Pay',
    timestamp: transaction.timestamp || new Date().toISOString()
  };

  if (transaction.callback_url) record.callback_url = transaction.callback_url;

  TRANSACTIONS.unshift(record);
  return record;
}

/**
 * Insert or update a transaction by reference. Used by the Paystack webhook
 * and the verification callback, which may arrive before or after the local
 * record exists (and may arrive twice — this stays idempotent).
 */
function upsertTransaction(transaction) {
  const existing = findTransaction(transaction.reference);
  if (!existing) return addTransaction(transaction);

  if (transaction.customer) existing.customer = transaction.customer;
  if (transaction.amount !== undefined && transaction.amount !== null && !isNaN(transaction.amount)) {
    existing.amount = round2(transaction.amount);
  }
  if (transaction.channel) existing.channel = transaction.channel;
  if (transaction.status) existing.status = normalizeStatus(transaction.status);
  if (transaction.merchant) existing.merchant = transaction.merchant;
  if (transaction.timestamp) existing.timestamp = transaction.timestamp;

  return existing;
}

/** Summary payload shared by /api/transactions and the dashboard endpoint. */
function getLedgerSnapshot() {
  const transactions = listTransactions();
  return {
    balance: getBalance(),
    currency: 'GHS',
    count: transactions.length,
    successful: transactions.filter(isSuccessful).length,
    transactions
  };
}

/** Test helper — wipes the ledger back to empty. */
function resetLedger() {
  TRANSACTIONS.length = 0;
}

module.exports = {
  TRANSACTIONS,
  addTransaction,
  upsertTransaction,
  findTransaction,
  listTransactions,
  getBalance,
  getLedgerSnapshot,
  isSuccessful,
  normalizeStatus,
  resetLedger,
  round2
};
