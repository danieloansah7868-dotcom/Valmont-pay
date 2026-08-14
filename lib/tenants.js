/**
 * Multi-tenant registry.
 *
 * Every tenant (merchant) is resolved server-side by a stable lowercase key.
 * Never render client-supplied branding — the logo, brand colour, and display
 * name all come from this registry.
 *
 * Every consumer uses the same explicit precedence:
 *
 *   non-empty TENANT__... env var > non-null Supabase row > in-code default
 *
 * Tenant environment variables follow this pattern:
 *
 *   TENANT__{KEY}__DISPLAY_NAME=Valmont Electricals
 *   TENANT__{KEY}__BRAND_COLOR=#f68b1e
 *   TENANT__{KEY}__CURRENCY=GHS
 *   TENANT__{KEY}__ENVIRONMENT=live
 *   TENANT__{KEY}__ALLOWED_DOMAINS=valmontweb.com,valmontpay.app
 *
 *   # API secrets (used for Bearer auth on merchant-facing endpoints)
 *   TENANT__{KEY}__SECRET_KEY_1=sk_test_...
 *   TENANT__{KEY}__SECRET_KEY_2=sk_test_...   (during rotation)
 *   TENANT__{KEY}__PUBLIC_KEY=pk_test_...
 *
 *   # Paystack keys (separate from merchant API secrets)
 *   TENANT__{KEY}__PAYSTACK_SECRET_KEY=sk_test_...
 *   TENANT__{KEY}__PAYSTACK_PUBLIC_KEY=pk_test_...
 *
 *   # Settlement
 *   TENANT__{KEY}__SETTLEMENT_ACCOUNT=GCB Bank - 1234567890
 *
 *   # Webhook
 *   TENANT__{KEY}__WEBHOOK_URL=https://valmontweb.com/api/payments/webhook
 *
 * Alternatively, a single JSON env var can define all tenants at once:
 *
 *   TENANTS_JSON=[{"key":"valmont-electricals","display_name":"Valmont Electricals",...}]
 *
 * The initial tenants (valmont-electricals and valmont-web-services) are seeded
 * from defaults so local development works out of the box. `environment` is
 * display metadata only: Paystack mode comes from the actual sk_test_/sk_live_
 * credential.
 *
 * `valmontweb` is intentionally NOT a tenant record any more. It is a legacy
 * lookup alias for valmont-web-services so old payment_links / ledger rows keep
 * resolving without publishing a second Valmont Web merchant. See
 * docs/tenant-integration.md § 2.4.1.
 */

const crypto = require('crypto');
const tenantStore = require('./tenant-store');
const {
  SERVICE_MERCHANT_KEY,
  SERVICE_MERCHANT_NAME
} = require('./service-catalogue');

const ELECTRICALS_WEBHOOK_URL = 'https://valmontelectricals.com/api/valmontpay/webhook';

// A database may still contain rows whose tenant_key predates the SKU flow.
// Keep the old value readable, but never register it as a second public
// merchant or accept it as a new tenant configuration.
const LEGACY_TENANT_ALIASES = Object.freeze({
  valmontweb: SERVICE_MERCHANT_KEY
});

const LEGACY_TENANT_DISPLAY_ALIASES = Object.freeze({
  'valmont web': SERVICE_MERCHANT_KEY
});

function normalizeTenantKey(key) {
  return String(key || '').trim().toLowerCase();
}

function normalizeDisplayName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Return the public/canonical key for a tenant key, including old rows. */
function canonicalTenantKey(key) {
  const normalized = normalizeTenantKey(key);
  return LEGACY_TENANT_ALIASES[normalized] || normalized;
}

function isLegacyTenantKey(key) {
  return Object.prototype.hasOwnProperty.call(LEGACY_TENANT_ALIASES, normalizeTenantKey(key));
}

function isLegacyTenantDisplayName(name) {
  return Object.prototype.hasOwnProperty.call(LEGACY_TENANT_DISPLAY_ALIASES, normalizeDisplayName(name));
}

