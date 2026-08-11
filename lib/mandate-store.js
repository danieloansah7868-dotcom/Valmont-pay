/**
 * Durable mandate store for merchant-initiated recurring debits & standing
 * instructions (like MTN MoMo auto-renewal or recurring card charges).
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * When a customer approves a standing instruction or recurring mandate on
 * their first payment, Paystack issues a reusable `authorization_code`.
 * Storing this code durably allows Valmont-Pay tenants and merchants to:
 *   1. Inspect active customer mandates and their status.
 *   2. Automatically charge mandates without recurring USSD PIN prompts
 *      via Paystack's `/transaction/charge_authorization` endpoint.
 *   3. Comply with consumer protection laws (Act 987 / BoG guidelines) by
 *      providing clear opt-out and revocation capabilities (`REVOKED` status).
 *
 * ── The design ──────────────────────────────────────────────────────────
 * Supabase is the durable source of truth (table `mandates`, created by
 * scripts/supabase-mandates-schema.sql). An in-memory Map stays as a hot
 * cache and local-development fallback when Supabase is not configured.
 *
 *   saveMandate()               — Write-through: memory + Supabase upsert.
 *   saveMandateFromAuthorization() — Helper to extract & save reusable mandates
 *                                 from Paystack webhooks or verification data.
 *   getMandate()                — Memory first, Supabase fallback + rehydrate.
 *   listMandates()              — Lists mandates with optional filters.
 *   revokeMandate()             — Marks a mandate as 'REVOKED'.
 *   chargeMandate()             — Charges an ACTIVE mandate via Paystack and
 *                                 records the transaction in the ledger.
 *
 * Errors never throw: every failure returns { ok: false, reason, error } so
 * callers can handle persistence gracefully.
 */

const { getSupabaseClient, isSupabaseConfigured } = require('./supabase');
const transactionStore = require('./transaction-store');
const paystack = require('./paystack');

/** Test/DI hook: an explicitly injected client wins over the env-built one. */
let injectedClient = null;

/** In-memory cache & local-development fallback. Keyed by authorization_code. */
const inMemoryMandates = new Map();

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

/** Clear in-memory mandates cache (useful for tests). */
function clearInMemoryMandates() {
  inMemoryMandates.clear();
}

const TABLE = 'mandates';

/** Whitelist of columns written to the `mandates` table. */
const MANDATE_COLUMNS = [
  'authorization_code',
  'reference',
  'customer_email',
  'merchant_name',
  'tenant_key',
  'payment_method',
  'bank',
  'amount',
  'currency',
  'status',
  'metadata',
  'last_charged_at',
  'created_at'
];

function round2(value) {
  const number = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100) / 100;
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
 * Normalize and whitelist a mandate record.
 */
function buildMandateRecord(input) {
  const source = input || {};
  const code = firstNonEmpty(source.authorization_code, source.authorizationCode);
  if (!code) return null;

  const amount = round2(source.amount);

  return {
    authorization_code: String(code),
    reference: firstNonEmpty(source.reference) || 'UNKNOWN-REF',
    customer_email: firstNonEmpty(source.customer_email, source.customer, source.email) || 'unknown@customer',
    merchant_name: firstNonEmpty(source.merchant_name, source.merchant) || 'Valmont-Pay',
    tenant_key: firstNonEmpty(source.tenant_key, source.tenantKey) || null,
    payment_method: firstNonEmpty(source.payment_method, source.channel) || 'Unknown',
    bank: firstNonEmpty(source.bank) || null,
    amount: amount || null,
    currency: source.currency || 'GHS',
    status: String(source.status || 'ACTIVE').toUpperCase(),
    metadata: source.metadata && typeof source.metadata === 'object' ? source.metadata : {},
    last_charged_at: source.last_charged_at || source.lastChargedAt || null,
    created_at: source.created_at || source.createdAt || new Date().toISOString()
  };
}

/**
 * Upsert a mandate into memory and Supabase.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {object} [options.client] - Supabase client override
 * @param {string} [options.context] - Logging context
 */
async function saveMandate(input, options = {}) {
  const context = options.context || 'MANDATE-STORE';
  const record = buildMandateRecord(input);

  if (!record) {
    return {
      ok: false,
      record: null,
      data: null,
      error: null,
      reason: 'authorization_code is required',
      skipped: false
    };
  }

  // Hot cache / local fallback
  inMemoryMandates.set(record.authorization_code, record);

  if (!isSupabaseConfigured() && !options.client && !injectedClient) {
    console.log(`[${context}] ${record.authorization_code}: memory-only (Supabase not configured)`);
    return {
      ok: true,
      record,
      data: record,
      error: null,
      reason: null,
      skipped: true
    };
  }

  const client = resolveClient(options.client);
  if (!client) {
    return {
      ok: false,
      record,
      data: null,
      error: null,
      reason: 'Supabase client is not available',
      skipped: true
    };
  }

  let data;
  let error;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .upsert(record, { onConflict: 'authorization_code' })
      .select());
  } catch (thrown) {
    const message = thrown && thrown.message ? thrown.message : String(thrown);
    console.error(`[${context}] Supabase write failed for ${record.authorization_code}: ${message}`);
    return { ok: false, record, data: null, error: thrown, reason: message, skipped: false };
  }

  if (error) {
    const details = [error.message, error.details, error.hint].filter(Boolean).join(' — ');
    console.error(`[${context}] Supabase rejected write for ${record.authorization_code}: ${details}`);
    return { ok: false, record, data: null, error, reason: details, skipped: false };
  }

  const row = Array.isArray(data) && data.length ? data[0] : data || record;
  console.log(`[${context}] Saved mandate ${record.authorization_code} (${record.status}) to Supabase`);
  return { ok: true, record, data: row, error: null, reason: null, skipped: false };
}

