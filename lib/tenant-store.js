/**
 * Supabase-backed tenant store.
 *
 * This is the persistent, admin-editable tenant store used by
 * /tenants.html. lib/tenants.js resolves every stored row through the same
 * explicit precedence used by the APIs and webhook forwarder:
 *
 *   non-empty TENANT__... env var > non-null DB value > in-code default
 *
 * A NULL DB webhook_url is intentionally preserved as "not configured in the
 * DB" so lib/tenants.js can fall back to the built-in receiver URL. CRUD
 * mutations persist here first, then rebuild the effective in-memory tenant.
 *
 * When Supabase is NOT configured the methods become no-ops that return
 * `ok:false, reason:'supabase-not-configured'` — callers (admin UI, server
 * endpoints) must surface this to the operator instead of pretending the
 * write succeeded.
 */

const crypto = require('crypto');
const { getSupabaseClient, isSupabaseConfigured, missingSupabaseEnvMessage } = require('./supabase');

/** Whitelist of columns we read/write. Never a spread of user input. */
const TENANT_COLUMNS = [
  'key',
  'display_name',
  'brand_color',
  'logo_url',
  'currency',
  'environment',
  'webhook_url',
  'paystack_subaccount',
  'settlement_account',
  'allowed_domains',
  'secret_key_1',
  'secret_key_2',
  'public_key',
  'paystack_secret_key',
  'paystack_public_key',
  'webhook_signing_secret',
  'notification_email',
  'notification_phone',
  'status',
  'created_at',
  'updated_at'
];

const REQUIRED_CREATE_FIELDS = ['key', 'display_name'];

/**
 * Columns added after the first tenants existed.
 *
 * createTenant always writes them, so a deployment that ships this code
 * before the matching migration is run would fail EVERY tenant creation
 * with an opaque PostgREST error. If the database reports them as unknown we
 * retry without them and say so, rather than blocking onboarding.
 */
const OPTIONAL_NEW_COLUMNS = ['notification_email', 'notification_phone'];

/** True when PostgREST rejected the write because a column is not there yet. */
function isMissingColumnError(error, columns) {
  const text = describeError(error).toLowerCase();
  if (!columns.some(column => text.includes(column))) return false;
  return /does not exist|could not find|schema cache|column .* of .* in the schema/i.test(text);
}
const VALID_STATUSES = ['active', 'disabled'];
const VALID_ENVIRONMENTS = ['test', 'live'];
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

let injectedClient = null;

/** Test/DI hook — inject a stub Supabase client. Pass null to clear. */
function setSupabaseClient(client) {
  injectedClient = client || null;
  return injectedClient;
}

function resolveClient(explicit) {
  return explicit || injectedClient || getSupabaseClient();
}

function describeError(error) {
  if (!error) return 'Unknown Supabase error';
  if (typeof error === 'string') return error;
  const parts = [error.message, error.details, error.hint].filter(Boolean);
  return parts.join(' — ') || JSON.stringify(error);
}

function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

/** Normalize a tenant row from Supabase into the shape lib/tenants.js uses. */
function rowToTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: String(row.key).toLowerCase(),
    display_name: row.display_name,
    brand_color: row.brand_color || '#f68b1e',
    logo_url: row.logo_url || '/logo.svg',
    currency: row.currency || 'GHS',
    environment: row.environment || 'test',
    // Preserve NULL as an absent value. The effective registry then applies
    // env > DB > default instead of coercing NULL into a false "empty" winner.
    webhook_url: row.webhook_url == null ? undefined : String(row.webhook_url).trim(),
    paystack_subaccount: row.paystack_subaccount == null ? undefined : row.paystack_subaccount,
    settlement_account: row.settlement_account == null ? undefined : row.settlement_account,
    allowed_domains: Array.isArray(row.allowed_domains) ? row.allowed_domains : [],
    secret_keys: [row.secret_key_1, row.secret_key_2].filter(Boolean),
    public_key: row.public_key == null ? undefined : row.public_key,
    paystack_secret_key: row.paystack_secret_key == null ? undefined : row.paystack_secret_key,
    paystack_public_key: row.paystack_public_key == null ? undefined : row.paystack_public_key,
    webhook_signing_secret: row.webhook_signing_secret == null ? undefined : row.webhook_signing_secret,
    notification_email: row.notification_email == null ? undefined : row.notification_email,
    notification_phone: row.notification_phone == null ? undefined : row.notification_phone,
    status: row.status || 'active',
    disabled: row.status === 'disabled',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** Sanitized version for the admin UI list — never includes secret keys. */
function sanitise(row) {
  const t = rowToTenant(row);
  if (!t) return null;
  return {
    id: row.id,
    key: t.key,
    display_name: t.display_name,
    brand_color: t.brand_color,
    logo_url: t.logo_url,
    currency: t.currency,
    environment: t.environment,
    webhook_url: t.webhook_url || '',
    paystack_subaccount: t.paystack_subaccount,
    settlement_account: t.settlement_account,
    allowed_domains: t.allowed_domains,
    status: t.status,
    disabled: t.disabled,
    has_secret_key: Boolean(t.secret_keys.length),
    has_paystack_key: Boolean(t.paystack_secret_key),
    notification_email: t.notification_email || '',
    notification_phone: t.notification_phone || '',
    created_at: t.created_at,
    updated_at: t.updated_at
  };
}