function isCatalogueMerchantDisplayName(name) {
  const normalized = normalizeDisplayName(name);
  return normalized === normalizeDisplayName(SERVICE_MERCHANT_NAME) || isLegacyTenantDisplayName(normalized);
}

/**
 * Prevent a config source from publishing a second identity for the catalogue
 * merchant. A canonical service record is allowed; old aliases and lookalike
 * display names are not.
 */
function shouldSuppressCatalogueDuplicate(key, displayName) {
  const normalizedKey = normalizeTenantKey(key);
  if (isLegacyTenantKey(normalizedKey)) return true;
  return normalizedKey !== SERVICE_MERCHANT_KEY && isCatalogueMerchantDisplayName(displayName);
}

/** Guard the admin create path against a third Valmont Web identity. */
function validateTenantIdentityForCreate(input) {
  const key = normalizeTenantKey(input && input.key);
  if (isLegacyTenantKey(key)) {
    return {
      valid: false,
      reason: `${key} is a legacy alias. Use ${SERVICE_MERCHANT_KEY} for Valmont Web Services.`
    };
  }
  if (canonicalTenantKey(key) === SERVICE_MERCHANT_KEY) {
    return {
      valid: false,
      reason: `${SERVICE_MERCHANT_KEY} is the reserved SKU catalogue merchant and cannot be created as a separate tenant.`
    };
  }
  if (isCatalogueMerchantDisplayName(input && input.display_name)) {
    return {
      valid: false,
      reason: `${SERVICE_MERCHANT_NAME} already has the single catalogue merchant key ${SERVICE_MERCHANT_KEY}.`
    };
  }
  return { valid: true };
}

/** Guard updates without preventing operators from editing the canonical row. */
function validateTenantIdentityForUpdate(key, patch) {
  const normalizedKey = normalizeTenantKey(key);
  if (isLegacyTenantKey(normalizedKey)) {
    return {
      valid: false,
      reason: `${normalizedKey} is a read-only legacy alias. Use ${SERVICE_MERCHANT_KEY}.`
    };
  }
  const canonicalKey = canonicalTenantKey(normalizedKey);
  const requestedName = patch && patch.display_name;
  if (canonicalKey === SERVICE_MERCHANT_KEY) {
    if (requestedName !== undefined && normalizeDisplayName(requestedName) !== normalizeDisplayName(SERVICE_MERCHANT_NAME)) {
      return {
        valid: false,
        reason: `${SERVICE_MERCHANT_KEY} must keep the public name ${SERVICE_MERCHANT_NAME}.`
      };
    }
    return { valid: true };
  }
  if (requestedName !== undefined && isCatalogueMerchantDisplayName(requestedName)) {
    return {
      valid: false,
      reason: `${SERVICE_MERCHANT_NAME} already has the single catalogue merchant key ${SERVICE_MERCHANT_KEY}.`
    };
  }
  return { valid: true };
}

/** Keep the service merchant's public key/name fixed across all config layers. */
function enforceCanonicalServiceIdentity(tenant) {
  if (tenant && canonicalTenantKey(tenant.key) === SERVICE_MERCHANT_KEY) {
    tenant.key = SERVICE_MERCHANT_KEY;
    tenant.display_name = SERVICE_MERCHANT_NAME;
  }
  return tenant;
}

// ─── Built-in default tenants for local development ───────────────────────

