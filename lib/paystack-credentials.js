/**
 * Which Paystack credential applies to this request?
 *
 * ─── Why this module exists ──────────────────────────────────────────────
 * The gateway grew up with ONE Paystack account: PAYSTACK_SECRET_KEY charged
 * every payment, signed every webhook and verified every reference. That is
 * still the correct default — and still exactly what happens for any tenant
 * that does not carry its own credential.
 *
 * Per-tenant Paystack changes four call sites at once, and missing any one of
 * them produces a payment that takes money but never lands on the ledger:
 *
 *   1. INITIALIZE  — charge on the tenant's account, not the gateway's.
 *   2. WEBHOOK     — a tenant's Paystack account signs with ITS secret key, so
 *                    a single-key verifier rejects every event it sends and
 *                    the payment is silently lost.
 *   3. VERIFY      — a reference only exists on the account that charged it.
 *   4. SPLIT       — paystack_subaccount, already per tenant.
 *
 * Everything here degrades to the global credential, so a tenant with no
 * configured key behaves precisely as it does today.
 */

const crypto = require('crypto');
const tenants = require('./tenants');

/** The gateway's own Paystack credential (the current behaviour). */
function globalSecret() {
  return (process.env.PAYSTACK_SECRET_KEY || '').trim();
}

function globalPublicKey() {
  return (process.env.PAYSTACK_PUBLIC_KEY || '').trim();
}

function ownSecret(tenant) {
  if (!tenant) return '';
  return typeof tenant.paystack_secret_key === 'string' ? tenant.paystack_secret_key.trim() : '';
}

/**
 * The secret that should CHARGE a payment for this tenant.
 * Falls back to the gateway credential, so an unconfigured tenant is
 * unaffected by any of this.
 */
function chargeSecret(tenant) {
  return ownSecret(tenant) || globalSecret();
}

/** The public key that belongs to `chargeSecret()` — never mixed across accounts. */
function chargePublicKey(tenant) {
  const own = tenant && typeof tenant.paystack_public_key === 'string'
    ? tenant.paystack_public_key.trim()
    : '';
  return own || (ownSecret(tenant) ? '' : globalPublicKey());
}

/**
 * True when this tenant pays through its own Paystack account.
 *
 * "Has a key" is not the same question: both TENANTS_JSON and the
 * TENANT__…__PAYSTACK_SECRET_KEY env defaults copy the GATEWAY credential
 * onto every tenant that does not name its own, so merely having a value
 * proves nothing. A tenant owns its account only when its key is a different
 * one.
 */
function hasOwnAccount(tenant) {
  const own = ownSecret(tenant);
  return Boolean(own) && own !== globalSecret();
}

/** Every tenant secret configured right now, de-duplicated. */
function tenantSecrets() {
  const found = [];
  const registry = tenants.registry;
  if (!registry || typeof registry.forEach !== 'function') return found;
  for (const tenant of registry.values()) {
    const key = ownSecret(tenant);
    if (key && !found.includes(key)) found.push(key);
  }
  return found;
}

/**
 * Every credential that may legitimately have signed an inbound Paystack
 * webhook: the gateway's own key, the legacy WEBHOOK_SECRET, and each
 * tenant's Paystack secret.
 */
function webhookSecretCandidates() {
  const list = [];
  const push = (value) => {
    const secret = typeof value === 'string' ? value.trim() : '';
    if (secret && !list.includes(secret)) list.push(secret);
  };
  push(process.env.PAYSTACK_SECRET_KEY);
  push(process.env.WEBHOOK_SECRET);
  for (const secret of tenantSecrets()) push(secret);
  return list;
}

/** Constant-time HMAC-SHA512 compare, as Paystack signs. */
function verifyHmac(rawBody, signature, secret) {
  if (!secret || !signature || rawBody === undefined || rawBody === null) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Does ANY configured credential validate this signature?
 *
 * Every candidate is always evaluated — the loop does not stop at the first
 * match — so the time taken does not reveal *which* key signed the event.
 * That costs microseconds and removes an oracle that would otherwise let an
 * attacker probe which tenants hold their own Paystack account.
 */
function matchesAnyWebhookSecret(rawBody, signature) {
  const candidates = webhookSecretCandidates();
  if (!candidates.length) return false;

  let matched = false;
  for (const secret of candidates) {
    if (verifyHmac(rawBody, signature, secret)) matched = true;
  }
  return matched;
}

/**
 * Attribute an inbound Paystack event to a tenant.
 * `metadata.merchant` is set by every initialization path in this codebase,
 * and it carries the tenant KEY (not the display name).
 */
function resolveTenantForPayload(data) {
  const merchant = data && data.metadata && data.metadata.merchant;
  if (!merchant) return null;
  return tenants.getTenant(merchant) || tenants.getTenantByIdentifier(merchant) || null;
}

module.exports = {
  globalSecret,
  globalPublicKey,
  chargeSecret,
  chargePublicKey,
  hasOwnAccount,
  tenantSecrets,
  webhookSecretCandidates,
  verifyHmac,
  matchesAnyWebhookSecret,
  resolveTenantForPayload
};
