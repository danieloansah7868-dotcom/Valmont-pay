const { resolveSigningSecret } = require('../lib/tenant-webhook-forwarder');
const assert = require('assert');
describe('signing', () => {
  it('refuses PAYSTACK fallback', () => {
    assert.strictEqual(resolveSigningSecret({key:'t', webhook_signing_secret:null, paystack_secret_key:'sk_'}) , null);
  });
});