const DEFAULT_TENANTS = {
  'valmont-electricals': {
    key: 'valmont-electricals',
    display_name: 'Valmont Electricals',
    brand_color: '#f68b1e',
    logo_url: '/logo.svg',
    currency: 'GHS',
    allowed_domains: ['valmontelectricals.com', 'valmontweb.com', 'valmontpay.app', 'localhost'],
    settlement_account: 'GCB Bank - 1234567890',
    webhook_url: ELECTRICALS_WEBHOOK_URL,
    paystack_secret_key: process.env.PAYSTACK_SECRET_KEY || '',
    paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY || '',
    secret_keys: [
      process.env.TENANT__VALMONT_ELECTRICALS__SECRET_KEY_1 || 'vme_secret_dev_key_1',
      process.env.TENANT__VALMONT_ELECTRICALS__SECRET_KEY_2 || ''
    ].filter(Boolean),
    public_key: process.env.TENANT__VALMONT_ELECTRICALS__PUBLIC_KEY || 'vme_pub_dev_key_1',
    webhook_signing_secret: process.env.TENANT__VALMONT_ELECTRICALS__WEBHOOK_SIGNING_SECRET
      || process.env.WEBHOOK_SECRET
      || 'vme_webhook_signing_dev_1',
    // Display-only label; never infer payment routing from it.
    environment: 'live',
    status: 'active',
    disabled: false,
    paystack_subaccount: process.env.TENANT__VALMONT_ELECTRICALS__PAYSTACK_SUBACCOUNT || '',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
  },
  // The agency site. Its "Pay Stage 1 / Pay in full" buttons are anonymous
  // (no secret key in the browser), so they mint links by SKU through
  // POST /api/v1/payment-link/sku — the price comes from
  // lib/service-catalogue.js, never from the caller. See
  // docs/tenant-integration.md § 2.4.
  [SERVICE_MERCHANT_KEY]: {
    key: SERVICE_MERCHANT_KEY,
    display_name: SERVICE_MERCHANT_NAME,
    brand_color: '#f68b1e',
    logo_url: '/logo.svg',
    currency: 'GHS',
    allowed_domains: ['valmontwebservices.com', 'valmontweb.com', 'valmontpay.app', 'localhost'],
    settlement_account: '',
    webhook_url: '',
    paystack_secret_key: process.env.PAYSTACK_SECRET_KEY || '',
    paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY || '',
    // No baked-in dev credential here on purpose. The agency site never
    // holds a secret: it mints links by SKU. An operator who wants direct
    // API access for this tenant sets TENANT__VALMONT_WEB_SERVICES__SECRET_KEY_1.
    secret_keys: [
      process.env.TENANT__VALMONT_WEB_SERVICES__SECRET_KEY_1 || '',
      process.env.TENANT__VALMONT_WEB_SERVICES__SECRET_KEY_2 || ''
    ].filter(Boolean),
    public_key: process.env.TENANT__VALMONT_WEB_SERVICES__PUBLIC_KEY || '',
    webhook_signing_secret: process.env.TENANT__VALMONT_WEB_SERVICES__WEBHOOK_SIGNING_SECRET
      || process.env.WEBHOOK_SECRET
      || '',
    // Display-only label; never infer payment routing from it.
    environment: 'live',
    status: 'active',
    disabled: false,
    paystack_subaccount: process.env.TENANT__VALMONT_WEB_SERVICES__PAYSTACK_SUBACCOUNT || '',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
  }
};

// ─── Load tenants from environment ───────────────────────────────────────

const registry = new Map();
const jsonOverrides = new Map();
let dbRefreshState = { ok: false, count: 0, reason: 'not-attempted', refreshed_at: null };

