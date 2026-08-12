const { resolveSigningSecret } = require('../lib/tenant-webhook-forwarder');
const assert = require('assert');

assert.strictEqual(
  resolveSigningSecret({ key: 't', webhook_signing_secret: null, paystack_secret_key: 'sk_' }),
  null
);
console.log('✓ signing refuses Paystack-key fallback');