function genSecret(prefix) {
  return `${prefix || 'vmp'}_${crypto.randomBytes(20).toString('hex')}`;
}

/**
 * Load ALL tenants from the Supabase `tenants` table.
 * @returns {Promise<{ok:boolean, tenants:Array, rows:Array, reason?:string}>}
 */
async function loadTenants(options = {}) {
  if (!isSupabaseConfigured()) {
    return { ok: true, tenants: [], rows: [], reason: 'supabase-not-configured' };
  }
  const client = resolveClient(options.client);
  if (!client) return { ok: true, tenants: [], rows: [], reason: 'supabase-unavailable' };

  try {
    const { data, error } = await client
      .from('tenants')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) return { ok: false, tenants: [], rows: [], reason: describeError(error) };
    const rows = Array.isArray(data) ? data : [];
    return { ok: true, tenants: rows.map(rowToTenant), rows, reason: null };
  } catch (thrown) {
    return { ok: false, tenants: [], rows: [], reason: thrown.message || String(thrown) };
  }
}

/**
 * Create a tenant. Generates secret_key_1 and webhook_signing_secret when
 * they aren't supplied; validates the slug key; upserts to avoid duplicate key
 * races. Returns the sanitised row plus raw secrets (shown ONCE at creation).
 */
async function createTenant(input, options = {}) {
  const fail = (reason) => ({ ok: false, tenant: null, reason });

  if (!input || typeof input !== 'object') return fail('payload is required');
  for (const f of REQUIRED_CREATE_FIELDS) {
    if (!input[f] || typeof input[f] !== 'string') return fail(`${f} is required`);
  }
  const key = String(input.key).toLowerCase().trim();
  if (!isValidKey(key)) {
    return fail('tenant_id must be a lowercase slug of letters, numbers, and hyphens (e.g. valmont-electricals)');
  }

  const record = {
    key,
    display_name: String(input.display_name).trim(),
    brand_color: input.brand_color || '#f68b1e',
    logo_url: input.logo_url || '/logo.svg',
    currency: (input.currency || 'GHS').toUpperCase(),
    environment: VALID_ENVIRONMENTS.includes(input.environment) ? input.environment : 'test',
    webhook_url: input.webhook_url ? String(input.webhook_url).trim() : null,
    paystack_subaccount: input.paystack_subaccount ? String(input.paystack_subaccount).trim() : null,
    settlement_account: input.settlement_account ? String(input.settlement_account).trim() : null,
    allowed_domains: Array.isArray(input.allowed_domains)
      ? input.allowed_domains.map(d => String(d).trim().toLowerCase()).filter(Boolean)
      : (typeof input.allowed_domains === 'string' && input.allowed_domains.trim())
        ? input.allowed_domains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
        : [],
    secret_key_1: input.secret_key_1 || genSecret(`sk_${key}`),
    secret_key_2: null,
    public_key: input.public_key || genSecret(`pk_${key}`),
    paystack_secret_key: input.paystack_secret_key || null,
    paystack_public_key: input.paystack_public_key || null,
    webhook_signing_secret: input.webhook_signing_secret || crypto.randomBytes(32).toString('hex'),
    notification_email: input.notification_email ? String(input.notification_email).trim() : null,
    notification_phone: input.notification_phone ? String(input.notification_phone).trim() : null,
    status: VALID_STATUSES.includes(input.status) ? input.status : 'active'
  };

  // Validate webhook URL if provided
  if (record.webhook_url) {
    try { new URL(record.webhook_url); }
    catch { return fail('webhook_url must be a valid URL (https://...)'); }
  }

  if (!isSupabaseConfigured()) return fail(missingSupabaseEnvMessage() || 'Supabase not configured');
  const client = resolveClient(options.client);
  if (!client) return fail('Supabase client unavailable');

  const upsert = (body) => client
    .from('tenants')
    .upsert(body, { onConflict: 'key' })
    .select('*')
    .single();

  try {
    const { data, error } = await upsert(record);

    if (error && isMissingColumnError(error, OPTIONAL_NEW_COLUMNS)) {
      // The migration for the notification columns has not been run yet.
      // Create the tenant anyway — onboarding must not depend on a schema
      // change — and tell the caller exactly what is missing.
      const legacyRecord = { ...record };
      for (const column of OPTIONAL_NEW_COLUMNS) delete legacyRecord[column];

      const retry = await upsert(legacyRecord);
      if (retry.error) return fail(describeError(retry.error));

      console.warn(
        `[TENANT-STORE] Created "${key}" without ${OPTIONAL_NEW_COLUMNS.join(' and ')} — ` +
          'those columns are missing from public.tenants. Run the notification ' +
          'block in scripts/supabase-tenants-schema.sql to enable per-tenant receipts.'
      );
      return {
        ok: true,
        tenant: sanitise(retry.data),
        raw: retry.data,
        rawSecrets: {
          secret_key_1: retry.data.secret_key_1,
          public_key: retry.data.public_key,
          webhook_signing_secret: retry.data.webhook_signing_secret
        },
        migrationPending: OPTIONAL_NEW_COLUMNS,
        reason: null
      };
    }

    if (error) return fail(describeError(error));
    return { ok: true, tenant: sanitise(data), raw: data, rawSecrets: {
      secret_key_1: data.secret_key_1,
      public_key: data.public_key,
      webhook_signing_secret: data.webhook_signing_secret
    }, reason: null };
  } catch (thrown) {
    return fail(thrown.message || String(thrown));
  }
}

