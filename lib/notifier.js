/**
 * VALMONT-PAY Notification Engine — instant SMS / WhatsApp payment receipts.
 *
 * Whenever a `charge.success` webhook clears, both the customer and the
 * merchant get a professional Ghanaian MoMo-style receipt in real time:
 *
 *   *VALMONT-PAY INSTANT RECEIPT* 🔒
 *   Ref: #VP-123456
 *   Merchant: Valmont Electricals
 *   Amount Paid: GH₵ 50.00
 *   Payment Method: Mobile Money (MTN)
 *   Status: PAID ✅
 *   Paid at: ...
 *   Thank you for your payment!
 *
 * ── Dispatch channels (checked in order, ALL configured ones are used) ─────
 *
 *   WHATSAPP_WEBHOOK_URL  → POST { phone, message, reference } as JSON to any
 *                           WhatsApp provider hook (Twilio, 360dialog, a VPS
 *                           running whatsapp-web.js, etc.)
 *   SMS_WEBHOOK_URL       → same JSON shape POSTed to a generic SMS hook.
 *   ARKESEL_API_KEY       → direct Arkesel SMS v2 API (Ghana).
 *                           Sender id from ARKESEL_SENDER_ID (default
 *                           "VALMONT-PAY", the 11-char maximum).
 *   MNOTIFY_API_KEY       → direct mNotify Quick SMS API (Ghana).
 *                           Sender id from MNOTIFY_SENDER_ID.
 *
 * When NO provider is configured the receipt is still printed to the runtime
 * logs under [VALMONT-NOTIFIER] so every payment stays auditable on Vercel —
 * delivery just has no external channel.
 *
 * ── Recipients ─────────────────────────────────────────────────────────────
 *
 *   Customer — phone comes from the Paystack payment itself (checkout writes
 *              the MoMo number into metadata, see lib/paystack.js).
 *   Merchant — MERCHANT_NOTIFICATION_PHONE / ADMIN_NOTIFICATION_PHONE; when
 *              only an email exists (MERCHANT_NOTIFICATION_EMAIL /
 *              ADMIN_NOTIFICATION_EMAIL / ADMIN_EMAIL) it is logged for the
 *              audit trail since SMS/WhatsApp need a phone number.
 *
 * ── Safety guarantees ──────────────────────────────────────────────────────
 *
 *   * This module NEVER throws. Every dispatch is wrapped in try/catch; the
 *     webhook must always be free to answer Paystack with 200 OK.
 *   * A reference is only re-notified within one process when the previous
 *     attempt delivered NOTHING — so Paystack retries never double-text a
 *     customer, but a transient provider outage can recover on the next hit.
 *   * Secrets are never logged. Payload logs contain the phone + message only.
 *
 * CommonJS on purpose: server.js require()s it and the ESM serverless
 * functions under /api default-import it, exactly like lib/transaction-store.js.
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const tenants = require('./tenants');

const LOG_PREFIX = '[VALMONT-NOTIFIER]';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SENDER_ID = 'VALMONT-PAY'; // Ghana SMS sender ids max out at 11 chars
const ARKESEL_SMS_URL = 'https://sms.arkesel.com/api/v2/sms/send';
const MNOTIFY_SMS_URL = 'https://api.mnotify.com/api/sms/quick';

/** Statuses that mean money actually settled (mirrors lib/transaction-store). */
const SUCCESS_STATUSES = ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'];

/**
 * References already notified successfully in THIS process. Paystack re-sends
 * webhooks until it sees a 2xx, and also sends a test event on dashboard
 * saves — remembering what we delivered stops customers getting the same
 * receipt twice while a warm serverless instance / the Express server lives.
 * Capped FIFO so memory stays flat.
 */
const notifiedReferences = new Set();
const MAX_NOTIFIED_REFERENCES = 500;

function rememberNotified(reference) {
  notifiedReferences.add(reference);
  while (notifiedReferences.size > MAX_NOTIFIED_REFERENCES) {
    // Set iterates in insertion order — drop the oldest entries first.
    const oldest = notifiedReferences.values().next().value;
    notifiedReferences.delete(oldest);
  }
}

// ─── Contact extraction ────────────────────────────────────────────────────

/**
 * Pull the customer's phone out of the transaction row or the raw Paystack
 * payload. Our checkout writes the payer's MoMo number into BOTH
 * `metadata.phone/momo_number` and a `momo_number` custom field
 * (lib/paystack.js), Paystack may attach `customer.phone`, and older ledger
 * rows may carry `customer_phone` directly. First hit wins.
 *
 * @param {object} trx - persisted transaction / ledger record
 * @param {object} payload - raw verified Paystack webhook payload
 * @returns {string|null}
 */