/** Apply environment config last (TENANTS_JSON, then prefixed operator vars). */
function applyEnvOverrides(tenant) {
  if (!tenant || !tenant.key) return tenant;
  Object.assign(tenant, jsonOverrides.get(tenant.key) || {});
  const prefix = `TENANT__${tenant.key.toUpperCase().replace(/-/g, '_')}__`;
  const read = suffix => process.env[`${prefix}${suffix}`];
  const assign = (suffix, field, transform = value => value.trim()) => {
    const value = read(suffix);
    if (typeof value === 'string' && value.trim()) tenant[field] = transform(value);
  };

  assign('DISPLAY_NAME', 'display_name');
  assign('BRAND_COLOR', 'brand_color');
  assign('LOGO_URL', 'logo_url');
  assign('CURRENCY', 'currency', value => value.trim().toUpperCase());
  assign('SETTLEMENT_ACCOUNT', 'settlement_account');
  assign('WEBHOOK_URL', 'webhook_url');
  assign('PUBLIC_KEY', 'public_key');
  assign('PAYSTACK_SECRET_KEY', 'paystack_secret_key');
  assign('PAYSTACK_PUBLIC_KEY', 'paystack_public_key');
  assign('WEBHOOK_SIGNING_SECRET', 'webhook_signing_secret');
  assign('PAYSTACK_SUBACCOUNT', 'paystack_subaccount');

  const domains = read('ALLOWED_DOMAINS');
  if (typeof domains === 'string' && domains.trim()) {
    tenant.allowed_domains = domains.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  }

  const secret1 = read('SECRET_KEY_1');
  const secret2 = read('SECRET_KEY_2');
  if ((secret1 && secret1.trim()) || (secret2 && secret2.trim())) {
    tenant.secret_keys = [
      secret1 && secret1.trim() ? secret1.trim() : (tenant.secret_keys || [])[0],
      secret2 && secret2.trim() ? secret2.trim() : null
    ].filter(Boolean);
  }

  const environment = String(read('ENVIRONMENT') || '').trim().toLowerCase();
  if (['test', 'live'].includes(environment)) tenant.environment = environment;
  const status = String(read('STATUS') || '').trim().toLowerCase();
  if (['active', 'disabled'].includes(status)) tenant.status = status;
  tenant.disabled = tenant.status === 'disabled';
  return enforceCanonicalServiceIdentity(tenant);
}

function envToTenantKey(envName) {
  // TENANT__FOO__DISPLAY_NAME -> foo
  const parts = envName.split('__');
  if (parts.length >= 2 && parts[0] === 'TENANT') {
    // Tenant slugs use hyphens; environment variable names use underscores.
    return parts.slice(1, -1).join('__').toLowerCase().replace(/_/g, '-');
  }
  return null;
}

/**
 * Load a single tenant from its prefixed environment variables.
 * Returns null if the tenant key cannot be determined.
 */
