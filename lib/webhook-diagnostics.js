/**
 * Shared webhook diagnostics.
 *
 * One module, used by BOTH the Vercel serverless function (api/webhook-status.js)
 * and the Express route in server.js, so local development and production report
 * exactly the same thing.
 *
 * Everything here is safe to expose publicly-ish: secrets are reported as
 * booleans, prefixes and SHA-256 fingerprints — never as values.
 */

const crypto = require('crypto');
const { supabaseConfigState, getSupabaseClient } = require('./supabase');
const webhookLog = require('./webhook-log');
const { requestOrigin, publicBaseUrl, DEFAULT_PUBLIC_BASE_URL } = require('./base-url');
const deliveryStore = require('./webhook-delivery-store');
const tenantsModule = require('./tenants');
const tenantWebhookForwarderModule = require('./tenant-webhook-forwarder');

/**
 * The URL the Paystack dashboard is supposed to be pointed at.
 * Derived host-first (see lib/base-url.js) so a stale PUBLIC_BASE_URL can
 * never again point operators at a dead domain. Kept as a function rather
 * than a constant: the canonical URL depends on the request context.
 */
function canonicalWebhookUrl(req) {
  return `${publicBaseUrl(req)}/api/webhook`;
}

/** Paystack signs with its own secret; WEBHOOK_SECRET is legacy fallback only. */
function getWebhookSecret() {
  return process.env.PAYSTACK_SECRET_KEY || process.env.WEBHOOK_SECRET || '';
}

/**
 * A short, non-reversible fingerprint of a secret. Two deployments (or two env
 * vars) can be compared for equality without either value being revealed.
 */