function extractCustomerPhone(trx, payload) {
  const metadata = (payload && payload.data && payload.data.metadata) || {};
  const customFields = Array.isArray(metadata.custom_fields) ? metadata.custom_fields : [];

  const momoField = customFields.find(
    field =>
      field &&
      (field.variable_name === 'momo_phone' ||
        field.variable_name === 'momo_number' ||
        field.variable_name === 'phone')
  );

  const phone =
    metadata.momo_number ||
    (momoField && momoField.value) ||
    metadata.phone ||
    (payload && payload.data && payload.data.customer && payload.data.customer.phone) ||
    (trx && (trx.customer_phone || trx.phone)) ||
    null;

  const normalized = phone === null || phone === undefined ? null : String(phone).trim();
  return normalized || null;
}

/**
 * The tenant that owns this transaction, from the merchant name on it.
 *
 * Resolution is deliberately fuzzy: historical ledger rows carry a display
 * name ("Valmont Electricals") while newer ones carry the tenant key. Both
 * resolve. Anything unrecognised returns null, which falls through to the
 * gateway-wide notification settings.
 */
function resolveTenantForNotification(trx, payload) {
  const merchantName = pickMerchantName(trx, payload);
  if (!merchantName) return null;
  return tenants.getTenant(merchantName) || tenants.getTenantByIdentifier(merchantName) || null;
}

/**
 * Where the merchant/admin receipt goes. Server-side configuration only — a
 * merchant phone number must NEVER be taken from a client-controlled webhook
 * payload.
 *
 * A tenant's own notification_phone / notification_email wins over the
 * gateway-wide MERCHANT_NOTIFICATION_* settings, so each merchant can receive
 * its own receipts. Unset — every tenant that predates this, and any merchant
 * that does not want its own alerts — falls back to the global target exactly
 * as before.
 *
 * @returns {{phone: string|null, email: string|null, tenantKey: string|null, source: string}}
 */
function extractMerchantContact(trx, payload) {
  const tenant = resolveTenantForNotification(trx, payload);
  const tenantPhone = tenant && tenant.notification_phone ? String(tenant.notification_phone).trim() : '';
  const tenantEmail = tenant && tenant.notification_email ? String(tenant.notification_email).trim() : '';

  const phone =
    tenantPhone ||
    process.env.MERCHANT_NOTIFICATION_PHONE || process.env.ADMIN_NOTIFICATION_PHONE || null;
  const email =
    tenantEmail ||
    process.env.MERCHANT_NOTIFICATION_EMAIL ||
    process.env.ADMIN_NOTIFICATION_EMAIL ||
    process.env.ADMIN_EMAIL ||
    null;

  const merchantName = pickMerchantName(trx, payload);
  const source = tenantPhone || tenantEmail ? `tenant (${tenant.key})` : 'global environment';
  console.log(
    `${LOG_PREFIX} Merchant contact for ${merchantName}: phone ${phone ? 'configured' : 'none'}, ` +
      `email ${email || 'none'} [source: ${source}]`
  );

  return {
    phone: phone ? String(phone).trim() : null,
    email: email ? String(email).trim() : null,
    tenantKey: tenant ? tenant.key : null,
    source
  };
}

// ─── Receipt fields ────────────────────────────────────────────────────────

/** Both trx shapes: api/webhook.js (merchant_name) and lib/webhook.js (merchant). */
function pickMerchantName(trx, payload) {
  const metadata = (payload && payload.data && payload.data.metadata) || {};
  return (
    (trx && (trx.merchant_name || trx.merchant)) ||
    metadata.merchant ||
    metadata.merchant_name ||
    'Valmont-Pay'
  );
}

/** The trx rows store major units (GH₵); the raw Paystack payload is pesewas. */
function pickAmount(trx, payload) {
  if (trx && Number.isFinite(Number(trx.amount))) return Number(trx.amount);
  const subunits = payload && payload.data && Number(payload.data.amount);
  return Number.isFinite(subunits) ? subunits / 100 : 0;
}

/** api/webhook.js rows use payment_method, ledger records use channel. */
function pickChannel(trx, payload) {
  const channel =
    (trx && (trx.payment_method || trx.channel)) || (payload && payload.data && payload.data.channel);
  if (!channel) return 'MoMo';
  if (String(channel).toLowerCase() === 'mobile_money') return 'Mobile Money (MoMo)';
  return String(channel);
}

