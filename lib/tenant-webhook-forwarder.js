/**
 * Webhook forwarder: sends payment events to each tenant's registered webhook
 * URL, signed with HMAC-SHA512 using the tenant's DEDICATED webhook signing
 * secret (tenant.webhook_signing_secret).
 *
 * The signature is delivered in two headers so merchants can verify the
 * callback really came from Valmont-Pay and was not spoofed:
 *   - x-valmontpay-signature : HMAC-SHA512(rawBody, webhook_signing_secret)
 *   - x-valmontpay-tenant    : the tenant's key (e.g. "valmont-electricals")
 *   - x-valmontpay-event     : the event name (e.g. "charge.success")
 *
 * Merchants verify by recomputing HMAC-SHA512 over the RAW request body with
 * their webhook signing secret and constant-time-comparing to the header value.
 *
 * Events:
 *   charge.success   - payment completed successfully
 *   charge.failed    - payment failed
 *
 * Delivery guarantees:
 *   - At-least-once delivery; retries with exponential backoff up to ~24h
 *   - Identical payload per retry (idempotent by reference)
 *   - Stops on 2xx response
 */

const crypto = require('crypto');

// ─── In-memory delivery log ──────────────────────────────────────────────

/**
 * Each delivery attempt is recorded so the dashboard can inspect them.
 * @type {Array<object>}
 */
const deliveryLog = [];
const MAX_LOG_ENTRIES = 500;

/**
 * Active retry timers by reference, keyed by `${tenant_key}::${reference}`.
 * @type {Map<string, {timer: NodeJS.Timeout, attempt: number, maxAttempts: number}>}
 */
const retryTimers = new Map();

// ─── Backoff schedule ────────────────────────────────────────────────────

/**
 * Exponential backoff delays in milliseconds, summing to ~24 hours.
 * Attempts 1-15: 10s, 30s, 1m, 2m, 4m, 8m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 24h
 */
const BACKOFF_DELAYS = [
  10_000,       // 10s
  30_000,       // 30s
  60_000,       // 1m
  120_000,      // 2m
  240_000,      // 4m
  480_000,      // 8m
  900_000,      // 15m
  1_800_000,    // 30m
  3_600_000,    // 1h
  7_200_000,    // 2h
  14_400_000,   // 4h
  21_600_000,   // 6h
  28_800_000,   // 8h
  43_200_000,   // 12h
  86_400_000    // 24h
];

const MAX_ATTEMPTS = BACKOFF_DELAYS.length;

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the HMAC signing secret for a tenant. Prefer the dedicated
 * webhook_signing_secret (generated at tenant creation); fall back to
 * the Paystack secret key for legacy tenants; finally fall back to
 * WEBHOOK_SECRET env var. Never sign with an empty secret (we skip the
 * signature header entirely if no secret is available).
 * @param {object} tenant
 * @returns {string|null}
 */
function resolveSigningSecret(tenant) {
  if (!tenant) return null;
  if (tenant.webhook_signing_secret) return tenant.webhook_signing_secret;
  if (tenant.paystack_secret_key) return tenant.paystack_secret_key;
  if (process.env.WEBHOOK_SECRET) return process.env.WEBHOOK_SECRET;
  return null;
}

/**
 * Generate an HMAC-SHA512 signature of the raw body using the tenant's
 * dedicated webhook signing secret.
 * @param {string|Buffer} rawBody - The raw JSON string
 * @param {string} secret - HMAC key
 * @returns {string} hex-encoded HMAC-SHA512
 */
