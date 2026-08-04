/**
 * Shared, LAZY Supabase client (CommonJS so it can be required by server.js and
 * default-imported by the ESM serverless functions inside /api).
 *
 * The client is created on first use, never at module load time. That matters
 * on Vercel, where environment variables are injected before the handler runs
 * but a module can be evaluated in a context where they are not all present
 * yet, and it matters in tests, which set env vars then require this module.
 *
 * Credential preference:
 *   1. SUPABASE_SERVICE_ROLE_KEY — trusted server-side writes, bypasses Row
 *      Level Security so webhooks and checkout writes are never silently
 *      rejected.
 *   2. SUPABASE_ANON_KEY — only works when the `transactions` table has explicit
 *      RLS insert/select policies.
 *
 * The client is considered configured when SUPABASE_URL is present AND EITHER
 * key is present.
 */

// The require itself is guarded: on 2026-08-04 a Vercel build deployed the
// api/* function bundles WITHOUT node_modules/@supabase — every function
// crashed at cold start with FUNCTION_INVOCATION_FAILED ("Cannot find module
// '@supabase/supabase-js'", require stack /var/task/lib/supabase.js) while
// health/dashboards looked fine. A missing package must degrade to an
// explicit "Supabase unavailable" 500 JSON (every caller already handles a
// null client), never to an opaque cold-start crash.
let createClient = null;
let createClientImportError = null;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch (error) {
  createClientImportError = error;
  console.error(
    '[SUPABASE] @supabase/supabase-js could not be loaded (deployment bundle is missing it?):',
    error && error.message ? error.message : error
  );
}

let client = null;
let cacheKey = null;
let missingEnvironmentLogged = false;

/** Snapshot of what is (and is not) configured — handy for logs and errors. */
function supabaseConfigState() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  return {
    urlConfigured: Boolean(url),
    serviceRoleKeyConfigured: Boolean(serviceRoleKey),
    anonKeyConfigured: Boolean(anonKey),
    keyConfigured: Boolean(serviceRoleKey || anonKey),
    credentialType: serviceRoleKey ? 'service-role' : anonKey ? 'anon' : null,
    configured: Boolean(url && (serviceRoleKey || anonKey))
  };
}

function isSupabaseConfigured() {
  return supabaseConfigState().configured;
}

/** Human readable explanation of which environment variables are missing. */
function missingSupabaseEnvMessage() {
  const state = supabaseConfigState();
  const missing = [];
  if (!state.urlConfigured) missing.push('SUPABASE_URL');
  if (!state.keyConfigured) missing.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)');
  if (!missing.length) return null;
  return `Supabase is not configured: missing ${missing.join(' and ')}`;
}

/**
 * Get (and memoise) the Supabase client. Returns null when the environment is
 * not configured — callers must handle that explicitly instead of pretending
 * the write succeeded.
 */
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const key = serviceRoleKey || anonKey;

  if (!url || !key) {
    if (!missingEnvironmentLogged) {
      console.error(`[SUPABASE] Client disabled — ${missingSupabaseEnvMessage()}`);
      missingEnvironmentLogged = true;
    }
    return null;
  }

  if (!createClient) {
    console.error(
      '[SUPABASE] Client disabled — @supabase/supabase-js is not loaded:',
      createClientImportError && createClientImportError.message
        ? createClientImportError.message
        : 'unknown import failure'
    );
    return null;
  }

  // Rebuild if the credentials changed (tests, or a re-used warm lambda whose
  // environment was updated between invocations).
  const nextCacheKey = `${url}::${key}`;
  if (client && cacheKey === nextCacheKey) return client;

  // createClient itself CAN throw — e.g. realtime-js resolves a global
  // WebSocket constructor eagerly, which does not exist on Node < 22. An
  // exception here must never take down a request path (diagnostics pages,
  // link resolution, webhook handling): every caller already treats a null
  // client as "Supabase unavailable".
  try {
    client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  } catch (error) {
    console.error(
      '[SUPABASE] Client construction failed (treating as unavailable):',
      error && error.message ? error.message : error
    );
    client = null;
    cacheKey = nextCacheKey; // memoize the failure for this credential pair
    return null;
  }
  cacheKey = nextCacheKey;
  missingEnvironmentLogged = false;

  console.log('[SUPABASE] Client initialized', {
    urlConfigured: true,
    credentialType: serviceRoleKey ? 'service-role' : 'anon'
  });
  return client;
}

/** Test helper — drop the memoised client so new env vars take effect. */
function resetSupabaseClient() {
  client = null;
  cacheKey = null;
  missingEnvironmentLogged = false;
}

const moduleExports = {
  getSupabaseClient,
  isSupabaseConfigured,
  supabaseConfigState,
  missingSupabaseEnvMessage,
  resetSupabaseClient
};

// Backwards compatible `supabase` export. It is a lazy getter, so requiring this
// module never creates a client (and never throws) before the env is ready.
Object.defineProperty(moduleExports, 'supabase', {
  enumerable: true,
  get: getSupabaseClient
});

module.exports = moduleExports;