function fingerprint(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/** sk_test_… → 'test', sk_live_… → 'live', anything else → 'unknown'. */
function paystackKeyMode(key) {
  if (!key) return null;
  const normalized = String(key).trim();
  if (normalized.startsWith('sk_test_')) return 'test';
  if (normalized.startsWith('sk_live_')) return 'live';
  if (normalized.startsWith('pk_test_') || normalized.startsWith('pk_live_')) return 'public-key-misconfigured';
  return 'unknown';
}

/** Best-effort public origin of the running deployment, from request headers. */
function detectPublicOrigin(req) {
  // Request host first (allowlisted), then PUBLIC_BASE_URL, then Vercel
  // platform hints. Never env-first: a stale PUBLIC_BASE_URL was what made
  // this diagnostic recommend a dead webhook URL in production.
  const fromRequest = requestOrigin(req);
  if (fromRequest) return fromRequest;
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');

  const fallbackHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || null;
  if (!fallbackHost) return null;
  return `https://${fallbackHost}`;
}

/**
 * Environment variable presence report. Values are NEVER included — only
 * whether they are set, their length, and a fingerprint for comparison.
 */
function environmentReport() {
  const supabase = supabaseConfigState();
  const paystackKey = process.env.PAYSTACK_SECRET_KEY || '';
  const webhookSecret = process.env.WEBHOOK_SECRET || '';

  return {
    PAYSTACK_SECRET_KEY: {
      configured: Boolean(paystackKey),
      length: paystackKey.length || 0,
      prefix: paystackKey ? `${paystackKey.slice(0, 8)}…` : null,
      fingerprint: fingerprint(paystackKey),
      mode: paystackKeyMode(paystackKey)
    },
    WEBHOOK_SECRET: {
      configured: Boolean(webhookSecret),
      length: webhookSecret.length || 0,
      prefix: webhookSecret ? `${webhookSecret.slice(0, 8)}…` : null,
      fingerprint: fingerprint(webhookSecret),
      required: false,
      note: 'Optional. Paystack signs with PAYSTACK_SECRET_KEY, so leaving this unset is correct.'
    },
    SUPABASE_URL: {
      configured: supabase.urlConfigured,
      // The project ref is not a secret and makes "wrong project" obvious.
      host: process.env.SUPABASE_URL
        ? String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('/')[0]
        : null
    },
    SUPABASE_SERVICE_ROLE_KEY: {
      configured: supabase.serviceRoleKeyConfigured,
      length: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').length || 0
    },
    SUPABASE_ANON_KEY: {
      configured: supabase.anonKeyConfigured,
      length: (process.env.SUPABASE_ANON_KEY || '').length || 0
    },
    PUBLIC_BASE_URL: {
      configured: Boolean(process.env.PUBLIC_BASE_URL),
      value: process.env.PUBLIC_BASE_URL || null
    }
  };
}

/**
 * The four "common webhook issues" from the debugging checklist, each answered
 * as a pass / fail / unknown check with an actionable fix.
 */
function configurationChecks(req) {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY || '';
  const webhookSecret = process.env.WEBHOOK_SECRET || '';
  const effectiveSecret = getWebhookSecret();
  const supabase = supabaseConfigState();
  const origin = detectPublicOrigin(req);
  const liveWebhookUrl = origin ? `${origin}/api/webhook` : null;
  const mode = paystackKeyMode(paystackKey);

  const checks = [];

  // 1. A signing secret must exist at all.
  checks.push({
    id: 'signing-secret-present',
    label: 'A webhook signing secret is configured',
    status: effectiveSecret ? 'pass' : 'fail',
    detail: effectiveSecret
      ? `Signing with ${paystackKey ? 'PAYSTACK_SECRET_KEY' : 'WEBHOOK_SECRET (legacy fallback)'}.`
      : 'Neither PAYSTACK_SECRET_KEY nor WEBHOOK_SECRET is set, so every signature check fails.',
    fix: effectiveSecret
      ? null
      : 'Add PAYSTACK_SECRET_KEY to your Vercel Project → Settings → Environment Variables, then redeploy.'
  });

  // 2. Paystack's own key is authoritative. A stale WEBHOOK_SECRET must not
  // override it (production once had live Paystack + a test webhook secret).
  checks.push({
    id: 'webhook-secret-matches-paystack-key',
    label: 'PAYSTACK_SECRET_KEY is authoritative for Paystack signatures',
    status: paystackKey ? 'pass' : webhookSecret ? 'warn' : 'fail',
    detail: paystackKey
      ? webhookSecret && webhookSecret !== paystackKey
        ? 'PAYSTACK_SECRET_KEY is used. WEBHOOK_SECRET differs but is safely ignored for Paystack verification.'
        : 'PAYSTACK_SECRET_KEY is used directly, as required by Paystack.'
      : webhookSecret
        ? 'PAYSTACK_SECRET_KEY is missing; using WEBHOOK_SECRET only as a legacy fallback.'
        : 'No signature credential is configured.',
    fix: paystackKey
      ? null
      : 'Set PAYSTACK_SECRET_KEY to the secret key for the Paystack mode/account sending this webhook.',
    fingerprints: {
      PAYSTACK_SECRET_KEY: fingerprint(paystackKey),
      WEBHOOK_SECRET: fingerprint(webhookSecret)
    }
  });

  // 3. Checklist item: is the webhook URL exactly the canonical one?
  const canonicalUrl = canonicalWebhookUrl(req);
  const urlMatches = Boolean(liveWebhookUrl) && liveWebhookUrl === canonicalUrl;
  checks.push({
    id: 'webhook-url',
    label: `Webhook URL is exactly ${canonicalUrl}`,
    status: !liveWebhookUrl ? 'unknown' : urlMatches ? 'pass' : 'warn',
    detail: !liveWebhookUrl
      ? 'Could not determine this deployment\'s public origin from the request.'
      : urlMatches
        ? 'This deployment is being served from the canonical domain, so the dashboard URL should match exactly.'
        : `This request arrived at ${liveWebhookUrl}. That is a valid endpoint, but it is not the canonical ` +
          `${canonicalUrl}. Paystack only calls the ONE url saved in your dashboard.`,
    fix:
      urlMatches
        ? null
        : `In Paystack → Settings → API Keys & Webhooks, set the ${mode === 'live' ? 'Live' : 'Test'} Webhook URL to ` +
          `${canonicalUrl} — no trailing slash, no /api/webhook/, https not http.`,
    observed: liveWebhookUrl,
    expected: canonicalUrl
  });

  // 4. Checklist item: test mode vs live mode.
  checks.push({
    id: 'paystack-mode',
    label: 'Paystack key mode (Test vs Live)',
    status: mode === 'test' || mode === 'live' ? 'pass' : paystackKey ? 'fail' : 'unknown',
    detail: !paystackKey
      ? 'PAYSTACK_SECRET_KEY is not set, so the mode cannot be determined.'
      : mode === 'test'
        ? 'This deployment holds a TEST secret key (sk_test_…). It will ONLY ever receive webhooks from the ' +
          'Test Mode webhook URL, and only for test payments.'
        : mode === 'live'
          ? 'This deployment holds a LIVE secret key (sk_live_…). It will ONLY receive webhooks from the ' +
            'Live Mode webhook URL, and only for real payments.'
          : mode === 'public-key-misconfigured'
            ? 'PAYSTACK_SECRET_KEY looks like a PUBLIC key (pk_…). Webhook signatures can never verify with a public key.'
            : 'PAYSTACK_SECRET_KEY does not start with sk_test_ or sk_live_. It may be truncated or have stray whitespace.',
    fix:
      mode === 'test' || mode === 'live'
        ? `Make sure the webhook URL is saved under the ${mode === 'test' ? 'TEST' : 'LIVE'} mode toggle in Paystack — ` +
          'the two modes have separate webhook URL fields and separate secret keys.'
        : 'Copy the secret key again from Paystack → Settings → API Keys & Webhooks (it must start with sk_test_ or sk_live_).',
    mode
  });

  // 5. Checklist item: charge.success / charge.failed events selected.
  checks.push({
    id: 'events-selected',
    label: 'charge.success and charge.failed are handled',
    status: 'pass',
    detail:
      'Paystack has no per-event subscription UI — it POSTs EVERY event to your single webhook URL. ' +
      'This endpoint handles charge.success and charge.failed, and answers 200 (ignored) for every other event ' +
      'so Paystack does not mark the delivery as failed and retry it.',
    fix: null,
    handledEvents: ['charge.success', 'charge.failed']
  });

  // 6. Supabase must be writable, or a verified webhook still saves nothing.
  checks.push({
    id: 'supabase-configured',
    label: 'Supabase is configured for server-side writes',
    status: supabase.configured ? (supabase.serviceRoleKeyConfigured ? 'pass' : 'warn') : 'fail',
    detail: !supabase.configured
      ? 'SUPABASE_URL and a Supabase key are required — without them a perfectly delivered webhook still saves nothing.'
      : supabase.serviceRoleKeyConfigured
        ? 'Using the service role key, so Row Level Security cannot silently reject the insert.'
        : 'Using the anon key. Row Level Security will reject the insert unless the transactions table has an INSERT policy.',
    fix: supabase.serviceRoleKeyConfigured
      ? null
      : 'Set SUPABASE_SERVICE_ROLE_KEY in Vercel (Supabase → Settings → API → service_role secret), then redeploy.'
  });

  // 7. Has anything at all ever hit the endpoint on this instance?
  const hitCount = webhookLog.getWebhookHitCount();
  checks.push({
    id: 'delivery-observed',
    label: 'A webhook request has reached this server instance',
    status: hitCount > 0 ? 'pass' : 'unknown',
    detail:
      hitCount > 0
        ? `${hitCount} inbound webhook request(s) recorded since this instance started.`
        : 'No inbound request recorded YET on this instance. On Vercel every cold start begins with an empty log, ' +
          'so this is not proof that Paystack never called — check the Vercel runtime logs too.',
    fix:
      hitCount > 0
        ? null
        : 'POST to /api/test-webhook (curl or the button on this page) to prove the deployment can receive POSTs at all.'
  });

  return checks;
}

/** Roll the individual checks up into one verdict. */
function summarizeChecks(checks) {
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');
  return {
    total: checks.length,
    passed: checks.filter(c => c.status === 'pass').length,
    warnings: warned.length,
    failures: failed.length,
    unknown: checks.filter(c => c.status === 'unknown').length,
    healthy: failed.length === 0,
    blockingIssues: failed.map(c => c.label)
  };
}

/**
 * Paystack does NOT expose webhook delivery logs over its API, so the closest
 * honest equivalent is: fetch the most recent transactions Paystack knows about
 * and report, for each, whether it made it into our database. If Paystack shows
 * a successful charge that is missing locally, the webhook did not land.
 *
 * @returns {Promise<object>} never throws
 */
async function getRecentPaystackDeliveries(limit = 10) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    return {
      available: false,
      reason: 'PAYSTACK_SECRET_KEY is not set, so the Paystack API cannot be queried.',
      deliveries: []
    };
  }

  let paystackJson;
  try {
    const response = await fetch(
      `https://api.paystack.co/transaction?perPage=${encodeURIComponent(limit)}&page=1`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );
    paystackJson = await response.json();

    if (!response.ok || !paystackJson || paystackJson.status !== true) {
      return {
        available: false,
        reason:
          (paystackJson && paystackJson.message) ||
          `Paystack responded with HTTP ${response.status}`,
        deliveries: []
      };
    }
  } catch (error) {
    return {
      available: false,
      reason: `Could not reach the Paystack API: ${error && error.message ? error.message : String(error)}`,
      deliveries: []
    };
  }

  const paystackTransactions = Array.isArray(paystackJson.data) ? paystackJson.data : [];
  const references = paystackTransactions.map(t => t && t.reference).filter(Boolean);

  // Cross-reference against our own table to see which ones actually saved.
  const savedReferences = new Set();
  let lookupError = null;
  const client = getSupabaseClient();

  if (client && references.length) {
    try {
      const { data, error } = await client
        .from('transactions')
        .select('reference')
        .in('reference', references);
      if (error) lookupError = error.message || String(error);
      else for (const row of data || []) savedReferences.add(row.reference);
    } catch (thrown) {
      lookupError = thrown && thrown.message ? thrown.message : String(thrown);
    }
  } else if (!client) {
    lookupError = 'Supabase client unavailable, so saved/missing status is unknown.';
  }

  const deliveries = paystackTransactions.map(transaction => {
    const reference = transaction.reference;
    const status = String(transaction.status || '').toLowerCase();
    const saved = savedReferences.has(reference);
    return {
      reference,
      paystackStatus: transaction.status || null,
      amount: Number.isFinite(Number(transaction.amount)) ? Number(transaction.amount) / 100 : null,
      currency: transaction.currency || 'GHS',
      channel: transaction.channel || null,
      customer: (transaction.customer && transaction.customer.email) || null,
      createdAt: transaction.created_at || transaction.createdAt || null,
      paidAt: transaction.paid_at || transaction.paidAt || null,
      savedInDatabase: lookupError ? null : saved,
      // A successful Paystack charge that is missing locally is the smoking gun.
      webhookVerdict: lookupError
        ? 'unknown'
        : saved
          ? 'delivered'
          : status === 'success'
            ? 'missing'
            : 'not-expected'
    };
  });

  return {
    available: true,
    source: 'paystack:/transaction (Paystack does not expose webhook delivery logs over its API)',
    reason: null,
    lookupError,
    count: deliveries.length,
    missingSuccessfulCharges: deliveries.filter(d => d.webhookVerdict === 'missing').length,
    deliveries
  };
}