function loadTenantFromEnv(envName, value) {
  const key = envToTenantKey(envName);
  // The retired key is a read-only lookup alias, never an env-configured
  // tenant. This avoids accidentally reintroducing its old test secret.
  if (!key || isLegacyTenantKey(key)) return null;

  if (!registry.has(key)) {
    registry.set(key, {
      key,
      display_name: key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      brand_color: '#f68b1e',
      logo_url: '/logo.svg',
      currency: 'GHS',
      allowed_domains: ['valmontpay.app'],
      settlement_account: '',
      webhook_url: '',
      paystack_secret_key: process.env.PAYSTACK_SECRET_KEY || '',
      paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY || '',
      secret_keys: [],
      public_key: '',
      webhook_signing_secret: process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex'),
      paystack_subaccount: '',
      environment: 'test',
      status: 'active',
      disabled: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  return registry.get(key);
}

/**
 * Parse the TENANTS_JSON env var if present.
 */
function loadTenantsFromJson(jsonStr) {
  try {
    const tenants = JSON.parse(jsonStr);
    if (!Array.isArray(tenants)) return;
    for (const t of tenants) {
      if (!t.key) continue;
      const key = normalizeTenantKey(t.key);
      // Config is an input source, not a way to publish another version of
      // the SKU merchant. Preserve legacy database data instead of loading it.
      if (shouldSuppressCatalogueDuplicate(key, t.display_name)) continue;
      const supplied = {};
      for (const field of [
        'display_name', 'brand_color', 'logo_url', 'currency',
        'settlement_account', 'webhook_url', 'paystack_secret_key',
        'paystack_public_key', 'public_key', 'webhook_signing_secret',
        'paystack_subaccount', 'environment', 'status', 'created_at', 'updated_at'
      ]) {
        if (typeof t[field] === 'string' && t[field].trim()) supplied[field] = t[field].trim();
      }
      if (Array.isArray(t.allowed_domains)) supplied.allowed_domains = [...t.allowed_domains];
      if (Array.isArray(t.secret_keys)) supplied.secret_keys = t.secret_keys.filter(Boolean);
      if (!supplied.paystack_subaccount && typeof t.subaccount === 'string' && t.subaccount.trim()) {
        supplied.paystack_subaccount = t.subaccount.trim();
      }
      if (typeof t.disabled === 'boolean') supplied.disabled = t.disabled;
      jsonOverrides.set(key, supplied);
      registry.set(key, {
        key,
        display_name: t.display_name || key,
        brand_color: t.brand_color || '#f68b1e',
        logo_url: t.logo_url || '/logo.svg',
        currency: t.currency || 'GHS',
        allowed_domains: Array.isArray(t.allowed_domains) ? t.allowed_domains : ['valmontpay.app'],
        settlement_account: t.settlement_account || '',
        webhook_url: t.webhook_url || '',
        paystack_secret_key: t.paystack_secret_key || process.env.PAYSTACK_SECRET_KEY || '',
        paystack_public_key: t.paystack_public_key || process.env.PAYSTACK_PUBLIC_KEY || '',
        secret_keys: Array.isArray(t.secret_keys) ? t.secret_keys.filter(Boolean) : [],
        public_key: t.public_key || '',
        webhook_signing_secret: t.webhook_signing_secret || process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex'),
        paystack_subaccount: t.paystack_subaccount || t.subaccount || '',
        environment: t.environment || 'test',
        status: t.status || 'active',
        disabled: t.disabled || t.status === 'disabled',
        created_at: t.created_at || new Date().toISOString(),
        updated_at: t.updated_at || new Date().toISOString()
      });
    }
  } catch (_) {
    // ignore invalid JSON
  }
}

// ─── Initialise ──────────────────────────────────────────────────────────

function init() {
  registry.clear();
  jsonOverrides.clear();
  dbRefreshState = { ok: false, count: 0, reason: 'not-attempted', refreshed_at: null };

  if (process.env.TENANTS_JSON) loadTenantsFromJson(process.env.TENANTS_JSON);

  // Discover prefixed-only tenants (including future store rows).
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('TENANT__')) loadTenantFromEnv(name);
  }

  // Built-ins always exist; clean deploys remain operational.
  for (const [key, defaults] of Object.entries(DEFAULT_TENANTS)) {
    registry.set(key, { ...defaults, ...(jsonOverrides.get(key) || {}) });
  }

  // Reapply all env config last so it wins both defaults now and DB rows later.
  for (const tenant of registry.values()) applyEnvOverrides(tenant);

  // A prefixed-only tenant can acquire its display name only after env
  // overrides are applied, so prune duplicate Valmont Web identities here too.
  for (const [key, tenant] of registry.entries()) {
    if (shouldSuppressCatalogueDuplicate(key, tenant.display_name)) registry.delete(key);
  }
}

/**
 * Merge a DB row between the current default and the environment override.
 * NULL/undefined DB values are absent, so (for example) a NULL webhook_url
 * falls through to the built-in Electricals receiver.
 */
function applyDbTenant(dbTenant) {
  if (!dbTenant || !dbTenant.key) return undefined;
  const sourceKey = normalizeTenantKey(dbTenant.key);

  // Do not delete or rewrite a legacy DB row here: payment_links and ledger
  // history can still reference it. The alias is resolved at read time, while
  // this registry deliberately exposes only the canonical public identity.
  if (shouldSuppressCatalogueDuplicate(sourceKey, dbTenant.display_name)) return undefined;

  const key = canonicalTenantKey(sourceKey);
  const fallback = registry.get(key) || DEFAULT_TENANTS[key] || { key };
  const dbValues = Object.fromEntries(
    Object.entries(dbTenant).filter(([, value]) => value !== null && value !== undefined)
  );
  const effective = { ...fallback, ...dbValues, key };
  effective.allowed_domains = Array.isArray(effective.allowed_domains) ? effective.allowed_domains : [];
  effective.secret_keys = Array.isArray(effective.secret_keys) ? effective.secret_keys : [];
  effective.webhook_url = effective.webhook_url || '';
  effective.status = effective.status || 'active';
  effective.disabled = effective.status === 'disabled';
  applyEnvOverrides(effective);
  enforceCanonicalServiceIdentity(effective);
  registry.set(key, effective);
  return effective;
}

/** Re-load Supabase rows and rebuild the effective registry. */
async function refreshFromDb(options = {}) {
  try {
    const { ok, tenants: dbRows, reason } = await tenantStore.loadTenants(options);
    if (!ok || reason) {
      dbRefreshState = {
        ok: false,
        count: 0,
        reason: reason || 'database-refresh-failed',
        refreshed_at: new Date().toISOString()
      };
      console.log('[TENANTS] DB refresh skipped:', dbRefreshState.reason);
      return 0;
    }
    let loaded = 0;
    let legacyAliasesIgnored = 0;
    for (const tenant of dbRows) {
      if (applyDbTenant(tenant)) loaded += 1;
      else legacyAliasesIgnored += 1;
    }
    dbRefreshState = {
      ok: true,
      count: loaded,
      legacy_aliases_ignored: legacyAliasesIgnored,
      reason: null,
      refreshed_at: new Date().toISOString()
    };
    console.log(`[TENANTS] Loaded ${loaded} tenant(s) from Supabase${legacyAliasesIgnored ? `; ignored ${legacyAliasesIgnored} legacy/duplicate identity row(s)` : ''}`);
    return loaded;
  } catch (error) {
    dbRefreshState = {
      ok: false,
      count: 0,
      reason: error.message || String(error),
      refreshed_at: new Date().toISOString()
    };
    console.log('[TENANTS] DB refresh failed:', dbRefreshState.reason);
    return 0;
  }
}

function getDbRefreshState() {
  return { ...dbRefreshState };
}

// Run init immediately
init();

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Look up a tenant by its stable lowercase key.
 * @param {string} key - e.g. 'valmont-electricals'
 * @returns {object|undefined}
 */
function getTenant(key) {
  if (!key) return undefined;
  return registry.get(canonicalTenantKey(key));
}

/** Resolve either a stable key or a display name from payment metadata. */
function getTenantByIdentifier(identifier) {
  if (!identifier) return undefined;
  const normalized = normalizeDisplayName(identifier);
  const keyCandidate = canonicalTenantKey(normalized);
  const slugCandidate = canonicalTenantKey(normalized.replace(/[\s_]+/g, '-'));
  const legacyDisplayKey = LEGACY_TENANT_DISPLAY_ALIASES[normalized];
  return registry.get(legacyDisplayKey)
    || registry.get(keyCandidate)
    || registry.get(slugCandidate)
    || Array.from(registry.values()).find(
      tenant => normalizeDisplayName(tenant.display_name) === normalized
    );
}

/**
 * Resolve a tenant from one of its active secret keys.
 * @param {string} secretKey
 * @returns {object|undefined}
 */
function getTenantBySecretKey(secretKey) {
  if (!secretKey) return undefined;
  const normalized = String(secretKey).trim();
  for (const tenant of registry.values()) {
    if (tenant.secret_keys && tenant.secret_keys.includes(normalized)) {
      return tenant;
    }
  }
  return undefined;
}

/**
 * List all registered tenants (sanitised — no secrets).
 * @returns {Array<object>}
 */
function listTenants() {
  return Array.from(registry.values())
    .filter(t => !t.disabled)
    .map(t => ({
      key: t.key,
      display_name: t.display_name,
      brand_color: t.brand_color,
      logo_url: t.logo_url,
      currency: t.currency,
      settlement_account: t.settlement_account,
      webhook_url: t.webhook_url,
      environment: t.environment,
      allowed_domains: t.allowed_domains,
      paystack_subaccount: t.paystack_subaccount || '',
      status: t.status || 'active',
      disabled: Boolean(t.disabled),
      has_secret_keys: (t.secret_keys || []).length > 0,
      has_public_key: Boolean(t.public_key),
      has_paystack_key: Boolean(t.paystack_secret_key),
      has_webhook_url: Boolean(t.webhook_url),
      created_at: t.created_at,
      updated_at: t.updated_at
    }));
}

/** Full list including disabled tenants (for admin UI). */
function listAllTenants() {
  return Array.from(registry.values()).map(t => ({
    id: t.id || null,
    key: t.key,
    display_name: t.display_name,
    brand_color: t.brand_color,
    logo_url: t.logo_url,
    currency: t.currency,
    settlement_account: t.settlement_account,
    webhook_url: t.webhook_url,
    environment: t.environment,
    allowed_domains: t.allowed_domains,
    paystack_subaccount: t.paystack_subaccount || '',
    status: t.status || (t.disabled ? 'disabled' : 'active'),
    disabled: Boolean(t.disabled),
    has_secret_keys: (t.secret_keys || []).length > 0,
    has_public_key: Boolean(t.public_key),
    has_paystack_key: Boolean(t.paystack_secret_key),
    has_webhook_url: Boolean(t.webhook_url),
    created_at: t.created_at,
    updated_at: t.updated_at
  }));
}

/**
 * Update a tenant's webhook URL in memory.
 * Caller is responsible for also persisting to Supabase (tenant-store.updateTenant).
 * @param {string} key
 * @param {string} webhookUrl
 * @returns {boolean}
 */
function setTenantWebhookUrl(key, webhookUrl) {
  return updateTenantInMemory(key, { webhook_url: String(webhookUrl || '') });
}

/**
 * Update multiple fields of an in-memory tenant record at once.
 * Used by server endpoints that persist to Supabase first then sync memory.
 */
function updateTenantInMemory(key, patch) {
  const tenant = getTenant(key);
  if (!tenant) return false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    tenant[k] = v;
  }
  // Keep `disabled` in sync with `status`
  if (patch.status === 'disabled') tenant.disabled = true;
  if (patch.status === 'active') tenant.disabled = false;
  tenant.updated_at = new Date().toISOString();
  applyEnvOverrides(tenant);
  return true;
}

