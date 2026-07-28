/**
 * Merchant registry.
 *
 * A merchant owns:
 *   - a name ("Valmont Electricals")
 *   - two keypairs (test + live) — see lib/keys.js
 *   - one webhook URL per mode
 *
 * Authentication for the merchant API is "present a secret key". The key both
 * identifies the merchant AND selects the mode, so a sk_test_ key can never
 * touch live records and vice versa.
 *
 * Bootstrapping: on first boot a merchant is created from
 * VALMONTPAY_MERCHANT_NAME (default "Valmont Electricals"). Its keys are
 * generated once and persisted, or taken from
 * VALMONTPAY_TEST_SECRET_KEY / VALMONTPAY_TEST_PUBLIC_KEY /
 * VALMONTPAY_LIVE_SECRET_KEY / VALMONTPAY_LIVE_PUBLIC_KEY when you want to pin
 * them (e.g. so a serverless deployment with an ephemeral filesystem keeps the
 * same keys across cold starts — strongly recommended in production).
 */

const crypto = require('crypto');
const keys = require('./keys');
const { collection } = require('./data-store');

const store = collection('merchants');

function newMerchantId() {
  return `mch_${crypto.randomBytes(9).toString('hex')}`;
}

function envKeypair(mode) {
  const upper = mode.toUpperCase();
  const secret = process.env[`VALMONTPAY_${upper}_SECRET_KEY`];
  const publicKey = process.env[`VALMONTPAY_${upper}_PUBLIC_KEY`];
  if (!secret && !publicKey) return null;
  const generated = keys.generateKeypair(mode);
  return {
    mode,
    public_key: publicKey || generated.public_key,
    secret_key: secret || generated.secret_key
  };
}

/**
 * Create a merchant with a fresh (or env-pinned) key set.
 * @param {{name:string, id?:string, webhooks?:object}} input
 */
function createMerchant(input = {}) {
  const id = input.id || newMerchantId();
  const record = {
    id,
    name: String(input.name || 'Valmont-Pay'),
    created_at: new Date().toISOString(),
    keys: {
      test: envKeypair('test') || keys.generateKeypair('test'),
      live: envKeypair('live') || keys.generateKeypair('live')
    },
    // Where terminal-state webhooks are POSTed, per mode.
    webhooks: {
      test: { url: process.env.VALMONTPAY_TEST_WEBHOOK_URL || null, updated_at: null },
      live: { url: process.env.VALMONTPAY_LIVE_WEBHOOK_URL || null, updated_at: null }
    }
  };
  store.set(id, record);
  console.log(
    `[MERCHANT] Created ${record.name} (${id}) test=${keys.redact(record.keys.test.public_key)} live=${keys.redact(record.keys.live.public_key)}`
  );
  return record;
}

/**
 * The default merchant, created on first call. Single-tenant deployments (this
 * one) never need more; the store is keyed by id so multi-tenant is a matter of
 * calling createMerchant() again.
 */
function getDefaultMerchant() {
  const name = process.env.VALMONTPAY_MERCHANT_NAME || 'Valmont Electricals';
  const existing = store.find(m => m.name === name) || store.all()[0];
  if (existing) return reconcileWithEnv(existing);
  return createMerchant({ name });
}

/**
 * Env-pinned keys win over whatever is on disk, so rotating a key by changing
 * an environment variable actually takes effect.
 */
function reconcileWithEnv(merchant) {
  let changed = false;
  for (const mode of keys.MODES) {
    const fromEnv = envKeypair(mode);
    if (!fromEnv) continue;
    const current = merchant.keys[mode] || {};
    if (
      process.env[`VALMONTPAY_${mode.toUpperCase()}_SECRET_KEY`] &&
      current.secret_key !== fromEnv.secret_key
    ) {
      current.secret_key = fromEnv.secret_key;
      changed = true;
    }
    if (
      process.env[`VALMONTPAY_${mode.toUpperCase()}_PUBLIC_KEY`] &&
      current.public_key !== fromEnv.public_key
    ) {
      current.public_key = fromEnv.public_key;
      changed = true;
    }
    merchant.keys[mode] = current;
  }
  if (changed) store.set(merchant.id, merchant);
  return merchant;
}

function getMerchant(id) {
  return store.get(id);
}

function listMerchants() {
  return store.all();
}