async function buildFanOutLogs() {
  const tenants = tenantsModule.listAllTenants();
  const logs = [];

  for (const tenant of tenants) {
    const { deliveries: dbDeliveries, error } = await deliveryStore.fetchRecentDeliveries(tenant.key, 10);
    
    // Merge with in-memory logs for completeness (especially useful during transitions or local dev)
    const memDeliveries = tenantWebhookForwarderModule.getDeliveryLog({ tenant_key: tenant.key }).slice(0, 10);
    
    // Map in-memory deliveries to the same shape as DB deliveries if they differ
    const normalizedMem = memDeliveries.map(d => ({
      created_at: d.timestamp,
      reference: d.reference,
      url: d.url,
      request_body: d.request_body || JSON.stringify(d.payload),
      response_status: d.statusCode || d.response_status || 0,
      response_time_ms: d.durationMs || d.response_time_ms || 0,
      retry_count: d.attempt || d.retry_count || 0,
      success: d.success,
      error: d.error
    }));

    // Simple merge by reference and timestamp (newest first)
    const combined = [...normalizedMem];
    const seenRefs = new Set(combined.map(d => `${d.reference}-${d.created_at}`));
    
    for (const d of dbDeliveries || []) {
      const key = `${d.reference}-${d.created_at}`;
      if (!seenRefs.has(key)) {
        combined.push(d);
        seenRefs.add(key);
      }
    }

    combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    logs.push({
      tenantKey: tenant.key,
      displayName: tenant.display_name,
      webhookUrl: tenant.webhook_url,
      deliveries: combined.slice(0, 10),
      error: error ? error.message || String(error) : null
    });
  }

  return logs;
}

