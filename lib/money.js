/**
 * Money helpers.
 *
 * THE RULE: every amount that crosses an API boundary (initialize, verify,
 * webhook) is an INTEGER number of MINOR UNITS — pesewas for GHS, exactly like
 * Paystack. Majors (GH₵ 12.50) only ever exist for display.
 *
 * The gateway settles in Ghana Cedis. The currency is configurable per
 * deployment (VALMONTPAY_CURRENCY) but defaults to GHS and is NEVER NGN by
 * accident: nothing in this file hardcodes a Nigerian default.
 */

const DEFAULT_CURRENCY = (process.env.VALMONTPAY_CURRENCY || 'GHS').toUpperCase();

/** Currencies this gateway knows how to format. All are 2-decimal. */
const CURRENCY_SYMBOLS = Object.freeze({
  GHS: 'GH\u20b5',
  USD: '$',
  EUR: '\u20ac',
  GBP: '\u00a3'
});

function currency() {
  return (process.env.VALMONTPAY_CURRENCY || DEFAULT_CURRENCY).toUpperCase();
}

/**
 * Parse an untrusted minor-unit amount.
 * Accepts "5000" or 5000, rejects 50.5, negatives, NaN and Infinity.
 *
 * @returns {number|null} the integer minor amount, or null when invalid.
 */
function parseMinor(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) return null;
  if (!Number.isInteger(numeric)) return null;
  if (numeric <= 0) return null;
  if (numeric > Number.MAX_SAFE_INTEGER) return null;
  return numeric;
}

/** Minor units -> major units as a Number (5000 -> 50). Display/ledger only. */
function toMajor(minor) {
  return Math.round(Number(minor) || 0) / 100;
}

/** Major units -> minor units (50.1 -> 5010, never 5009.999…). */
function toMinor(major) {
  return Math.round((Number(major) || 0) * 100);
}

/** "GH₵ 50.00" — for the checkout page and the dashboard. */
function formatMinor(minor, code = currency()) {
  const symbol = CURRENCY_SYMBOLS[code] || `${code} `;
  return `${symbol} ${toMajor(minor).toFixed(2)}`;
}

module.exports = {
  DEFAULT_CURRENCY,
  CURRENCY_SYMBOLS,
  currency,
  parseMinor,
  toMajor,
  toMinor,
  formatMinor
};