function signPayload(rawBody, secret) {
  if (!secret) return '';
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

/**
 * Build the webhook payload shape sent to the tenant.
 * @param {string} event - e.g. 'charge.success'
 * @param {object} data - payment data
 * @param {string} merchantKey - the tenant key
 * @param {string} gatewayReference - our internal reference
 * @returns {{event: string, data: object}}
 */
function buildWebhookPayload(event, data, merchantKey, gatewayReference) {
  return {
    event,
    data: {
      reference: data.reference || '',
      status: data.status || '',
      amount: data.amount || 0,
      currency: data.currency || 'GHS',
      channel: data.channel || '',
      paid_at: data.paid_at || data.timestamp || new Date().toISOString(),
      merchant: merchantKey,
      gateway_reference: gatewayReference || data.gateway_reference || data.reference || ''
    }
  };
}

// ─── Delivery attempt ────────────────────────────────────────────────────

/**
 * Attempt to deliver a webhook to the tenant's URL.
 * @param {object} tenant - the tenant config object
 * @param {string} reference - payment reference
 * @param {object} payload - the webhook payload object
 * @returns {Promise<{ok: boolean, statusCode: number, error?: string}>}
 */
async function attemptDelivery(tenant, reference, payload) {
  const webhookUrl = tenant.webhook_url;
  if (!webhookUrl) {
    return { ok: false, statusCode: 0, error: 'No webhook URL configured for tenant' };
  }

  const rawBody = JSON.stringify(payload);
  const secret = resolveSigningSecret(tenant);
  const signature = secret ? signPayload(rawBody, secret) : '';

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ValmontPay-Webhook/1.0',
      'x-valmontpay-tenant': tenant.key,
      'x-valmontpay-event': payload.event || 'charge.success'
    };
    if (signature) {
      headers['x-valmontpay-signature'] = signature;
    } else {
      console.log(`[WEBHOOK-FWD] WARNING: no signing secret for tenant "${tenant.key}" — webhook will be delivered WITHOUT x-valmontpay-signature header`);
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal
    });

    clearTimeout(timeout);

    const durationMs = Date.now() - startTime;
    const ok = response.ok; // 2xx

    // Log the delivery attempt
    logDelivery({
      tenant_key: tenant.key,
      reference,
      event: payload.event,
      attempt: 0, // will be filled in by caller
      url: webhookUrl,
      statusCode: response.status,
      success: ok,
      durationMs,
      error: null
    });

    return { ok, statusCode: response.status, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    logDelivery({
      tenant_key: tenant.key,
      reference,
      event: payload.event,
      attempt: 0,
      url: webhookUrl,
      statusCode: 0,
      success: false,
      durationMs,
      error: error.message || String(error)
    });

    return { ok: false, statusCode: 0, error: error.message || String(error), durationMs };
  }
}

// ─── Full webhook lifecycle ──────────────────────────────────────────────

/**
 * Send a webhook to the tenant and schedule retries with exponential backoff.
 *
 * @param {object} tenant - tenant config
 * @param {string} event - event name
 * @param {object} data - payment data
 * @param {string} gatewayReference - our gateway reference
 * @param {object} [options]
 * @param {boolean} [options.isRetry=false] - true if this is a manual replay
 */
function dispatchWebhook(tenant, event, data, gatewayReference, options = {}) {
  if (!tenant || !tenant.webhook_url) {
    console.log(`[WEBHOOK-FWD] Tenant "${tenant && tenant.key}" has no webhook URL — skipping`);
    return Promise.resolve({
      ok: false,
      skipped: true,
      statusCode: 0,
      error: 'No webhook URL configured for tenant'
    });
  }

  const reference = (data && data.reference) || gatewayReference || 'unknown';
  const retryKey = `${tenant.key}::${reference}`;

  // Cancel any existing retry chain for this payment (idempotent)
  if (retryTimers.has(retryKey)) {
    const existing = retryTimers.get(retryKey);
    clearTimeout(existing.timer);
  }

  const payload = buildWebhookPayload(event, data, tenant.key, gatewayReference);

  let attempt = options.isRetry ? 0 : 0;

  const scheduleNext = () => {
    if (attempt >= MAX_ATTEMPTS) {
      console.log(`[WEBHOOK-FWD] Max attempts (${MAX_ATTEMPTS}) reached for ${retryKey} — giving up`);
      retryTimers.delete(retryKey);
      return;
    }

    const delay = BACKOFF_DELAYS[attempt];
    const timer = setTimeout(async () => {
      const result = await attemptDelivery(tenant, reference, payload);

      if (result.ok) {
        console.log(`[WEBHOOK-FWD] ✓ Delivered ${event} for ${reference} to ${tenant.key} (attempt ${attempt + 1})`);
        retryTimers.delete(retryKey);
        return;
      }

      attempt++;
      console.log(
        `[WEBHOOK-FWD] ✗ Delivery failed for ${reference} to ${tenant.key} ` +
        `(attempt ${attempt}, HTTP ${result.statusCode || 'timeout'}) — ` +
        `retrying in ${Math.round(delay / 1000)}s`
      );

      scheduleNext();
    }, delay);

    retryTimers.set(retryKey, { timer, attempt, maxAttempts: MAX_ATTEMPTS });
  };

  // Start immediately and return the first-attempt promise. Express callers may
  // keep fire-and-forget behavior; serverless callers await it so the runtime
  // cannot freeze before the receiver gets the POST.
  return attemptDelivery(tenant, reference, payload).then(result => {
    if (result.ok) {
      console.log(`[WEBHOOK-FWD] ✓ Delivered ${event} for ${reference} to ${tenant.key}`);
      return result;
    }

    attempt = 1;
    console.log(
      `[WEBHOOK-FWD] ✗ Initial delivery failed for ${reference} to ${tenant.key} ` +
      `(HTTP ${result.statusCode || 'timeout'}) — retrying in ${Math.round(BACKOFF_DELAYS[0] / 1000)}s`
    );

    scheduleNext();
    return result;
  });
}