/**
 * Partial update. Only provided fields change.
 * Prevents clobbering existing secrets when the admin only edits name/webhook.
 */
async function updateTenant(key, patch, options = {}) {
  const fail = (reason) => ({ ok: false, tenant: null, reason });
  if (!isValidKey(key)) return fail('invalid tenant key');
  if (!patch || typeof patch !== 'object') return fail('patch object is required');

  const updates = {};
  const allowed = ['display_name', 'brand_color', 'logo_url', 'currency',
    'environment', 'webhook_url', 'paystack_subaccount', 'settlement_account',
    'allowed_domains', 'public_key', 'paystack_secret_key', 'paystack_public_key',
    'notification_email', 'notification_phone', 'status'];
  for (const k of allowed) {
    if (patch[k] !== undefined) updates[k] = patch[k];
  }

  if (updates.status && !VALID_STATUSES.includes(updates.status)) {
    return fail(`status must be one of ${VALID_STATUSES.join(',')}`);
  }
  if (updates.environment && !VALID_ENVIRONMENTS.includes(updates.environment)) {
    return fail(`environment must be one of ${VALID_ENVIRONMENTS.join(',')}`);
  }
  if (updates.webhook_url) {
    try { new URL(updates.webhook_url); }
    catch { return fail('webhook_url must be a valid URL'); }
  }
  if (typeof updates.allowed_domains === 'string') {
    updates.allowed_domains = updates.allowed_domains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  }

  if (patch.secret_key_1 && typeof patch.secret_key_1 === 'string') {
    updates.secret_key_1 = patch.secret_key_1;
  }

  if (!Object.keys(updates).length) return fail('no valid fields to update');

  if (!isSupabaseConfigured()) return fail(missingSupabaseEnvMessage() || 'Supabase not configured');
  const client = resolveClient(options.client);
  if (!client) return fail('Supabase client unavailable');

  try {
    const { data, error } = await client
      .from('tenants')
      .update(updates)
      .eq('key', key.toLowerCase())
      .select('*')
      .single();
    if (error) return fail(describeError(error));
    if (!data) return fail('tenant not found');
    return { ok: true, tenant: sanitise(data), raw: data, reason: null };
  } catch (thrown) {
    return fail(thrown.message || String(thrown));
  }
}

async function deleteTenant(key, options = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isValidKey(key)) return fail('invalid tenant key');
  if (!isSupabaseConfigured()) return fail(missingSupabaseEnvMessage() || 'Supabase not configured');
  const client = resolveClient(options.client);
  if (!client) return fail('Supabase client unavailable');

  try {
    const { error } = await client.from('tenants').delete().eq('key', key.toLowerCase());
    if (error) return fail(describeError(error));
    return { ok: true, reason: null };
  } catch (thrown) {
    return fail(thrown.message || String(thrown));
  }
}

/** Rotate secret_key_1 → secret_key_2, generate new secret_key_1. */
async function rotateSecrets(key, options = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isValidKey(key)) return fail('invalid tenant key');
  if (!isSupabaseConfigured()) return fail(missingSupabaseEnvMessage() || 'Supabase not configured');
  const client = resolveClient(options.client);
  if (!client) return fail('Supabase client unavailable');

  try {
    const { data: existing, error: e1 } = await client
      .from('tenants').select('secret_key_1, secret_key_2').eq('key', key.toLowerCase()).single();
    if (e1) return fail(describeError(e1));
    if (!existing) return fail('tenant not found');
    const newKey = genSecret(`sk_${key}`);
    const { data, error } = await client
      .from('tenants')
      .update({ secret_key_1: newKey, secret_key_2: existing.secret_key_1 || null })
      .eq('key', key.toLowerCase())
      .select('*').single();
    if (error) return fail(describeError(error));
    return {
      ok: true,
      secret_key_1: data.secret_key_1,
      secret_key_2: data.secret_key_2,
      webhook_signing_secret: data.webhook_signing_secret,
      reason: null
    };
  } catch (thrown) {
    return fail(thrown.message || String(thrown));
  }
}

module.exports = {
  TENANT_COLUMNS,
  setSupabaseClient,
  rowToTenant,
  sanitise,
  loadTenants,
  createTenant,
  updateTenant,
  deleteTenant,
  rotateSecrets,
  genSecret,
  isValidKey
};