/**
 * Resolve a secret key to { merchant, mode }.
 * Comparison is constant-time and checks BOTH modes, so a test key presented to
 * a live-only route fails as "unauthorized", never as "wrong mode".
 *
 * @returns {{merchant:object, mode:'test'|'live', keypair:object}|null}
 */
function authenticateSecretKey(secretKey) {
  if (!keys.isSecretKey(secretKey)) return null;
  // Touch the default merchant so a fresh deployment can authenticate the
  // env-pinned key before anything has been written to disk.
  getDefaultMerchant();
  for (const merchant of store.all()) {
    for (const mode of keys.MODES) {
      const pair = merchant.keys && merchant.keys[mode];
      if (pair && keys.keysMatch(pair.secret_key, secretKey)) {
        return { merchant, mode, keypair: pair };
      }
    }
  }
  return null;
}

/** Same, for a browser-safe public key (identifies a merchant, authorises nothing). */
function findByPublicKey(publicKey) {
  if (!keys.isPublicKey(publicKey)) return null;
  getDefaultMerchant();
  for (const merchant of store.all()) {
    for (const mode of keys.MODES) {
      const pair = merchant.keys && merchant.keys[mode];
      if (pair && pair.public_key === publicKey) return { merchant, mode, keypair: pair };
    }
  }
  return null;
}

/** The signing secret for a merchant's webhook deliveries in a given mode. */
function signingSecret(merchant, mode) {
  const pair = merchant && merchant.keys && merchant.keys[mode];
  return pair ? pair.secret_key : null;
}

function getWebhookUrl(merchant, mode) {
  const hook = merchant && merchant.webhooks && merchant.webhooks[mode];
  return (hook && hook.url) || null;
}

/**
 * Point a merchant's webhooks at a URL. `null` disables delivery.
 * HTTPS is required in live mode — an unencrypted webhook leaks payment data
 * and lets anyone on the path forge one.
 *
 * @returns {{ok:boolean, error?:string, merchant?:object}}
 */
function setWebhookUrl(merchantId, mode, url) {
  const merchant = store.get(merchantId);
  if (!merchant) return { ok: false, error: 'Unknown merchant' };
  if (!keys.MODES.includes(mode)) return { ok: false, error: 'Unknown mode' };

  let normalized = null;
  if (url) {
    let parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (_) {
      return { ok: false, error: 'Webhook URL must be a valid absolute URL' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: 'Webhook URL must use http or https' };
    }
    if (mode === 'live' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Live webhook URLs must use https' };
    }
    normalized = parsed.toString();
  }

  merchant.webhooks = merchant.webhooks || {};
  merchant.webhooks[mode] = { url: normalized, updated_at: new Date().toISOString() };
  store.set(merchant.id, merchant);
  console.log(`[MERCHANT] ${merchant.name} ${mode} webhook URL -> ${normalized || '(disabled)'}`);
  return { ok: true, merchant };
}

/** Rotate one mode's keypair. The old secret stops working immediately. */
function rotateKeys(merchantId, mode) {
  const merchant = store.get(merchantId);
  if (!merchant) return { ok: false, error: 'Unknown merchant' };
  if (!keys.MODES.includes(mode)) return { ok: false, error: 'Unknown mode' };
  merchant.keys[mode] = keys.generateKeypair(mode);
  store.set(merchant.id, merchant);
  console.log(`[MERCHANT] Rotated ${mode} keys for ${merchant.name}`);
  return { ok: true, keypair: merchant.keys[mode] };
}

/**
 * Merchant record safe to send to a browser: public keys in full, secret keys
 * redacted. The dashboard reveals a full secret only through an explicit,
 * separately authorised call.
 */
function toSafeJSON(merchant) {
  if (!merchant) return null;
  return {
    id: merchant.id,
    name: merchant.name,
    created_at: merchant.created_at,
    keys: {
      test: {
        public_key: merchant.keys.test.public_key,
        secret_key_preview: keys.redact(merchant.keys.test.secret_key)
      },
      live: {
        public_key: merchant.keys.live.public_key,
        secret_key_preview: keys.redact(merchant.keys.live.secret_key)
      }
    },
    webhooks: merchant.webhooks
  };
}

/** Test helper. */
function _reset() {
  store.clear();
}

module.exports = {
  store,
  createMerchant,
  getMerchant,
  getDefaultMerchant,
  listMerchants,
  authenticateSecretKey,
  findByPublicKey,
  signingSecret,
  getWebhookUrl,
  setWebhookUrl,
  rotateKeys,
  toSafeJSON,
  _reset
};
