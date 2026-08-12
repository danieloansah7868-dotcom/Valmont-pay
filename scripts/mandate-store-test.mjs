#!/usr/bin/env node

/**
 * Offline unit test for lib/mandate-store.js — merchant-initiated standing
 * mandates & auto-renewals.
 *
 * Tests:
 *   - buildMandateRecord normalization & whitelisting
 *   - saveMandate & getMandate (in-memory + Supabase stub)
 *   - saveMandateFromAuthorization (extracting reusable authorizations from webhook/verify data)
 *   - listMandates filtering by merchant_name, customer_email, and status
 *   - revokeMandate opt-out compliance (setting status to REVOKED)
 *   - chargeMandate rejecting inactive/revoked mandates and recording transactions
 */

import assert from 'node:assert/strict';

// This is an OFFLINE suite (see the docblock): every Supabase interaction is
// either skipped or served by the stub client below. CI injects real Supabase
// credentials for the persistence-specific suites later in `npm test`, so they
// must be cleared here — otherwise `setSupabaseClient(null)`, which the
// "Supabase is not configured" cases use to mean "no client", falls through to
// the env-built client in resolveClient() and the test attempts a live network
// write. The sibling offline suites (api-smoke-test, dashboard-ledger-test,
// mandate-api-test) already do exactly this.
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  delete process.env[name];
}

const mandateStore = (await import('../lib/mandate-store.js')).default;
const {
  buildMandateRecord,
  saveMandate,
  saveMandateFromAuthorization,
  getMandate,
  listMandates,
  revokeMandate,
  chargeMandate,
  setSupabaseClient,
  clearInMemoryMandates
} = mandateStore;

// In-memory Supabase stub
function makeStubClient() {
  const table = new Map();
  const calls = [];
  return {
    table,
    calls,
    from(name) {
      assert.equal(name, 'mandates', 'Mandates store must write to table "mandates"');
      return {
        upsert(row, options) {
          calls.push({ op: 'upsert', row, options });
          table.set(row.authorization_code, row);
          return {
            select() {
              return Promise.resolve({ data: [row], error: null });
            }
          };
        },
        select() {
          let rows = Array.from(table.values());
          const builder = {
            eq(col, val) {
              rows = rows.filter(r => r[col] === val);
              return builder;
            },
            order(col, opts) {
              return builder;
            },
            limit(n) {
              rows = rows.slice(0, n);
              return builder;
            },
            then(resolve, reject) {
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            }
          };
          return builder;
        }
      };
    }
  };
}

let passed = 0;
function pass(message) {
  passed += 1;
  console.log(`  ✓ ${message}`);
}

console.log('\n# lib/mandate-store.js');

// 1. Normalization & whitelisting
const record = buildMandateRecord({
  authorization_code: 'AUTH_12345',
  reference: 'VP-TEST-MANDATE-1',
  customer_email: 'buyer@example.com',
  merchant_name: 'Valmont Electricals',
  payment_method: 'Momo (MTN)',
  bank: 'MTN',
  amount: '50.00',
  currency: 'GHS',
  status: 'active'
});
assert.equal(record.authorization_code, 'AUTH_12345');
assert.equal(record.reference, 'VP-TEST-MANDATE-1');
assert.equal(record.customer_email, 'buyer@example.com');
assert.equal(record.merchant_name, 'Valmont Electricals');
assert.equal(record.payment_method, 'Momo (MTN)');
assert.equal(record.bank, 'MTN');
assert.equal(record.amount, 50);
assert.equal(record.status, 'ACTIVE');
pass('buildMandateRecord normalizes and whitelists fields');

// 2. In-memory save and get
clearInMemoryMandates();
setSupabaseClient(null);

const saveRes = await saveMandate({
  authorization_code: 'AUTH_MEM_ONLY',
  reference: 'VP-REF-1',
  customer_email: 'mem@example.com',
  merchant_name: 'Valmont Electricals',
  status: 'ACTIVE'
});
assert.equal(saveRes.ok, true);
assert.equal(saveRes.skipped, true); // No Supabase client
const fetched = await getMandate('AUTH_MEM_ONLY');
assert.equal(fetched.authorization_code, 'AUTH_MEM_ONLY');
assert.equal(fetched.customer_email, 'mem@example.com');
pass('in-memory save and get work when Supabase is not configured');

// 3. Supabase stub persistence
const stubClient = makeStubClient();
setSupabaseClient(stubClient);
clearInMemoryMandates();

