/**
 * Paystack webhook handler (Vercel serverless function).
 *
 * The signature must be calculated from the exact bytes Paystack sent, so body
 * parsing is disabled for this function and the raw request stream is read
 * before the JSON payload is parsed.
 */

import crypto from 'node:crypto';
import supabaseModule from '../lib/supabase.js';
import transactionStore from '../lib/transaction-store.js';
import webhookLog from '../lib/webhook-log.js';
import notifierModule from '../lib/notifier.js';
import tenantsModule from '../lib/tenants.js';
import tenantWebhookForwarderModule from '../lib/tenant-webhook-forwarder.js';

const { getSupabaseClient, supabaseConfigState } = supabaseModule;
const { saveTransaction } = transactionStore;
const { recordWebhookHit, completeWebhookHit } = webhookLog;
const { sendOrderReceiptNotification } = notifierModule;

/**
 * Every log line from one request carries the same short id, so a single
 * delivery can be followed end-to-end in the Vercel runtime logs even when
 * several webhooks arrive at once.
 */
function newRequestId() {
  return `wh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Structured, greppable log line. Every step of the handler emits one. */
function step(requestId, stage, message, data) {
  const prefix = `[WEBHOOK ${requestId}] ${stage} — ${message}`;
  if (data === undefined) console.log(prefix);
  else console.log(prefix, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

/** Same as step(), but for failures — always includes the full stack trace. */
function failure(requestId, stage, message, error) {
  console.error(`[WEBHOOK ${requestId}] ${stage} — ✗ ${message}`);
  if (error) {
    console.error(`[WEBHOOK ${requestId}] ${stage} — error name:`, error.name || 'unknown');
    console.error(`[WEBHOOK ${requestId}] ${stage} — error message:`, error.message || String(error));
    console.error(`[WEBHOOK ${requestId}] ${stage} — stack trace:\n`, error.stack || '(no stack available)');
  }
}

/**
 * The secret Paystack signs webhooks with.
 *
 * Paystack computes `x-paystack-signature` with the Paystack secret key that
 * owns the transaction. That credential is authoritative whenever configured;
 * WEBHOOK_SECRET is retained only as a legacy fallback for local/custom events.
 * A stale test WEBHOOK_SECRET can therefore never make a live Paystack event
 * fail verification.
 */
export function getWebhookSecret() {
  return process.env.PAYSTACK_SECRET_KEY || process.env.WEBHOOK_SECRET || '';
}

// Vercel must not parse/re-serialize the payload before signature verification.
export const config = {
  api: {
    bodyParser: false
  }
};

/** Return a header value regardless of the casing used by a request mock. */
function getHeader(req, name) {
  const headers = req.headers || {};
  const directValue = headers[name.toLowerCase()];
  if (directValue !== undefined) {
    return Array.isArray(directValue) ? directValue[0] : directValue;
  }

  const matchingKey = Object.keys(headers).find(
    key => key.toLowerCase() === name.toLowerCase()
  );
  const value = matchingKey ? headers[matchingKey] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Read the exact request bytes. The fallbacks make the handler work with local
 * Express adapters and tests that provide req.rawBody or an already parsed
 * req.body, while production Vercel requests use the request stream.
 */
async function readRawBody(req) {
  return (await readRawBodyWithSource(req)).body;
}

/**
 * Read the body AND report where it came from.
 *
 * `source` matters enormously when debugging a signature failure:
 *
 *   'stream'      — the untouched bytes Paystack sent. Signature MUST verify.
 *   'raw-*'       — an adapter (our Express app) captured the exact bytes. Fine.
 *   'reserialized'— something already parsed the JSON, so all we can do is
 *                   JSON.stringify() it again. Key ORDER is preserved by V8 but
 *                   WHITESPACE IS NOT, so if Paystack sent pretty-printed JSON
 *                   the HMAC will not match no matter how correct the secret is.
 *                   Seeing this source in the logs means the platform parsed the
 *                   body despite `config.api.bodyParser = false`.
 */
async function readRawBodyWithSource(req) {
  if (Buffer.isBuffer(req.rawBody)) return { body: req.rawBody, source: 'raw-buffer' };
  if (typeof req.rawBody === 'string') return { body: Buffer.from(req.rawBody, 'utf8'), source: 'raw-string' };
  if (Buffer.isBuffer(req.body)) return { body: req.body, source: 'body-buffer' };
  if (typeof req.body === 'string') return { body: Buffer.from(req.body, 'utf8'), source: 'body-string' };

  if (req.body && typeof req.body === 'object') {
    return { body: Buffer.from(JSON.stringify(req.body), 'utf8'), source: 'reserialized' };
  }

  if (typeof req[Symbol.asyncIterator] !== 'function') {
    return { body: Buffer.alloc(0), source: 'unavailable' };
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { body: Buffer.concat(chunks), source: 'stream' };
}

/**
 * When the body had to be re-serialized we no longer hold Paystack's exact
 * bytes, so try the handful of encodings a JSON producer realistically emits.
 * If one of them matches, the payload IS authentic and we accept it rather than
 * dropping a real payment over a whitespace difference.
 *
 * @returns {{valid:boolean, matchedVariant:(string|null), body:Buffer}}
 */
function verifyWithVariants(rawBody, signature, secret, parsedBody) {
  if (verifySignature(rawBody, signature, secret)) {
    return { valid: true, matchedVariant: 'exact', body: rawBody };
  }

  if (!parsedBody || typeof parsedBody !== 'object') {
    return { valid: false, matchedVariant: null, body: rawBody };
  }

  const variants = [
    ['compact', JSON.stringify(parsedBody)],
    ['indent-2', JSON.stringify(parsedBody, null, 2)],
    ['indent-4', JSON.stringify(parsedBody, null, 4)],
    ['indent-tab', JSON.stringify(parsedBody, null, '\t')]
  ];

  for (const [name, text] of variants) {
    const candidate = Buffer.from(text, 'utf8');
    if (candidate.equals(rawBody)) continue;
    if (verifySignature(candidate, signature, secret)) {
      return { valid: true, matchedVariant: name, body: candidate };
    }
  }

  return { valid: false, matchedVariant: null, body: rawBody };
}

/** Verify an HMAC SHA-512 signature without timing-sensitive string compares. */
export function verifySignature(rawBody, signature, secret = getWebhookSecret()) {
  if (!secret || !signature || rawBody === undefined || rawBody === null) return false;

  const suppliedSignature = String(signature).trim().toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(suppliedSignature)) return false;

  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(suppliedSignature, 'hex');

  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function formatChannel(channel, authorization) {
  if (!channel) return 'Unknown';

  const normalized = String(channel).toLowerCase();
  if (normalized === 'mobile_money') {
    const bank = authorization && (authorization.bank || authorization.sender_bank);
    return bank ? `Mobile Money (${bank})` : 'Mobile Money';
  }
  if (normalized === 'card') {
    const brand = authorization && authorization.card_type;
    return brand ? `Card (${brand})` : 'Credit/Debit Card';
  }
  if (normalized === 'bank_transfer') return 'Bank Transfer';
  if (normalized === 'bank') return 'Bank';
  if (normalized === 'ussd') return 'USSD';
  if (normalized === 'qr') return 'QR';
  return String(channel);
}

function getMerchantName(metadata) {
  if (!metadata || typeof metadata !== 'object') return 'Valmont-Pay';
  if (metadata.merchant) return String(metadata.merchant);
  if (metadata.merchant_name) return String(metadata.merchant_name);

  const merchantField = Array.isArray(metadata.custom_fields)
    ? metadata.custom_fields.find(field => field && field.variable_name === 'merchant')
    : null;
  return merchantField && merchantField.value
    ? String(merchantField.value)
    : 'Valmont-Pay';
}

function transactionFromEvent(eventName, data) {
  const amountInSubunits = Number(data.amount);
  if (!Number.isFinite(amountInSubunits) || amountInSubunits < 0) {
    throw new Error('Webhook payload contains an invalid amount');
  }

  return {
    reference: String(data.reference),
    merchant_name: getMerchantName(data.metadata),
    customer_email: data.customer?.email || data.email || 'unknown@customer',
    // Paystack reports GHS payments in pesewas (the smallest currency unit).
    amount: amountInSubunits / 100,
    payment_method: formatChannel(data.channel, data.authorization),
    status: eventName === 'charge.success' ? 'SUCCESS' : 'FAILED',
    paid_at:
      data.paid_at ||
      data.paidAt ||
      (eventName === 'charge.success' ? data.created_at || new Date().toISOString() : null)
  };
}

function configurationState() {
  const supabase = supabaseConfigState();
  return {
    webhookSecretConfigured: Boolean(getWebhookSecret()),
    webhookSecretSource: process.env.PAYSTACK_SECRET_KEY
      ? 'PAYSTACK_SECRET_KEY'
      : process.env.WEBHOOK_SECRET
        ? 'WEBHOOK_SECRET (legacy fallback)'
        : null,
    supabaseUrlConfigured: supabase.urlConfigured,
    supabaseKeyConfigured: supabase.keyConfigured,
    supabaseCredentialType: supabase.credentialType
  };
}

/**
 * Factory exported for an offline integration test. Production uses the shared
 * Supabase client; tests can inject a client without contacting Supabase.
 */
export function createWebhookHandler({
  supabaseClient,
  tenantRegistry = tenantsModule,
  tenantWebhookForwarder = tenantWebhookForwarderModule
} = {}) {
  return async function webhookHandler(req, res) {
    const requestId = newRequestId();
    const startedAt = Date.now();
    let logEntry = null;

    // ---------------------------------------------------------------- STEP 1
    // A request arrived. Log this BEFORE anything can possibly throw, so the
    // runtime log proves whether Paystack reached us at all.
    console.log('════════════════════════════════════════════════════════');
    step(requestId, 'STEP 1/9 RECEIVED', `${req.method} ${req.url || '/api/webhook'}`, {
      method: req.method,
      url: req.url || null,
      timestamp: new Date().toISOString(),
      remoteAddress:
        getHeader(req, 'x-forwarded-for') ||
        (req.socket && req.socket.remoteAddress) ||
        null
    });

    if (req.method !== 'POST') {
      step(requestId, 'STEP 1/9 RECEIVED', `✗ rejected non-POST method: ${req.method}`);
      recordWebhookHit({
        endpoint: '/api/webhook',
        method: req.method,
        headers: req.headers,
        body: '',
        outcome: 'method-not-allowed',
        statusCode: 405
      });
      res.setHeader('Allow', 'POST');
      console.log('════════════════════════════════════════════════════════');
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    /** Log the verdict, close out the ring-buffer entry, and respond. */
    const finish = (statusCode, body, outcome, extra) => {
      const durationMs = Date.now() - startedAt;
      step(requestId, 'STEP 9/9 RESPONSE', `→ HTTP ${statusCode} (${outcome}) in ${durationMs}ms`, body);
      completeWebhookHit(logEntry, {
        outcome,
        statusCode,
        durationMs,
        detail: { ...(logEntry && logEntry.detail), ...(extra || {}) }
      });
      console.log('════════════════════════════════════════════════════════');
      return res.status(statusCode).json(body);
    };

    try {
      // -------------------------------------------------------------- STEP 2
      // Headers. Paystack sends x-paystack-signature and a Paystack user-agent;
      // their absence is itself a strong diagnostic signal.
      const headers = req.headers || {};
      step(requestId, 'STEP 2/9 HEADERS', 'full request headers', headers);
      step(requestId, 'STEP 2/9 HEADERS', 'headers of interest', {
        'content-type': getHeader(req, 'content-type') || null,
        'content-length': getHeader(req, 'content-length') || null,
        'user-agent': getHeader(req, 'user-agent') || null,
        'x-paystack-signature': getHeader(req, 'x-paystack-signature') ? 'present' : 'MISSING',
        'x-forwarded-for': getHeader(req, 'x-forwarded-for') || null,
        host: getHeader(req, 'host') || null
      });

      // -------------------------------------------------------------- STEP 3
      // Raw body — the exact bytes the signature is computed over.
      let rawBody;
      let bodySource;
      try {
        const read = await readRawBodyWithSource(req);
        rawBody = read.body;
        bodySource = read.source;
      } catch (error) {
        failure(requestId, 'STEP 3/9 BODY', 'could not read the raw request body', error);
        logEntry = recordWebhookHit({
          endpoint: '/api/webhook',
          method: req.method,
          headers,
          body: '',
          outcome: 'body-read-failed'
        });
        return finish(
          400,
          { success: false, error: 'Could not read request body', message: error.message },
          'body-read-failed'
        );
      }

      const rawBodyText = rawBody.toString('utf8');
      step(requestId, 'STEP 3/9 BODY', `read ${rawBody.length} raw byte(s) via "${bodySource}"`, {
        bytes: rawBody.length,
        source: bodySource,
        contentLengthHeader: getHeader(req, 'content-length') || null,
        empty: rawBody.length === 0
      });
      step(requestId, 'STEP 3/9 BODY', 'raw body', rawBodyText || '(empty)');

      if (bodySource === 'reserialized') {
        console.warn(
          `[WEBHOOK ${requestId}] STEP 3/9 BODY — ⚠ the body was ALREADY PARSED before this handler ran, so these are ` +
            're-serialized bytes, not Paystack\'s originals. If the content-length header above does not match the byte ' +
            'count, the signature cannot match exactly and will be checked against re-encoding variants instead.'
        );
      }

      if (rawBody.length === 0) {
        failure(
          requestId,
          'STEP 3/9 BODY',
          'the request body is EMPTY. Paystack never sends an empty webhook body — this is either a connectivity ' +
            'probe, or a proxy/middleware consumed the body before the handler ran.'
        );
      }

      logEntry = recordWebhookHit({
        endpoint: '/api/webhook',
        method: req.method,
        headers,
        body: rawBodyText,
        outcome: 'processing'
      });

      // -------------------------------------------------------------- STEP 4
      // Environment. A missing secret or missing Supabase config explains a
      // silent failure far more often than anything in the payload does.
      const envState = configurationState();
      step(requestId, 'STEP 4/9 ENV', 'environment configuration', envState);

      if (!envState.webhookSecretConfigured) {
        failure(
          requestId,
          'STEP 4/9 ENV',
          'no signing secret configured — set WEBHOOK_SECRET or PAYSTACK_SECRET_KEY in Vercel and redeploy'
        );
        return finish(
          500,
          {
            success: false,
            error:
              'Webhook is not configured: set WEBHOOK_SECRET (or PAYSTACK_SECRET_KEY, which Paystack signs with)'
          },
          'missing-signing-secret'
        );
      }

      // -------------------------------------------------------------- STEP 5
      // Signature verification.
      const signature = getHeader(req, 'x-paystack-signature');
      const secret = getWebhookSecret();
      const expectedSignature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

      // When the body arrived pre-parsed we may be hashing re-serialized bytes,
      // so also try the common JSON encodings before rejecting a real payment.
      let parsedForVariants = null;
      if (bodySource === 'reserialized') {
        try {
          parsedForVariants = JSON.parse(rawBodyText);
        } catch (_) {
          parsedForVariants = null;
        }
      }

      const verification = verifyWithVariants(rawBody, signature, secret, parsedForVariants);
      const signatureIsValid = verification.valid;

      if (verification.valid && verification.matchedVariant && verification.matchedVariant !== 'exact') {
        console.warn(
          `[WEBHOOK ${requestId}] STEP 5/9 SIGNATURE — ⚠ matched only after re-encoding the body as ` +
            `"${verification.matchedVariant}". The payload is authentic, but the platform is parsing the body before ` +
            'this function runs. Signature checking is therefore fragile here.'
        );
      }

      step(requestId, 'STEP 5/9 SIGNATURE', `verification result: ${signatureIsValid ? '✓ VALID' : '✗ INVALID'}`, {
        valid: signatureIsValid,
        matchedVariant: verification.matchedVariant,
        bodySource,
        signaturePresent: Boolean(signature),
        signatureLength: signature ? String(signature).length : 0,
        // Comparing the first/last few characters is enough to tell "wrong
        // secret" (totally different) from "wrong bytes hashed" — and it never
        // reveals the secret itself.
        receivedSignaturePreview: signature
          ? `${String(signature).slice(0, 10)}…${String(signature).slice(-6)}`
          : null,
        expectedSignaturePreview: `${expectedSignature.slice(0, 10)}…${expectedSignature.slice(-6)}`,
        secretSource: envState.webhookSecretSource,
        secretLength: secret.length,
        hashedByteCount: rawBody.length
      });

      if (!signatureIsValid) {
        failure(
          requestId,
          'STEP 5/9 SIGNATURE',
          signature
            ? 'signature mismatch. Either PAYSTACK_SECRET_KEY is from the wrong Paystack mode/account, ' +
                'or the body was modified in transit.'
            : 'no x-paystack-signature header was sent. A real Paystack webhook always includes one — this request ' +
                'probably did not come from Paystack.'
        );
        return finish(400, { success: false, error: 'Invalid webhook signature' }, 'invalid-signature', {
          signaturePresent: Boolean(signature)
        });
      }

      // -------------------------------------------------------------- STEP 6
      // Parse and validate the payload.
      let payload;
      try {
        payload = JSON.parse(rawBodyText);
      } catch (error) {
        failure(requestId, 'STEP 6/9 PAYLOAD', 'request body is not valid JSON', error);
        return finish(400, { success: false, error: 'Invalid JSON request body' }, 'invalid-json');
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        failure(requestId, 'STEP 6/9 PAYLOAD', 'request body parsed but is not a JSON object');
        return finish(400, { success: false, error: 'Invalid webhook payload' }, 'invalid-payload');
      }

      const { event: eventName, data } = payload;
      step(requestId, 'STEP 6/9 PAYLOAD', `event = ${eventName || '(none)'}`, {
        event: eventName || null,
        reference: (data && data.reference) || null,
        amountSubunits: (data && data.amount) || null,
        channel: (data && data.channel) || null,
        status: (data && data.status) || null,
        customerEmail: (data && ((data.customer && data.customer.email) || data.email)) || null
      });

      completeWebhookHit(logEntry, {
        event: eventName || null,
        reference: (data && data.reference) || null
      });

      // Paystack POSTs EVERY event type to the one webhook URL, so unknown
      // events must be acknowledged with 200 — a non-2xx makes Paystack retry
      // and eventually disable the endpoint.
      if (!['charge.success', 'charge.failed'].includes(eventName)) {
        step(
          requestId,
          'STEP 6/9 PAYLOAD',
          `event "${eventName || 'unknown'}" is not handled — acknowledging with 200 so Paystack does not retry`
        );
        return finish(
          200,
          { success: true, received: true, ignored: true, event: eventName || null },
          'ignored-event'
        );
      }

      if (!data || typeof data !== 'object' || !data.reference) {
        failure(requestId, 'STEP 6/9 PAYLOAD', 'payload is missing data.reference');
        return finish(
          400,
          { success: false, error: 'Webhook payload is missing transaction data or reference' },
          'missing-reference'
        );
      }

      // -------------------------------------------------------------- STEP 7
      // Map the Paystack payload onto our database columns.
      let transaction;
      try {
        transaction = transactionFromEvent(eventName, data);
        step(requestId, 'STEP 7/9 MAP', 'mapped Paystack event to a transactions row', transaction);
      } catch (error) {
        failure(requestId, 'STEP 7/9 MAP', 'could not map the payload to a transaction row', error);
        return finish(400, { success: false, error: error.message }, 'mapping-failed');
      }

      // -------------------------------------------------------------- STEP 8
      // Persist to Supabase.
      if (!envState.supabaseUrlConfigured || !envState.supabaseKeyConfigured) {
        failure(
          requestId,
          'STEP 8/9 SUPABASE',
          'Supabase environment variables are missing — the signature verified but there is nowhere to save the row. ' +
            'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel and redeploy.'
        );
        return finish(
          500,
          {
            success: false,
            error: 'Supabase is not configured: SUPABASE_URL and a Supabase key are required'
          },
          'supabase-not-configured'
        );
      }

      const client = supabaseClient || getSupabaseClient();
      if (!client) {
        failure(requestId, 'STEP 8/9 SUPABASE', 'Supabase client could not be initialized');
        return finish(500, { success: false, error: 'Supabase client is not available' }, 'supabase-client-missing');
      }

      step(requestId, 'STEP 8/9 SUPABASE', `upserting ${transaction.reference} into "transactions" (onConflict: reference)`, {
        credentialType: envState.supabaseCredentialType
      });

      // Same shared writer the dashboard checkout uses, so the webhook and the
      // checkout can never write different column shapes. Upserting by
      // reference also makes Paystack's retries idempotent.
      let persistence;
      try {
        persistence = await saveTransaction(transaction, { client, context: `WEBHOOK ${requestId}` });
      } catch (error) {
        failure(requestId, 'STEP 8/9 SUPABASE', 'the Supabase write threw an exception', error);
        return finish(
          500,
          { success: false, error: 'Failed to save transaction', message: error.message },
          'supabase-exception'
        );
      }

      step(requestId, 'STEP 8/9 SUPABASE', `insert result: ${persistence.ok ? '✓ SAVED' : '✗ REJECTED'}`, {
        ok: persistence.ok,
        skipped: persistence.skipped,
        reason: persistence.reason,
        returnedRow: persistence.data || null,
        error: persistence.error || null
      });

      if (!persistence.ok) {
        failure(
          requestId,
          'STEP 8/9 SUPABASE',
          `Supabase rejected the write: ${persistence.reason}. Common causes: Row Level Security blocking the anon ` +
            'key (use SUPABASE_SERVICE_ROLE_KEY), a column that does not exist, or a type mismatch.'
        );
        return finish(
          500,
          { success: false, error: 'Failed to save transaction', message: persistence.reason },
          'supabase-write-failed',
          { supabaseError: persistence.error || null }
        );
      }

      // ------------------------------------------ TENANT WEBHOOK FORWARDING
      // Vercel routes /api/webhook to this serverless module (not server.js),
      // so forwarding must happen here as well. Resolve the exact same effective
      // tenant object used by /api/tenants: env > DB > built-in default.
      try {
        if (tenantRegistry && typeof tenantRegistry.refreshFromDb === 'function') {
          await tenantRegistry.refreshFromDb({ client });
        }

        const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
        const merchantIdentifier = metadata.tenant_key || metadata.merchant || transaction.merchant_name;
        const tenant = tenantRegistry && typeof tenantRegistry.getTenantByIdentifier === 'function'
          ? tenantRegistry.getTenantByIdentifier(merchantIdentifier)
          : null;

        if (tenant && tenant.webhook_url) {
          step(
            requestId,
            'STEP 8/9 TENANT-FWD',
            `forwarding ${eventName} for ${transaction.reference} to ${tenant.key} @ ${tenant.webhook_url}`
          );
          const delivery = await tenantWebhookForwarder.dispatchWebhook(
            tenant,
            eventName,
            {
              reference: transaction.reference,
              status: eventName === 'charge.success' ? 'success' : 'failed',
              amount: transaction.amount,
              currency: data.currency || tenant.currency || 'GHS',
              channel: data.channel || transaction.payment_method || 'Unknown',
              paid_at: transaction.paid_at || data.created_at || new Date().toISOString(),
              merchant: tenant.key,
              gateway_reference: transaction.reference
            },
            transaction.reference
          );
          step(requestId, 'STEP 8/9 TENANT-FWD', 'initial delivery completed', {
            tenant: tenant.key,
            ok: Boolean(delivery && delivery.ok),
            statusCode: delivery && delivery.statusCode ? delivery.statusCode : 0,
            retryScheduled: Boolean(delivery && !delivery.ok && !delivery.skipped)
          });
        } else if (tenant) {
          step(requestId, 'STEP 8/9 TENANT-FWD', `tenant ${tenant.key} has no effective webhook URL; skipping`);
        } else {
          step(requestId, 'STEP 8/9 TENANT-FWD', 'merchant metadata did not resolve to a tenant; skipping', {
            merchantIdentifier: merchantIdentifier || null
          });
        }
      } catch (error) {
        // The Paystack event is already durable. A receiver outage must not make
        // Paystack retry the original event; the forwarder owns receiver retries.
        failure(requestId, 'STEP 8/9 TENANT-FWD', 'tenant webhook delivery failed', error);
      }

      // ------------------------------------------------- NOTIFY (receipt)
      // The SUCCESS row is durable, so fire the instant SMS/WhatsApp receipt
      // to the customer and merchant. Deliberately NOT awaited and the module
      // never throws — a broken notification provider must never delay or
      // change the 200 OK Paystack is waiting for.
      if (transaction.status === 'SUCCESS') {
        step(
          requestId,
          'STEP 8/9 NOTIFY',
          `dispatching SMS/WhatsApp receipt for ${transaction.reference} (fire-and-forget)`
        );
        sendOrderReceiptNotification(transaction, payload).catch(error => {
          console.error(
            `[WEBHOOK ${requestId}] [WEBHOOK-NOTIFIER-ERROR]`,
            error && error.message ? error.message : error
          );
        });
      }

      // -------------------------------------------------------------- STEP 9
      step(requestId, 'STEP 8/9 SUPABASE', `✓ transaction ${transaction.reference} is now in the database`);
      return finish(
        200,
        {
          success: true,
          received: true,
          reference: transaction.reference,
          transaction: persistence.data || transaction
        },
        'saved'
      );
    } catch (error) {
      failure(requestId, 'UNHANDLED', 'an unexpected error escaped the handler', error);
      completeWebhookHit(logEntry, { outcome: 'unhandled-error', statusCode: 500 });
      console.log('════════════════════════════════════════════════════════');
      return res.status(500).json({
        success: false,
        error: 'Internal webhook error',
        message: error.message
      });
    }
  };
}

export default createWebhookHandler();
// Paystack webhook handler
// Auto split: 3% Valmont, 97% owner