/** Format settled time in Ghana time, tolerating bad/missing input. */
function formatPaidAt(trx, payload) {
  const raw =
    (trx && (trx.paid_at || trx.timestamp)) ||
    (payload && payload.data && (payload.data.paid_at || payload.data.paidAt || payload.data.created_at));
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) return String(raw || new Date().toISOString());

  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Accra',
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: true
    }).format(date);
  } catch (_) {
    return date.toISOString();
  }
}

/**
 * The exact customer-facing receipt text. WhatsApp renders *bold* — keep it.
 *
 * @param {object} trx
 * @param {object} payload
 * @returns {string}
 */
function formatReceiptMessage(trx, payload) {
  const reference = (trx && trx.reference) || (payload && payload.data && payload.data.reference) || 'N/A';
  const amount = pickAmount(trx, payload);

  return [
    '*VALMONT-PAY INSTANT RECEIPT* 🔒',
    `Ref: #${reference}`,
    `Merchant: ${pickMerchantName(trx, payload)}`,
    `Amount Paid: GH₵ ${amount.toFixed(2)}`,
    `Payment Method: ${pickChannel(trx, payload)}`,
    'Status: PAID ✅',
    `Paid at: ${formatPaidAt(trx, payload)}`,
    'Thank you for your payment!'
  ].join('\n');
}

// ─── Phone normalisation (Ghana) ───────────────────────────────────────────

/**
 * Normalise a Ghanaian number for SMS/WhatsApp providers: strip separators,
 * convert "0544..." / "+233 544..." / "233544..." all to "233544...".
 * Numbers that do not look Ghanaian are returned digit-stripped but otherwise
 * untouched — we never mangle an international customer.
 *
 * @param {string} phone
 * @returns {string|null} digits-only MSISDN, or null when unusable
 */
function normalizeGhanaPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);

  if (digits.startsWith('00233')) digits = digits.slice(2); // 00233... -> 233...
  if (digits.startsWith('233')) digits = digits; // already international
  else if (digits.startsWith('0') && digits.length === 10) digits = `233${digits.slice(1)}`;
  else if (digits.length === 9 && /^[235]/.test(digits)) digits = `233${digits}`;

  // Ghana MSISDNs in international form are 12 digits: 233 + 9.
  if (!/^\d{9,15}$/.test(digits)) return null;
  return digits;
}

// ─── Channel configuration ────────────────────────────────────────────────

/** Booleans only — safe to log, never includes a secret value. */
function notificationConfigState() {
  const arkeselKey = process.env.ARKESEL_API_KEY || '';
  const mnotifyKey = process.env.MNOTIFY_API_KEY || '';
  return {
    whatsappWebhookConfigured: Boolean(process.env.WHATSAPP_WEBHOOK_URL),
    smsWebhookConfigured: Boolean(process.env.SMS_WEBHOOK_URL),
    arkeselConfigured: Boolean(arkeselKey),
    mnotifyConfigured: Boolean(mnotifyKey),
    senderId: process.env.ARKESEL_SENDER_ID || process.env.MNOTIFY_SENDER_ID || DEFAULT_SENDER_ID,
    merchantPhoneConfigured: Boolean(
      process.env.MERCHANT_NOTIFICATION_PHONE || process.env.ADMIN_NOTIFICATION_PHONE
    ),
    anyProviderConfigured: Boolean(
      process.env.WHATSAPP_WEBHOOK_URL ||
        process.env.SMS_WEBHOOK_URL ||
        arkeselKey ||
        mnotifyKey
    )
  };
}

// ─── HTTP helper ───────────────────────────────────────────────────────────

/**
 * POST JSON with a hard timeout. Returns a result object instead of throwing
 * so a dead provider can never break the notification pass (let alone the
 * webhook that triggered it).
 */
