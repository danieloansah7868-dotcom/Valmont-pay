#!/usr/bin/env node

/**
 * Offline integration test for the Vercel webhook. It signs the exact raw JSON
 * bytes and injects a Supabase stub, so no Paystack/Supabase credentials or
 * network calls are needed.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

process.env.WEBHOOK_SECRET = 'offline-webhook-test-secret';
process.env.SUPABASE_URL = 'https://offline-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-test-service-role-key';

const { createWebhookHandler } = await import('../api/webhook.js');

// The webhook now writes through the shared transaction store, which UPSERTS
// on `reference` so Paystack's retries stay idempotent.
const insertedRows = [];
let nextInsertResult = null;
const fakeSupabase = {
  from(table) {
    assert.equal(table, 'transactions');
    return {
      upsert(row, options) {
        assert.deepEqual(options, { onConflict: 'reference' }, 'must upsert on reference');
        assert.ok(!('updated_at' in row), 'must never send an updated_at column');
        insertedRows.push(row);
        return {
          async select() {
            return nextInsertResult || { data: [row], error: null };
          }
        };
      }
    };
  }
};

const forwarded = [];
const effectiveTenant = {
  key: 'valmont-electricals',
  display_name: 'Valmont Electricals',
  currency: 'GHS',
  webhook_url: 'https://valmontelectricals.com/api/valmontpay/webhook',
  webhook_signing_secret: 'offline-tenant-signing-secret'
};
const fakeTenantRegistry = {
  async refreshFromDb({ client }) {
    assert.equal(client, fakeSupabase);
    return 1;
  },
  getTenantByIdentifier(identifier) {
    return ['Valmont Electricals', 'valmont-electricals'].includes(identifier)
      ? effectiveTenant
      : undefined;
  }
};
const fakeTenantForwarder = {
  async dispatchWebhook(tenant, eventName, data, reference) {
    forwarded.push({ tenant, eventName, data, reference });
    return { ok: true, statusCode: 200 };
  }
};

const handler = createWebhookHandler({
  supabaseClient: fakeSupabase,
  tenantRegistry: fakeTenantRegistry,
  tenantWebhookForwarder: fakeTenantForwarder
});

function sign(rawBody) {
  return crypto
    .createHmac('sha512', process.env.WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
}

function request(method, rawBody = '', signature = '') {
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    'x-paystack-signature': signature,
    'user-agent': 'offline-webhook-test'
  };
  return req;
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function invoke(method, rawBody = '', signature = '') {
  const res = response();
  await handler(request(method, rawBody, signature), res);
  return res;
}

let res = await invoke('GET');
assert.equal(res.statusCode, 405);
assert.equal(res.headers.Allow, 'POST');

const event = {
  event: 'charge.success',
  data: {
    reference: 'VP-WEBHOOK-TEST-1',
    amount: 12550,
    channel: 'mobile_money',
    paid_at: '2026-07-28T08:00:00.000Z',
    customer: { email: 'buyer@example.com' },
    authorization: { bank: 'MTN' },
    metadata: { merchant: 'Valmont Electricals' }
  }
};
// Whitespace is intentional: verification must use these exact bytes rather
// than JSON.stringify() on an already parsed object.
const rawBody = JSON.stringify(event, null, 2);

res = await invoke('POST', rawBody, 'not-a-valid-signature');
assert.equal(res.statusCode, 400);
assert.equal(insertedRows.length, 0);

res = await invoke('POST', rawBody, sign(rawBody));
assert.equal(res.statusCode, 200);
assert.equal(res.body.success, true);
assert.deepEqual(insertedRows[0], {
  reference: 'VP-WEBHOOK-TEST-1',
  merchant_name: 'Valmont Electricals',
  customer_email: 'buyer@example.com',
  amount: 125.5,
  payment_method: 'Mobile Money (MTN)',
  status: 'SUCCESS',
  paid_at: '2026-07-28T08:00:00.000Z'
});
assert.equal(forwarded.length, 1, 'the Vercel webhook must invoke the tenant forwarder');
assert.equal(forwarded[0].tenant.webhook_url, 'https://valmontelectricals.com/api/valmontpay/webhook');
assert.equal(forwarded[0].eventName, 'charge.success');
assert.equal(forwarded[0].reference, 'VP-WEBHOOK-TEST-1');
assert.equal(forwarded[0].data.amount, 125.5);

nextInsertResult = {
  data: null,
  error: { message: 'offline Supabase insert failure' }
};
const failedEvent = {
  event: 'charge.failed',
  data: {
    reference: 'VP-WEBHOOK-TEST-2',
    amount: '5000',
    channel: 'card',
    customer: { email: 'failed@example.com' }
  }
};
const failedRawBody = JSON.stringify(failedEvent);
res = await invoke('POST', failedRawBody, sign(failedRawBody));
assert.equal(res.statusCode, 500);
assert.equal(res.body.error, 'Failed to save transaction');
assert.equal(insertedRows[1].amount, 50);
assert.equal(insertedRows[1].paid_at, null);

console.log('✓ Vercel webhook signature, persistence, effective-tenant forwarding, and errors passed');