/**
 * Add/replace an in-memory tenant record wholesale (used by create flow).
 */
function upsertTenant(tenant) {
  return Boolean(applyDbTenant(tenant));
}

/** Remove a tenant from memory only. Legacy aliases never own a registry row. */
function removeTenant(key) {
  if (isLegacyTenantKey(key)) return false;
  return registry.delete(canonicalTenantKey(key));
}

/**
 * Compute an HMAC-SHA512 signature of a raw body for a tenant, using the
 * tenant's dedicated webhook_signing_secret. This is what the tenant uses
 * to verify that the webhook POST came from Valmont-Pay, not a spoofer.
 * Header: x-valmontpay-signature.
 *
 * @param {string|Buffer} rawBody
 * @param {string} tenantKey
 * @returns {string|null} hex signature, or null if tenant/secret missing
 */
function signWebhookBody(rawBody, tenantKey) {
  const tenant = getTenant(tenantKey);
  if (!tenant || !tenant.webhook_signing_secret) return null;
  return crypto
    .createHmac('sha512', tenant.webhook_signing_secret)
    .update(rawBody)
    .digest('hex');
}

/** Verify a tenant-side HMAC signature (constant-time). */
function verifyWebhookSignature(rawBody, signature, tenantKey) {
  const expected = signWebhookBody(rawBody, tenantKey);
  if (!expected || !signature) return false;
  const a = Buffer.from(String(signature).trim().toLowerCase());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Rotate API secrets for a tenant.
 * The old secret_2 becomes secret_1, and a new secret_2 is generated.
 * During rotation both old and new secrets are valid.
 * @param {string} key
 * @returns {{secret_1: string, secret_2: string}|null}
 */
function rotateTenantSecrets(key) {
  const tenant = getTenant(key);
  if (!tenant) return null;

  const newSecret = `vmp_${key}_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}`;

  if (tenant.secret_keys.length >= 2) {
    tenant.secret_keys = [tenant.secret_keys[1], newSecret];
  } else if (tenant.secret_keys.length === 1) {
    tenant.secret_keys = [tenant.secret_keys[0], newSecret];
  } else {
    tenant.secret_keys = [newSecret];
  }

  tenant.updated_at = new Date().toISOString();

  return {
    secret_1: tenant.secret_keys[0] || '',
    secret_2: tenant.secret_keys[1] || ''
  };
}

/**
 * Sanitise a tenant object for external consumption (no secrets exposed).
 * @param {object} tenant
 * @returns {object}
 */
function sanitiseTenant(tenant) {
  if (!tenant) return null;
  return {
    key: tenant.key,
    display_name: tenant.display_name,
    brand_color: tenant.brand_color,
    logo_url: tenant.logo_url,
    currency: tenant.currency,
    allowed_domains: tenant.allowed_domains,
    settlement_account: tenant.settlement_account,
    webhook_url: tenant.webhook_url,
    environment: tenant.environment,
    created_at: tenant.created_at,
    updated_at: tenant.updated_at
  };
}

/**
 * The strictly-public projection of a tenant: BRANDING ONLY.
 *
 * sanitiseTenant() correctly withholds secrets, but it still exposes
 * commercially sensitive operational data — the settlement bank account,
 * the tenant's webhook URL, its allowed domains and environment. Those were
 * readable by anyone on `GET /api/tenants`. A checkout page only ever needs
 * to know what to *render*, so that is all an unauthenticated caller gets.
 */
function publicTenant(tenant) {
  if (!tenant) return null;
  return {
    key: tenant.key,
    display_name: tenant.display_name,
    brand_color: tenant.brand_color,
    logo_url: tenant.logo_url,
    currency: tenant.currency
  };
}

/**
 * Validate a callback URL against a tenant's allowed domains.
 * @param {object} tenant
 * @param {string} callbackUrl
 * @returns {{valid: boolean, reason?: string}}
 */
function validateCallbackUrl(tenant, callbackUrl) {
  if (!tenant || !callbackUrl) {
    return { valid: false, reason: 'Missing tenant or callback URL' };
  }

  try {
    const url = new URL(callbackUrl);
    const hostname = url.hostname.toLowerCase();

    // Allow localhost in development
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return { valid: true };
    }

    const allowed = (tenant.allowed_domains || []).map(d => d.toLowerCase().trim()).filter(Boolean);

    // Check if the hostname matches any allowed domain or is a subdomain
    const matches = allowed.some(domain => {
      if (hostname === domain) return true;
      if (hostname.endsWith('.' + domain)) return true;
      return false;
    });

    if (!matches) {
      return {
        valid: false,
        reason: `Domain "${hostname}" is not in the allowlist for this merchant`
      };
    }

    return { valid: true };
  } catch (_) {
    return { valid: false, reason: 'Invalid callback URL format' };
  }
}

module.exports = {
  SERVICE_MERCHANT_KEY,
  SERVICE_MERCHANT_NAME,
  LEGACY_TENANT_ALIASES,
  canonicalTenantKey,
  isLegacyTenantKey,
  isCatalogueMerchantDisplayName,
  validateTenantIdentityForCreate,
  validateTenantIdentityForUpdate,
  getTenant,
  getTenantByIdentifier,
  getTenantBySecretKey,
  listTenants,
  listAllTenants,
  setTenantWebhookUrl,
  updateTenantInMemory,
  upsertTenant,
  removeTenant,
  rotateTenantSecrets,
  sanitiseTenant,
  publicTenant,
  validateCallbackUrl,
  signWebhookBody,
  verifyWebhookSignature,
  refreshFromDb,
  getDbRefreshState,
  applyDbTenant,
  resetRegistryForTests: init,
  registry,
  DEFAULT_TENANTS,
  ELECTRICALS_WEBHOOK_URL
};
// Tenant API keys endpoint
