/**
 * Server-side price catalogue for Valmont Web Services.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * The agency site (valmontwebservices.*) needs "Pay Stage 1" buttons, but
 * it is a static/anonymous front end: it must never hold a tenant secret
 * key, and it must never be able to name its own price. Before this file
 * those buttons pointed at `pay.html?amount=1400&merchant=…`, which a
 * customer could edit down to `amount=1`.
 *
 * So the price lives HERE, on the server, keyed by SKU. An anonymous
 * caller may only say "WEB-LITE-STG1"; the gateway looks up 1400 cedis
 * itself and mints an access_code. The customer sees
 * pay.html?access_code=ac_… and there is nothing in the URL to tamper with.
 *
 * ── Changing a price ────────────────────────────────────────────────────
 * Edit the table below (or override a single SKU at deploy time with
 * SERVICE_PRICE__<SKU with dashes as underscores>, e.g.
 * SERVICE_PRICE__WEB_LITE_STG1=1500). Amounts are ALWAYS in cedis
 * (major units) — the same unit the rest of the gateway speaks.
 */

/** Tenant that owns every SKU in this catalogue. */
const SERVICE_MERCHANT_KEY = 'valmont-web-services';

/** Display name shown on pay.html for these links. */
const SERVICE_MERCHANT_NAME = 'Valmont Web Services';

/**
 * The catalogue. `amount` is in CEDIS.
 * `reference` is the SKU itself — every link minted for a SKU uses it as
 * the reference prefix so the ledger reads WEB-LITE-STG1-…
 */
const CATALOGUE = Object.freeze({
  'WEB-LITE-STG1': { amount: 1400, plan: 'Website Lite', stage: 'Stage 1', label: 'Website Lite — Stage 1' },
  'WEB-LITE-FULL': { amount: 3500, plan: 'Website Lite', stage: 'Full', label: 'Website Lite — Full payment' },
  'WEB-STARTER-STG1': { amount: 2000, plan: 'Website Starter', stage: 'Stage 1', label: 'Website Starter — Stage 1' },
  'WEB-STARTER-FULL': { amount: 5000, plan: 'Website Starter', stage: 'Full', label: 'Website Starter — Full payment' },
  'WEB-BUSINESS-STG1': { amount: 2600, plan: 'Website Business', stage: 'Stage 1', label: 'Website Business — Stage 1' },
  'WEB-BUSINESS-FULL': { amount: 6500, plan: 'Website Business', stage: 'Full', label: 'Website Business — Full payment' },
  'WEB-EMPIRE-STG1': { amount: 3200, plan: 'Website Empire', stage: 'Stage 1', label: 'Website Empire — Stage 1' },
  'WEB-EMPIRE-FULL': { amount: 8000, plan: 'Website Empire', stage: 'Full', label: 'Website Empire — Full payment' }
});

/** Normalise whatever the caller sent into a catalogue key. */
function normalizeSku(sku) {
  return String(sku || '').trim().toUpperCase();
}

/** Per-SKU price override, e.g. SERVICE_PRICE__WEB_LITE_STG1=1500. */
function envPriceOverride(sku) {
  const name = `SERVICE_PRICE__${sku.replace(/-/g, '_')}`;
  const raw = process.env[name];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Look up a SKU. Returns null for anything not in the catalogue — an
 * unknown SKU is never "priced by the caller", it is simply refused.
 *
 * @param {string} sku
 * @returns {{sku:string, amount:number, plan:string, stage:string, label:string, merchant:string, merchant_key:string}|null}
 */
function lookupSku(sku) {
  const key = normalizeSku(sku);
  const entry = CATALOGUE[key];
  if (!entry) return null;
  const override = envPriceOverride(key);
  return {
    sku: key,
    amount: override === null ? entry.amount : override,
    currency: 'GHS',
    plan: entry.plan,
    stage: entry.stage,
    label: entry.label,
    merchant: SERVICE_MERCHANT_NAME,
    merchant_key: SERVICE_MERCHANT_KEY
  };
}

/** Is this a known SKU? */
function isValidSku(sku) {
  return Boolean(CATALOGUE[normalizeSku(sku)]);
}

/** Every SKU, priced. Safe to expose publicly — it is a price list. */
function listCatalogue() {
  return Object.keys(CATALOGUE).map(lookupSku);
}

/**
 * Build a unique-but-readable reference for a SKU:
 *   WEB-LITE-STG1-M4X2K1
 * The SKU stays the prefix so the ledger, the invoice and the catalogue
 * all line up, while the suffix keeps Paystack references unique.
 */
function buildReference(sku, now = Date.now()) {
  const key = normalizeSku(sku);
  const suffix = `${now.toString(36).toUpperCase()}${Math.floor(100 + Math.random() * 900)}`;
  return `${key}-${suffix}`;
}

/** True when `reference` belongs to a catalogue SKU (any suffix). */
function referenceSku(reference) {
  const raw = String(reference || '').trim().toUpperCase();
  if (CATALOGUE[raw]) return raw;
  const match = Object.keys(CATALOGUE).find(sku => raw.startsWith(`${sku}-`));
  return match || null;
}

module.exports = {
  CATALOGUE,
  SERVICE_MERCHANT_KEY,
  SERVICE_MERCHANT_NAME,
  buildReference,
  isValidSku,
  listCatalogue,
  lookupSku,
  normalizeSku,
  referenceSku
};