const dbSaveRes = await saveMandate({
  authorization_code: 'AUTH_DB_1',
  reference: 'VP-REF-DB-1',
  customer_email: 'db@example.com',
  merchant_name: 'Nanahemaa Market',
  amount: 100,
  status: 'ACTIVE'
});
assert.equal(dbSaveRes.ok, true);
assert.equal(dbSaveRes.skipped, false);
assert.equal(stubClient.table.get('AUTH_DB_1').reference, 'VP-REF-DB-1');
pass('saveMandate upserts record into Supabase');

// 4. saveMandateFromAuthorization helper
const webhookData = {
  reference: 'VP-WEBHOOK-AUTH-1',
  amount: 2500, // 25.00 GHS in subunits
  customer: { email: 'momo_buyer@example.com' },
  authorization: {
    authorization_code: 'AUTH_MTN_SI_001',
    reusable: true,
    channel: 'mobile_money',
    bank: 'MTN'
  },
  metadata: {
    merchant_name: 'Valmont Electricals',
    mandate_type: 'standing_instruction'
  }
};
const authSaveRes = await saveMandateFromAuthorization(webhookData);
assert.equal(authSaveRes.ok, true);
assert.equal(stubClient.table.get('AUTH_MTN_SI_001').customer_email, 'momo_buyer@example.com');
assert.equal(stubClient.table.get('AUTH_MTN_SI_001').amount, 25);
assert.equal(stubClient.table.get('AUTH_MTN_SI_001').bank, 'MTN');
pass('saveMandateFromAuthorization extracts reusable code from Paystack payload');

// 5. listMandates with filtering
await saveMandate({
  authorization_code: 'AUTH_DB_2',
  reference: 'VP-REF-DB-2',
  customer_email: 'db@example.com',
  merchant_name: 'Nanahemaa Market',
  status: 'REVOKED'
});
const listNana = await listMandates({ merchant_name: 'Nanahemaa Market' });
assert.equal(listNana.ok, true);
assert.equal(listNana.mandates.length, 2); // AUTH_DB_1 and AUTH_DB_2

const listActive = await listMandates({ merchant_name: 'Nanahemaa Market', status: 'ACTIVE' });
assert.equal(listActive.mandates.length, 1);
assert.equal(listActive.mandates[0].authorization_code, 'AUTH_DB_1');
pass('listMandates filters by merchant_name and status');

// 6. revokeMandate (consumer protection opt-out)
const revokeRes = await revokeMandate('AUTH_DB_1');
assert.equal(revokeRes.ok, true);
const revokedMandate = await getMandate('AUTH_DB_1');
assert.equal(revokedMandate.status, 'REVOKED');
pass('revokeMandate changes mandate status to REVOKED');

// 7. chargeMandate rejects inactive/revoked mandate
const chargeRevoked = await chargeMandate({
  authorization_code: 'AUTH_DB_1',
  amount: 50
});
assert.equal(chargeRevoked.ok, false);
assert.match(chargeRevoked.reason, /REVOKED/);
pass('chargeMandate refuses to charge a REVOKED mandate');

// 8. chargeMandate calls Paystack and records transaction in ledger
const origFetch = globalThis.fetch;
let chargedPayload = null;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/transaction/charge_authorization')) {
    chargedPayload = JSON.parse(opts.body);
    return {
      json: async () => ({
        status: true,
        message: 'Charge attempted',
        data: {
          status: 'success',
          reference: chargedPayload.reference,
          amount: chargedPayload.amount
        }
      })
    };
  }
  return origFetch(url, opts);
};

process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_fake_key_for_mandate_test';

const chargeRes = await chargeMandate({
  authorization_code: 'AUTH_MTN_SI_001',
  amount: 25,
  reference: 'VP-MANDATE-CHARGE-1',
  merchant: 'Valmont Electricals'
});
assert.equal(chargeRes.ok, true);
assert.equal(chargeRes.transaction.reference, 'VP-MANDATE-CHARGE-1');
assert.equal(chargeRes.transaction.status, 'SUCCESS');
assert.equal(chargeRes.transaction.amount, 25);
assert.equal(chargedPayload.authorization_code, 'AUTH_MTN_SI_001');
assert.equal(chargedPayload.amount, 2500); // 25 GHS in subunits
pass('chargeMandate executes recurring charge and logs SUCCESS transaction');

globalThis.fetch = origFetch;

console.log(`\n✓ lib/mandate-store.js: all ${passed} tests passed.\n`);
