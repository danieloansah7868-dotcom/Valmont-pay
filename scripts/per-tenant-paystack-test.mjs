#!/usr/bin/env node

/**
 * Per-tenant Paystack credentials.
 *
 * The gateway used to have exactly one Paystack account. Giving a tenant its
 * own account touches four call sites, and missing the webhook one produces
 * the worst possible failure in payments: Paystack takes the money, our
 * single-key verifier rejects the event as a forgery, and the payment never
 * reaches the ledger. The merchant is paid on Paystack and the gateway shows
 * nothing.
 *
 * These tests pin all four, and pin that a tenant WITHOUT its own credential
 * still behaves exactly as it does today.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const GLOBAL_SECRET = 'sk_live_GLOBAL_gateway_key';
const TENANT_SECRET = 'sk_live_TENANT_own_account_key';

process.env.PAYSTACK_SECRET_KEY = GLOBAL_SECRET;
delete process.env.WEBHOOK_SECRET;
process.env.TENANTS_JSON = JSON.stringify([
  {
    key: 'own-account-shop',
    display_name: 'Own Account Shop',
    paystack_secret_key: TENANT_SECRET,
    paystack_public_key: 'pk_live_TENANT_own_account_key'
  },
  {
    key: 'shared-account-shop',
    display_name: 'Shared Account Shop'
  }
]);

const tenants = require('../lib/tenants.js');
const paystackCredentials = require('../lib/paystack-credentials.js');
const webhook = require('../lib/webhook.js');
const ledger = require('../lib/ledger.js');

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
  console.log(`  ✓ ${message}`);
};

const sign = (body, secret) =>
  crypto.createHmac('sha512', secret).update(body).digest('hex');

console.log('\n# Credential selection');

const own = tenants.getTenant('own-account-shop');
const shared = tenants.getTenant('shared-account-shop');

check(own !== undefined, 'the tenant with its own Paystack account is registered');
check(shared !== undefined, 'the tenant without one is registered too');

check(
  paystackCredentials.chargeSecret(own) === TENANT_SECRET,
  'a tenant with its own credential charges on ITS account'
);
check(
  paystackCredentials.chargeSecret(shared) === GLOBAL_SECRET,
  'a tenant without one still charges on the gateway account (unchanged behaviour)'
);
check(paystackCredentials.hasOwnAccount(own) === true, 'hasOwnAccount is true for the tenant');
check(paystackCredentials.hasOwnAccount(shared) === false, 'hasOwnAccount is false otherwise');
check(
  paystackCredentials.chargeSecret(null) === GLOBAL_SECRET,
  'an unknown tenant falls back to the gateway credential'
);

const builtIns = ['valmont-electricals', 'valmont-web-services'];
for (const key of builtIns) {
  check(
    paystackCredentials.chargeSecret(tenants.getTenant(key)) === GLOBAL_SECRET,
    `${key} is unaffected (still uses the gateway credential)`
  );
}

console.log('\n# Webhook signature candidates');

const candidates = paystackCredentials.webhookSecretCandidates();
check(candidates.includes(GLOBAL_SECRET), 'the gateway secret is a candidate');
check(candidates.includes(TENANT_SECRET), 'the tenant secret is a candidate');
check(
  candidates.length === new Set(candidates).size,
  'candidates are de-duplicated (a shared key is not tried twice)'
);

const payload = {
  event: 'charge.success',
  data: {
    reference: 'OWN-ACCOUNT-1',
    amount: 150000,
    currency: 'GHS',
    channel: 'mobile_money',
    status: 'success',
    metadata: { merchant: 'own-account-shop' },
    customer: { email: 'buyer@example.com' }
  }
};
const raw = Buffer.from(JSON.stringify(payload), 'utf8');

check(
  paystackCredentials.matchesAnyWebhookSecret(raw, sign(raw, TENANT_SECRET)) === true,
  'an event signed by the TENANT account is accepted'
);
check(
  paystackCredentials.matchesAnyWebhookSecret(raw, sign(raw, GLOBAL_SECRET)) === true,
  'an event signed by the gateway account is accepted'
);
check(
  paystackCredentials.matchesAnyWebhookSecret(raw, sign(raw, 'sk_live_ATTACKER_key')) === false,
  'an event signed by an unknown key is rejected'
);
check(
  paystackCredentials.matchesAnyWebhookSecret(raw, sign(Buffer.from('tampered'), TENANT_SECRET)) === false,
  'a signature over a tampered body is rejected'
);
check(paystackCredentials.matchesAnyWebhookSecret(raw, '') === false, 'a missing signature is rejected');

console.log('\n# The end-to-end failure this guards against');

const tenantSigned = sign(raw, TENANT_SECRET);
const result = webhook.handleWebhookEvent(payload, tenantSigned, raw);

check(result.statusCode === 200, 'a tenant-signed charge.success is ACCEPTED, not 401');
check(result.body.transaction.reference === 'OWN-ACCOUNT-1', 'the reference is recorded');
check(
  ledger.findTransaction('OWN-ACCOUNT-1') !== undefined,
  'the payment reached the ledger (this is what used to be silently lost)'
);

const forged = webhook.handleWebhookEvent(payload, sign(raw, 'sk_live_ATTACKER_key'), raw);
check(forged.statusCode === 401, 'a forged event is still rejected');

const gatewayPayload = {
  event: 'charge.success',
  data: {
    reference: 'SHARED-ACCOUNT-1',
    amount: 5000,
    currency: 'GHS',
    channel: 'card',
    status: 'success',
    metadata: { merchant: 'shared-account-shop' },
    customer: { email: 'buyer@example.com' }
  }
};
const gatewayRaw = Buffer.from(JSON.stringify(gatewayPayload), 'utf8');
const gatewayResult = webhook.handleWebhookEvent(
  gatewayPayload, sign(gatewayRaw, GLOBAL_SECRET), gatewayRaw
);
check(gatewayResult.statusCode === 200, 'a gateway-signed event is accepted as before');

console.log('\n# Tenant attribution');

const attributed = paystackCredentials.resolveTenantForPayload(payload.data);
check(attributed && attributed.key === 'own-account-shop', 'metadata.merchant resolves the owning tenant');
check(
  paystackCredentials.resolveTenantForPayload({ metadata: { merchant: 'nobody' } }) === null,
  'an unknown merchant resolves to null rather than the wrong tenant'
);

console.log('\n# Per-tenant receipt routing');

// A new merchant must be able to receive its OWN receipts. Unset (every
// tenant that predates this) keeps the gateway-wide target.
process.env.TENANTS_JSON = JSON.stringify([
  {
    key: 'own-account-shop',
    display_name: 'Own Account Shop',
    paystack_secret_key: TENANT_SECRET,
    notification_phone: '0244000001',
    notification_email: 'shop@example.com'
  },
  { key: 'shared-account-shop', display_name: 'Shared Account Shop' }
]);
tenants.resetRegistryForTests();

process.env.MERCHANT_NOTIFICATION_PHONE = '0244000999';
process.env.MERCHANT_NOTIFICATION_EMAIL = 'gateway@example.com';

const notifier = require('../lib/notifier.js');

const ownContact = notifier.extractMerchantContact(
  { merchant: 'Own Account Shop' }, null
);
check(ownContact.phone === '0244000001', 'a tenant with its own phone receives there');
check(ownContact.email === 'shop@example.com', 'a tenant with its own email receives there');
check(ownContact.source.startsWith('tenant ('), 'the contact is attributed to the tenant');

const sharedContact = notifier.extractMerchantContact(
  { merchant: 'Shared Account Shop' }, null
);
check(
  sharedContact.phone === '0244000999',
  'a tenant without its own number still uses the gateway number (unchanged behaviour)'
);
check(sharedContact.email === 'gateway@example.com', '...and the gateway email');

// Legacy ledger rows carry a DISPLAY name, newer ones carry a key. Both work.
const byDisplayName = notifier.extractMerchantContact(
  { merchant: 'Own Account Shop' }, null
);
const byKey = notifier.extractMerchantContact({ merchant: 'own-account-shop' }, null);
check(byDisplayName.phone === byKey.phone, 'display name and tenant key resolve to the same contact');

const unknownContact = notifier.extractMerchantContact({ merchant: 'Who Dis' }, null);
check(unknownContact.phone === '0244000999', 'an unknown merchant falls back to the global target');
check(unknownContact.tenantKey === null, 'an unknown merchant is attributed to nobody');

delete process.env.MERCHANT_NOTIFICATION_PHONE;
delete process.env.MERCHANT_NOTIFICATION_EMAIL;
process.env.TENANTS_JSON = '';
delete process.env.TENANTS_JSON;

console.log(`\n✓ per-tenant Paystack: all ${checks} checks passed.\n`);
