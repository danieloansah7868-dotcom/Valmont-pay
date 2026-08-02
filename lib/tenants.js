/**
 * Multi-tenant registry.
 *
 * Every tenant (merchant) is resolved server-side by a stable lowercase key.
 * Never render client-supplied branding — the logo, brand colour, and display
 * name all come from this registry.
 *
 * Tenant configuration is sourced from environment variables, following the
 * pattern:
 *
 *   TENANT__{KEY}__DISPLAY_NAME=Valmont Electricals
 *   TENANT__{KEY}__BRAND_COLOR=#f68b1e
 *   TENANT__{KEY}__CURRENCY=GHS
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
 * The initial tenants (valmont-electricals, valmontweb) are seeded from defaults
 * when no env config is present, so local development works out of the box.
 */

const crypto = require('crypto');
const tenantStore = require('./tenant-store');

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
    webhook_url: 'https://valmontelectricals.com/api/valmontpay/webhook',
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
    environment: (process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_') ? 'live' : 'test',
    status: 'active',
    disabled: false,
    paystack_subaccount: process.env.TENANT__VALMONT_ELECTRICALS__PAYSTACK_SUBACCOUNT || '',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
  },
  'valmontweb': {
    key: 'valmontweb',
    display_name: 'Valmont Web',
    brand_color: '#2563eb',
    logo_url: '/logo.svg',
    currency: 'GHS',
    allowed_domains: ['valmontweb.com', 'valmontpay.app', 'localhost'],
    settlement_account: 'GCB Bank - 0987654321',
    webhook_url: '',
    paystack_secret_key: process.env.PAYSTACK_SECRET_KEY || '',
    paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY || '',
    secret_keys: [
      process.env.TENANT__VALMONTWEB__SECRET_KEY_1 || 'vmw_secret_dev_key_1',
      process.env.TENANT__VALMONTWEB__SECRET_KEY_2 || ''
    ].filter(Boolean),
    public_key: process.env.TENANT__VALMONTWEB__PUBLIC_KEY || 'vmw_pub_dev_key_1',
    webhook_signing_secret: process.env.TENANT__VALMONTWEB__WEBHOOK_SIGNING_SECRET
      || process.env.WEBHOOK_SECRET
      || 'vmw_webhook_signing_dev_1',
    environment: (process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_') ? 'live' : 'test',
    status: 'active',
    disabled: false,
    paystack_subaccount: '',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
  }
};

// ─── Load tenants from environment ───────────────────────────────────────

const registry = new Map();

function envToTenantKey(envName) {
  // TENANT__FOO__DISPLAY_NAME -> foo
  const parts = envName.split('__');
  if (parts.length >= 2 && parts[0] === 'TENANT') {
    return parts.slice(1, -1).join('__').toLowerCase();
  }
  return null;
}

/**
 * Load a single tenant from its prefixed environment variables.
 * Returns null if the tenant key cannot be determined.
 */