/**
 * Automatically inspect Paystack transaction verification or webhook payload
 * and save an ACTIVE mandate if an authorization_code is present and reusable.
 *
 * @param {object} data - Paystack transaction data object
 * @param {object} [options]
 */
async function saveMandateFromAuthorization(data, options = {}) {
  const source = data || {};
  const auth = source.authorization || {};
  const metadata = source.metadata || {};

  const code = auth.authorization_code;
  if (!code) {
    return { ok: false, skipped: true, reason: 'No authorization_code in transaction data' };
  }

  // Save mandate if Paystack marked it reusable or if merchant explicitly requested recurring/mandate.
  const isReusable = Boolean(
    auth.reusable || metadata.recurring || metadata.mandate_type
  );
  if (!isReusable) {
    return { ok: false, skipped: true, reason: 'Authorization code is not reusable/recurring' };
  }

  let merchantName = 'Valmont-Pay';
  if (metadata.merchant_name) {
    merchantName = String(metadata.merchant_name);
  } else if (metadata.merchant) {
    merchantName = String(metadata.merchant);
  } else if (Array.isArray(metadata.custom_fields)) {
    const field = metadata.custom_fields.find(f => f && f.variable_name === 'merchant');
    if (field && field.value) merchantName = String(field.value);
  }

  const amountInSubunits = Number(source.amount);
  const amount = Number.isFinite(amountInSubunits) && amountInSubunits > 0 ? amountInSubunits / 100 : null;

  const mandateInput = {
    authorization_code: code,
    reference: String(source.reference || 'UNKNOWN'),
    customer_email: source.customer?.email || source.email || 'unknown@customer',
    merchant_name: merchantName,
    tenant_key: metadata.tenant_key || null,
    payment_method: auth.channel || source.channel || 'Unknown',
    bank: auth.bank || auth.sender_bank || null,
    amount,
    currency: source.currency || 'GHS',
    status: 'ACTIVE',
    metadata: {
      reusable: auth.reusable,
      card_type: auth.card_type || null,
      last4: auth.last4 || null,
      mandate_type: metadata.mandate_type || 'standing_instruction'
    }
  };

  return saveMandate(mandateInput, options);
}

/**
 * Retrieve a mandate by authorization_code.
 * Checks in-memory cache first, then falls back to Supabase.
 *
 * @param {string} authorizationCode
 * @param {object} [options]
 */
async function getMandate(authorizationCode, options = {}) {
  const code = String(authorizationCode || '').trim();
  if (!code) return null;

  const cached = inMemoryMandates.get(code);
  if (cached && !options.forceDb) {
    return cached;
  }

  if (!isSupabaseConfigured() && !options.client && !injectedClient) {
    return cached || null;
  }

  const client = resolveClient(options.client);
  if (!client) return cached || null;

  let data;
  let error;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('authorization_code', code)
      .limit(1));
  } catch (thrown) {
    console.error(`[MANDATE-STORE] Failed to query mandate ${code}:`, thrown);
    return cached || null;
  }

  if (error || !data || !data.length) {
    return cached || null;
  }

  const row = data[0];
  const record = buildMandateRecord(row);
  if (record) {
    inMemoryMandates.set(code, record);
  }
  return record;
}

/**
 * List mandates, optionally filtering by merchant_name, customer_email, or status.
 *
 * @param {object} [options]
 * @param {string} [options.merchant_name]
 * @param {string} [options.customer_email]
 * @param {string} [options.status]
 */
async function listMandates(options = {}) {
  const filters = options || {};

  if (!isSupabaseConfigured() && !options.client && !injectedClient) {
    let results = Array.from(inMemoryMandates.values());
    if (filters.merchant_name) {
      results = results.filter(m => m.merchant_name === filters.merchant_name);
    }
    if (filters.customer_email) {
      results = results.filter(m => m.customer_email === filters.customer_email);
    }
    if (filters.status) {
      results = results.filter(m => m.status === String(filters.status).toUpperCase());
    }
    return { ok: true, mandates: results, error: null, reason: null };
  }

  const client = resolveClient(options.client);
  if (!client) {
    return { ok: false, mandates: [], error: null, reason: 'Supabase client not available' };
  }

  let query = client.from(TABLE).select('*').order('created_at', { ascending: false });

  if (filters.merchant_name) {
    query = query.eq('merchant_name', filters.merchant_name);
  }
  if (filters.customer_email) {
    query = query.eq('customer_email', filters.customer_email);
  }
  if (filters.status) {
    query = query.eq('status', String(filters.status).toUpperCase());
  }

  let data;
  let error;
  try {
    ({ data, error } = await query);
  } catch (thrown) {
    return { ok: false, mandates: [], error: thrown, reason: String(thrown) };
  }

  if (error) {
    return { ok: false, mandates: [], error, reason: error.message };
  }

  const rows = Array.isArray(data) ? data : [];
  const mandates = rows.map(buildMandateRecord).filter(Boolean);

  // Keep in-memory hot cache updated
  for (const m of mandates) {
    inMemoryMandates.set(m.authorization_code, m);
  }

  return { ok: true, mandates, error: null, reason: null };
}

