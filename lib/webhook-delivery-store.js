/**
 * Webhook delivery log store (Supabase `webhook_deliveries` table).
 *
 * Persists every attempt to forward a webhook to a tenant's URL.
 */

const { getSupabaseClient, isSupabaseConfigured, missingSupabaseEnvMessage } = require('./supabase');

/** The exact columns written to `webhook_deliveries`. */
const DELIVERY_COLUMNS = [
  'tenant_key',
  'reference',
  'event',
  'url',
  'request_body',
  'response_status',
  'response_time_ms',
  'retry_count',
  'success',
  'error'
];

/** Test/DI hook: an explicitly injected client wins over the env-built one. */
let injectedClient = null;

function setSupabaseClient(client) {
  injectedClient = client || null;
  return injectedClient;
}

function resolveClient(explicitClient) {
  return explicitClient || injectedClient || getSupabaseClient();
}

/** Turn a Supabase error object into a readable single-line reason. */
function describeError(error) {
  if (!error) return 'Unknown Supabase error';
  const parts = [error.message, error.details, error.hint].filter(Boolean);
  const text = parts.join(' — ');
  return text || JSON.stringify(error);
}

/**
 * Record a delivery attempt.
 *
 * @param {object} entry
 * @param {object} [options]
 * @returns {Promise<{ok:boolean, error:object|null}>}
 */
async function recordDelivery(entry, options = {}) {
  const context = options.context || 'WEBHOOK-DELIVERY-STORE';

  if (!isSupabaseConfigured()) {
    return { ok: false, reason: 'Supabase not configured', skipped: true };
  }

  const client = resolveClient(options.client);
  if (!client) {
    return { ok: false, reason: 'Supabase client unavailable', skipped: true };
  }

  // Truncate request body to avoid huge rows
  const request_body = entry.request_body && typeof entry.request_body === 'string'
    ? entry.request_body.slice(0, 1000)
    : entry.request_body;

  const record = {
    tenant_key: entry.tenant_key,
    reference: entry.reference,
    event: entry.event,
    url: entry.url,
    request_body: request_body,
    response_status: entry.response_status || 0,
    response_time_ms: entry.response_time_ms || 0,
    retry_count: entry.retry_count || 0,
    success: Boolean(entry.success),
    error: entry.error || null
  };

  try {
    const { error } = await client.from('webhook_deliveries').insert(record);
    if (error) {
      console.error(`[${context}] Failed to record delivery for ${entry.reference}:`, describeError(error));
      return { ok: false, error };
    }
    return { ok: true, error: null };
  } catch (thrown) {
    console.error(`[${context}] Exception recording delivery for ${entry.reference}:`, thrown.message);
    return { ok: false, error: thrown };
  }
}

/**
 * Fetch recent deliveries for a tenant.
 */
async function fetchRecentDeliveries(tenantKey, limit = 50, options = {}) {
  const context = options.context || 'WEBHOOK-DELIVERY-STORE';

  if (!isSupabaseConfigured()) {
    return { ok: false, reason: 'Supabase not configured', deliveries: [] };
  }

  const client = resolveClient(options.client);
  if (!client) {
    return { ok: false, reason: 'Supabase client unavailable', deliveries: [] };
  }

  try {
    const { data, error } = await client
      .from('webhook_deliveries')
      .select('*')
      .eq('tenant_key', tenantKey)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error(`[${context}] Failed to fetch deliveries for ${tenantKey}:`, describeError(error));
      return { ok: false, error, deliveries: [] };
    }

    return { ok: true, deliveries: data || [] };
  } catch (thrown) {
    console.error(`[${context}] Exception fetching deliveries for ${tenantKey}:`, thrown.message);
    return { ok: false, error: thrown, deliveries: [] };
  }
}

/**
 * Recent failed deliveries (newest first). Used by the cron retry worker.
 */
async function fetchFailedDeliveries(limit = 50, options = {}) {
  const context = options.context || 'WEBHOOK-DELIVERY-STORE';
  if (!isSupabaseConfigured()) {
    return { ok: false, reason: 'Supabase not configured', deliveries: [] };
  }
  const client = resolveClient(options.client);
  if (!client) {
    return { ok: false, reason: 'Supabase client unavailable', deliveries: [] };
  }
  try {
    const { data, error } = await client
      .from('webhook_deliveries')
      .select('*')
      .eq('success', false)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error(`[${context}] Failed to fetch failed deliveries:`, describeError(error));
      return { ok: false, error, deliveries: [] };
    }
    return { ok: true, deliveries: data || [] };
  } catch (thrown) {
    console.error(`[${context}] Exception fetching failed deliveries:`, thrown.message);
    return { ok: false, error: thrown, deliveries: [] };
  }
}

module.exports = {
  recordDelivery,
  fetchRecentDeliveries,
  fetchFailedDeliveries,
  setSupabaseClient
};