function loadTenantFromEnv(envName, value) {
  const key = envToTenantKey(envName);
  if (!key) return null;

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
      environment: (process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_') ? 'live' : 'test',
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
      const key = String(t.key).toLowerCase();
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
        environment: t.environment || ((process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_') ? 'live' : 'test'),
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
  // Try TENANTS_JSON first (explicit full config)
  if (process.env.TENANTS_JSON) {
    loadTenantsFromJson(process.env.TENANTS_JSON);
    // Fall back to defaults if nothing was loaded
    if (registry.size === 0) {
      for (const [key, tenant] of Object.entries(DEFAULT_TENANTS)) {
        registry.set(key, { ...tenant });
      }
    }
    return;
  }

  // Scan env vars for TENANT__ prefixed keys
  let envFound = false;
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('TENANT__')) {
      loadTenantFromEnv(name, value);
      envFound = true;
    }
  }

  // Apply specific env-var overrides for default tenants
  for (const [key, defaults] of Object.entries(DEFAULT_TENANTS)) {
    if (!registry.has(key)) {
      registry.set(key, { ...defaults });
    } else {
      // Apply PAYSTACK_SECRET_KEY from the tenant-specific env
      const tenant = registry.get(key);
      const envPrefix = `TENANT__${key.toUpperCase().replace(/-/g, '_')}__`;

      const psKey = process.env[`${envPrefix}PAYSTACK_SECRET_KEY`];
      if (psKey) tenant.paystack_secret_key = psKey;

      const psPubKey = process.env[`${envPrefix}PAYSTACK_PUBLIC_KEY`];
      if (psPubKey) tenant.paystack_public_key = psPubKey;

      const secret1 = process.env[`${envPrefix}SECRET_KEY_1`];
      if (secret1) {
        tenant.secret_keys = [secret1];
        const secret2 = process.env[`${envPrefix}SECRET_KEY_2`];
        if (secret2) tenant.secret_keys.push(secret2);
      }

      const pubKey = process.env[`${envPrefix}PUBLIC_KEY`];
      if (pubKey) tenant.public_key = pubKey;

      const displayName = process.env[`${envPrefix}DISPLAY_NAME`];
      if (displayName) tenant.display_name = displayName;

      const brandColor = process.env[`${envPrefix}BRAND_COLOR`];
      if (brandColor) tenant.brand_color = brandColor;

      const currency = process.env[`${envPrefix}CURRENCY`];
      if (currency) tenant.currency = currency;

      const domains = process.env[`${envPrefix}ALLOWED_DOMAINS`];
      if (domains) tenant.allowed_domains = domains.split(',').map(d => d.trim()).filter(Boolean);

      const account = process.env[`${envPrefix}SETTLEMENT_ACCOUNT`];
      if (account) tenant.settlement_account = account;

      const webhookUrl = process.env[`${envPrefix}WEBHOOK_URL`];
      if (webhookUrl) tenant.webhook_url = webhookUrl;

      const signingSecret = process.env[`${envPrefix}WEBHOOK_SIGNING_SECRET`];
      if (signingSecret) tenant.webhook_signing_secret = signingSecret;

      const subaccount = process.env[`${envPrefix}PAYSTACK_SUBACCOUNT`];
      if (subaccount) tenant.paystack_subaccount = subaccount;
    }
  }

  // If still nothing, seed defaults for local dev
  if (registry.size === 0) {
    for (const [key, tenant] of Object.entries(DEFAULT_TENANTS)) {
      registry.set(key, { ...tenant });
    }
  }
}

/**
 * Merge a DB-loaded tenant into the registry (overwriting env/defaults).
 * @param {object} dbTenant - shape returned by tenant-store.rowToTenant()
 */
function applyDbTenant(dbTenant) {
  if (!dbTenant || !dbTenant.key) return;
  registry.set(dbTenant.key, { ...dbTenant });
}

/**
 * Re-load tenants from Supabase and merge into the in-memory registry.
 * Safe to call on server boot and after every CRUD mutation.
 * DB rows override env/defaults; rows disabled in DB stay in the
 * registry but are flagged `disabled: true` so callers can refuse
 * to create payments for them.
 * @returns {Promise<number>} number of tenants loaded from DB
 */
async function refreshFromDb() {
  try {
    const { ok, tenants: dbTenants, reason } = await tenantStore.loadTenants();
    if (!ok) {
      console.log('[TENANTS] DB refresh skipped:', reason);
      return 0;
    }
    for (const t of dbTenants) {
      applyDbTenant(t);
    }
    console.log(`[TENANTS] Loaded ${dbTenants.length} tenant(s) from Supabase`);
    return dbTenants.length;
  } catch (err) {
    console.log('[TENANTS] DB refresh failed:', err.message);
    return 0;
  }
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
  return registry.get(String(key).toLowerCase());
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
      has_secret_keys: t.secret_keys.length > 0,
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
    has_secret_keys: t.secret_keys.length > 0,
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
  const tenant = getTenant(key);
  if (!tenant) return false;
  tenant.webhook_url = String(webhookUrl || '');
  tenant.updated_at = new Date().toISOString();
  return true;
}

/**
 * Update multiple fields of an in-memory tenant record at once.
 * Used by server endpoints that persist to Supabase first then sync memory.
 */
function updateTenantInMemory(key, patch) {
  const tenant = getTenant(key) || (registry.has(key) ? registry.get(key) : null);
  if (!tenant) return false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    tenant[k] = v;
  }
  // Keep `disabled` in sync with `status`
  if (patch.status === 'disabled') tenant.disabled = true;
  if (patch.status === 'active') tenant.disabled = false;
  tenant.updated_at = new Date().toISOString();
  return true;
}

/**
 * Add/replace an in-memory tenant record wholesale (used by create flow).
 */
function upsertTenant(tenant) {
  if (!tenant || !tenant.key) return false;
  registry.set(tenant.key, { ...tenant });
  return true;
}

/** Remove a tenant from memory only. */
function removeTenant(key) {
  return registry.delete(String(key || '').toLowerCase());
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
  getTenant,
  getTenantBySecretKey,
  listTenants,
  listAllTenants,
  setTenantWebhookUrl,
  updateTenantInMemory,
  upsertTenant,
  removeTenant,
  rotateTenantSecrets,
  sanitiseTenant,
  validateCallbackUrl,
  signWebhookBody,
  verifyWebhookSignature,
  refreshFromDb,
  applyDbTenant,
  registry,
  DEFAULT_TENANTS
};
// Tenant API keys endpoint