async function postJson(url, body, { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const statusCode = response.status;
    const responseText = await response.text().catch(() => '');
    return {
      ok: response.ok,
      statusCode,
      durationMs: Date.now() - startedAt,
      // Keep at most 200 chars of the provider's reply for the audit log.
      responsePreview: typeof responseText === 'string' ? responseText.slice(0, 200) : ''
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      durationMs: Date.now() - startedAt,
      error: error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : error.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Channel senders ───────────────────────────────────────────────────────

/** Generic WhatsApp provider hook — exact spec payload shape. */
async function sendViaWhatsAppWebhook(phone, message, reference) {
  return postJson(process.env.WHATSAPP_WEBHOOK_URL, { phone, message, reference });
}

/** Generic SMS provider hook — same JSON shape as the WhatsApp hook. */
async function sendViaSmsWebhook(phone, message, reference) {
  return postJson(process.env.SMS_WEBHOOK_URL, { phone, message, reference });
}

/** Arkesel SMS v2 (Ghana): api-key header, recipients[] array. */
async function sendViaArkesel(phone, message) {
  return postJson(ARKESEL_SMS_URL, {
    sender: process.env.ARKESEL_SENDER_ID || DEFAULT_SENDER_ID,
    message,
    recipients: [phone]
  }, {
    headers: { 'api-key': process.env.ARKESEL_API_KEY }
  });
}

/**
 * mNotify Quick SMS (Ghana). The API key rides in the query string per their
 * docs — it is deliberately NOT part of anything we log.
 */
async function sendViaMnotify(phone, message) {
  const key = process.env.MNOTIFY_API_KEY;
  const url = `${MNOTIFY_SMS_URL}?key=${encodeURIComponent(key)}`;
  return postJson(url, {
    recipient: [phone],
    sender: process.env.MNOTIFY_SENDER_ID || DEFAULT_SENDER_ID,
    message,
    is_schedule: false,
    schedule_date: ''
  });
}

/**
 * Run every configured provider for ONE recipient. Never throws.
 * @returns {Promise<Array<{channel:string, ok:boolean, statusCode:number, detail:string}>>}
 */
async function dispatchToRecipient(recipientPhone, message, reference) {
  const config = notificationConfigState();
  const attempts = [];

  const run = async (channel, send) => {
    try {
      const result = await send();
      attempts.push({
        channel,
        ok: Boolean(result.ok),
        statusCode: result.statusCode || 0,
        detail: result.ok
          ? `HTTP ${result.statusCode} in ${result.durationMs}ms`
          : result.error || `HTTP ${result.statusCode}${result.responsePreview ? ` — ${result.responsePreview}` : ''}`
      });
    } catch (error) {
      // postJson already converts errors to results; this is pure paranoia —
      // a notification failure must be a log line, NEVER an exception that
      // reaches the webhook.
      attempts.push({
        channel,
        ok: false,
        statusCode: 0,
        detail: error && error.message ? error.message : String(error)
      });
    }
  };

  if (config.whatsappWebhookConfigured) {
    await run('whatsapp-webhook', () => sendViaWhatsAppWebhook(recipientPhone, message, reference));
  }
  if (config.smsWebhookConfigured) {
    await run('sms-webhook', () => sendViaSmsWebhook(recipientPhone, message, reference));
  }
  if (config.arkeselConfigured) {
    await run('arkesel-sms', () => sendViaArkesel(recipientPhone, message));
  }
  if (config.mnotifyConfigured) {
    await run('mnotify-sms', () => sendViaMnotify(recipientPhone, message));
  }

  return attempts;
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Send the instant payment receipt to the customer and the merchant over
 * every configured channel (WhatsApp / SMS), and ALWAYS mirror the receipt to
 * the runtime logs so the audit trail exists even with zero providers set.
 *
 * Fire-and-forget safe: this function resolves with a summary object and NEVER
 * rejects; callers should still attach .catch() as cheap insurance.
 *
 * @param {object} trx - the transaction row that was just persisted (any of
 *        the shapes written by api/webhook.js or lib/webhook.js)
 * @param {object} payload - the full verified Paystack webhook payload
 * @returns {Promise<{ok:boolean, reason?:string, delivered?:number, failed?:number}>}
 */
async function sendOrderReceiptNotification(trx, payload = {}) {
  try {
    const reference =
      (trx && trx.reference) || (payload && payload.data && payload.data.reference) || null;

    if (!reference) {
      console.error(`${LOG_PREFIX} ✗ Cannot send receipt — transaction reference is missing`);
      return { ok: false, reason: 'missing-reference' };
    }

    // Only settled money gets a receipt. charge.failed and friends stop here.
    const status = String(
      (trx && trx.status) || (payload && payload.data && payload.data.status) || ''
    ).toUpperCase();
    if (status && !SUCCESS_STATUSES.includes(status)) {
      console.log(`${LOG_PREFIX} Skipping Ref ${reference} — status is ${status}, not PAID`);
      return { ok: true, skipped: true, reason: `status-${status.toLowerCase()}` };
    }

    // Guard against Paystack redeliveries double-texting the customer.
    if (notifiedReferences.has(reference)) {
      console.log(`${LOG_PREFIX} Ref ${reference} already notified — skipping duplicate`);
      return { ok: true, skipped: true, reason: 'duplicate' };
    }

    const message = formatReceiptMessage(trx, payload);
    const customerPhone = normalizeGhanaPhone(extractCustomerPhone(trx, payload));
    const merchant = extractMerchantContact(trx, payload);
    const merchantPhone = normalizeGhanaPhone(merchant.phone);
    const config = notificationConfigState();

    // ─── AUDIT: the receipt is ALWAYS on the logs, providers or not. ────
    console.log('────────────────────────────────────────────────────────');
    console.log(`${LOG_PREFIX} Receipt for Ref ${reference}:`);
    console.log(message);
    console.log(`${LOG_PREFIX} Channels: ${JSON.stringify(config)}`);
    console.log(
      `${LOG_PREFIX} Recipients: customer=${customerPhone || 'not available'}` +
        ` merchant=${merchantPhone || merchant.email || 'not available'}`
    );

    if (!config.anyProviderConfigured) {
      console.log(
        `${LOG_PREFIX} Sent receipt for Ref ${reference} (log-only — set WHATSAPP_WEBHOOK_URL, ` +
          'SMS_WEBHOOK_URL, ARKESEL_API_KEY or MNOTIFY_API_KEY to deliver it as a real message)'
      );
      console.log('────────────────────────────────────────────────────────');
      return { ok: true, delivered: 0, failed: 0, reason: 'no-provider-configured' };
    }

    // Build the recipient list: customer first, merchant second.
    const recipients = [];
    if (customerPhone) recipients.push({ role: 'customer', phone: customerPhone });
    else console.warn(`${LOG_PREFIX} ⚠ No customer phone found for Ref ${reference} — customer receipt cannot be delivered`);

    if (merchantPhone) recipients.push({ role: 'merchant', phone: merchantPhone });
    else if (merchant.email) {
      console.log(
        `${LOG_PREFIX} Merchant contact is email-only (${merchant.email}) — no phone channel can reach it; ` +
          'set MERCHANT_NOTIFICATION_PHONE for merchant SMS/WhatsApp alerts'
      );
    }

    let delivered = 0;
    let failed = 0;
    const results = [];

    for (const recipient of recipients) {
      const attempts = await dispatchToRecipient(recipient.phone, message, reference);
      for (const attempt of attempts) {
        results.push({ recipient: recipient.role, ...attempt });
        if (attempt.ok) {
          delivered++;
          console.log(
            `${LOG_PREFIX} ✓ ${attempt.channel} → ${recipient.role} (${recipient.phone}) — ${attempt.detail}`
          );
        } else {
          failed++;
          console.error(
            `${LOG_PREFIX} ✗ ${attempt.channel} → ${recipient.role} (${recipient.phone}) failed: ${attempt.detail}`
          );
        }
      }
    }

    if (delivered + failed === 0) {
      console.log(`${LOG_PREFIX} Sent receipt for Ref ${reference} (log-only — no reachable recipient)`);
    } else {
      console.log(`${LOG_PREFIX} Sent receipt for Ref ${reference} — ${delivered} delivered, ${failed} failed`);
    }
    console.log('────────────────────────────────────────────────────────');

    // Only remember references that actually reached someone — a fully failed
    // pass stays eligible so a Paystack retry can recover the notification.
    if (delivered > 0) rememberNotified(reference);

    return { ok: failed === 0, reference, delivered, failed, results };
  } catch (error) {
    // The whole point of this module: notification problems are log lines,
    // never webhook failures. Paystack must still get its 200 OK.
    console.error(`${LOG_PREFIX} ✗ Unexpected notifier failure (suppressed):`, error && error.message ? error.message : error);
    if (error && error.stack) console.error(`${LOG_PREFIX} stack:\n`, error.stack);
    return { ok: false, reason: error && error.message ? error.message : 'unknown-error' };
  }
}

module.exports = {
  sendOrderReceiptNotification,
  // Exported for the offline test-suite and future admin tooling.
  extractCustomerPhone,
  extractMerchantContact,
  formatReceiptMessage,
  normalizeGhanaPhone,
  notificationConfigState,
  LOG_PREFIX
};