/**
 * Revoke an active standing mandate (sets status to REVOKED).
 *
 * @param {string} authorizationCode
 * @param {object} [options]
 */
async function revokeMandate(authorizationCode, options = {}) {
  const existing = await getMandate(authorizationCode, options);
  if (!existing) {
    return {
      ok: false,
      record: null,
      error: null,
      reason: `Mandate ${authorizationCode} not found`
    };
  }

  const updated = {
    ...existing,
    status: 'REVOKED'
  };

  return saveMandate(updated, options);
}

/**
 * Charge an ACTIVE standing mandate for a merchant-initiated recurring debit.
 * Calls Paystack's /transaction/charge_authorization endpoint and records the
 * resulting transaction in the ledger.
 *
 * @param {object} params
 * @param {string} params.authorization_code - Reusable mandate authorization code
 * @param {number} params.amount - Major units (e.g. 50.00)
 * @param {string} [params.email] - Customer email (defaults to mandate email)
 * @param {string} [params.reference] - Transaction reference (generated if missing)
 * @param {string} [params.currency='GHS'] - Currency code
 * @param {string} [params.subaccount] - Optional Paystack subaccount for split settlement
 * @param {string} [params.merchant] - Merchant display name
 * @param {object} [params.metadata] - Custom metadata
 * @param {string} [params.secretKey] - Tenant Paystack secret key
 * @param {object} [options]
 */
async function chargeMandate(params, options = {}) {
  const code = String(params && params.authorization_code || '').trim();
  if (!code) {
    return { ok: false, reason: 'authorization_code is required' };
  }

  const mandate = await getMandate(code, options);
  if (!mandate) {
    return { ok: false, reason: `Mandate ${code} not found` };
  }

  if (mandate.status !== 'ACTIVE') {
    return { ok: false, reason: `Mandate status is ${mandate.status}; only ACTIVE mandates can be charged` };
  }

  const amount = Number(params.amount) || Number(mandate.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'A valid positive amount is required to charge a mandate' };
  }

  const email = params.email || mandate.customer_email;
  const merchant = params.merchant || mandate.merchant_name;
  const reference = params.reference || paystack.generateReference();

  let paystackResult;
  try {
    paystackResult = await paystack.chargeAuthorizationWithKey({
      authorization_code: code,
      email,
      amount,
      reference,
      currency: params.currency || mandate.currency || 'GHS',
      subaccount: params.subaccount,
      merchant,
      metadata: {
        ...(mandate.metadata || {}),
        ...(params.metadata || {}),
        recurring_charge: true,
        mandate_reference: mandate.reference
      },
      secretKey: params.secretKey
    });
  } catch (thrown) {
    return {
      ok: false,
      reason: thrown && thrown.message ? thrown.message : 'Paystack charge authorization call failed',
      error: thrown
    };
  }

  const isSuccess = Boolean(
    paystackResult &&
    paystackResult.status &&
    paystackResult.data &&
    (paystackResult.data.status === 'success' || paystackResult.data.status === 'SUCCESS')
  );

  // Record transaction in ledger (whether SUCCESS or FAILED)
  const txInput = {
    reference,
    merchant_name: merchant,
    customer_email: email,
    amount,
    payment_method: mandate.payment_method || 'Standing Mandate',
    status: isSuccess ? 'SUCCESS' : 'FAILED',
    paid_at: isSuccess ? new Date().toISOString() : null
  };

  await transactionStore.saveTransaction(txInput, {
    client: options.client,
    context: 'MANDATE-CHARGE'
  });

  if (isSuccess) {
    // Update last_charged_at on the mandate
    const updatedMandate = {
      ...mandate,
      last_charged_at: new Date().toISOString()
    };
    await saveMandate(updatedMandate, options);
  }

  return {
    ok: isSuccess,
    transaction: txInput,
    paystackResponse: paystackResult,
    reason: isSuccess ? null : (paystackResult?.message || 'Charge authorization was declined by operator')
  };
}

module.exports = {
  MANDATE_COLUMNS,
  buildMandateRecord,
  saveMandate,
  saveMandateFromAuthorization,
  getMandate,
  listMandates,
  revokeMandate,
  chargeMandate,
  setSupabaseClient,
  clearInMemoryMandates
};