/**
 * The full diagnostic payload rendered by webhook-status.html.
 *
 * @param {object} req                 the inbound request (for origin detection)
 * @param {object} [options]
 * @param {boolean} [options.includePaystack=true] query the Paystack API too
 */
async function buildDiagnostics(req, options = {}) {
  const includePaystack = options.includePaystack !== false;
  const checks = configurationChecks(req);
  const origin = detectPublicOrigin(req);

  const diagnostics = {
    success: true,
    generatedAt: new Date().toISOString(),
    deployment: {
      origin,
      isVercel: Boolean(process.env.VERCEL),
      vercelEnv: process.env.VERCEL_ENV || 'local',
      vercelRegion: process.env.VERCEL_REGION || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
      nodeVersion: process.version
    },
    webhookConfiguration: {
      canonicalUrl: canonicalWebhookUrl(req),
      liveUrl: origin ? `${origin}/api/webhook` : null,
      testEndpointUrl: origin ? `${origin}/api/test-webhook` : '/api/test-webhook',
      signingSecretSource: process.env.PAYSTACK_SECRET_KEY
        ? 'PAYSTACK_SECRET_KEY'
        : process.env.WEBHOOK_SECRET
          ? 'WEBHOOK_SECRET (legacy fallback)'
          : null,
      signatureHeader: 'x-paystack-signature',
      signatureAlgorithm: 'HMAC SHA-512 over the raw request body',
      handledEvents: ['charge.success', 'charge.failed'],
      paystackMode: paystackKeyMode(process.env.PAYSTACK_SECRET_KEY)
    },
    environment: environmentReport(),
    checks,
    summary: summarizeChecks(checks),
    recentInboundRequests: {
      note:
        'Requests observed by THIS server instance. Serverless instances are recycled, so an empty list is ' +
        'inconclusive — a non-empty list is proof of delivery.',
      instanceHitCount: webhookLog.getWebhookHitCount(),
      hits: webhookLog.getRecentWebhookHits(10)
    },
    fanOutLogs: await buildFanOutLogs()
  };

  diagnostics.paystackDeliveries = includePaystack
    ? await getRecentPaystackDeliveries(10)
    : { available: false, reason: 'Paystack lookup skipped.', deliveries: [] };

  return diagnostics;
}

module.exports = {
  CANONICAL_WEBHOOK_URL: `${DEFAULT_PUBLIC_BASE_URL}/api/webhook`, // legacy export, req-free callers
  canonicalWebhookUrl,
  getWebhookSecret,
  fingerprint,
  paystackKeyMode,
  detectPublicOrigin,
  environmentReport,
  configurationChecks,
  summarizeChecks,
  getRecentPaystackDeliveries,
  buildDiagnostics
};