// ─── Delivery log ────────────────────────────────────────────────────────

/**
 * Record a delivery attempt in the ring buffer.
 */
function logDelivery(entry) {
  deliveryLog.push({
    id: `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry
  });

  while (deliveryLog.length > MAX_LOG_ENTRIES) {
    deliveryLog.shift();
  }
}

/**
 * Get delivery attempts for a specific reference or tenant.
 * @param {object} filters - {reference?: string, tenant_key?: string}
 * @returns {Array<object>}
 */
function getDeliveryLog(filters = {}) {
  let entries = [...deliveryLog];

  if (filters.reference) {
    entries = entries.filter(e => e.reference === filters.reference);
  }
  if (filters.tenant_key) {
    entries = entries.filter(e => e.tenant_key === filters.tenant_key);
  }

  return entries.reverse(); // newest first
}

/**
 * Get the delivery status for a specific payment.
 * @param {string} tenantKey
 * @param {string} reference
 * @returns {{delivered: boolean, attempts: Array<object>, retryPending: boolean}}
 */
function getPaymentDeliveryStatus(tenantKey, reference) {
  const attempts = getDeliveryLog({ tenant_key: tenantKey, reference });
  const delivered = attempts.some(a => a.success);
  const retryKey = `${tenantKey}::${reference}`;
  const retryPending = retryTimers.has(retryKey);

  return { delivered, attempts, retryPending };
}

/**
 * Replay a failed webhook for a specific payment.
 * @param {object} tenant - tenant config
 * @param {string} reference - payment reference
 * @param {object} originalPayload - the stored webhook payload
 * @returns {boolean}
 */
function replayWebhook(tenant, reference, originalPayload) {
  if (!tenant || !reference) return false;

  const retryKey = `${tenant.key}::${reference}`;

  // Cancel existing retry chain
  if (retryTimers.has(retryKey)) {
    const existing = retryTimers.get(retryKey);
    clearTimeout(existing.timer);
    retryTimers.delete(retryKey);
  }

  // Dispatch immediately with isRetry=true
  dispatchWebhook(tenant, originalPayload.event, originalPayload.data, reference, { isRetry: true });

  return true;
}

/**
 * Cancel pending retries for a reference.
 * @param {string} tenantKey
 * @param {string} reference
 */
function cancelRetries(tenantKey, reference) {
  const retryKey = `${tenantKey}::${reference}`;
  if (retryTimers.has(retryKey)) {
    const existing = retryTimers.get(retryKey);
    clearTimeout(existing.timer);
    retryTimers.delete(retryKey);
  }
}

module.exports = {
  signPayload,
  buildWebhookPayload,
  attemptDelivery,
  dispatchWebhook,
  getDeliveryLog,
  getPaymentDeliveryStatus,
  replayWebhook,
  cancelRetries,
  BACKOFF_DELAYS,
  MAX_ATTEMPTS
};
