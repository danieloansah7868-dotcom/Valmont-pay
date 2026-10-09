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
//
// ── And when the SDK is missing, we no longer just give up ───────────────
// Returning null meant every ledger read failed, `GET /api/transactions`
// answered 500, and dashboard.html silently rendered an EMPTY ledger — the
// money was still in Postgres but looked gone (2026-10-09: a real GH₵55.00
// ledger rendered as "nothing"). Supabase's data endpoint is PostgREST, so
// the same reads/writes work over plain HTTP. lib/postgrest-client.js is a
// dependency-free fallback transport with the identical
// `.from(table)…→ { data, error, count }` surface: no npm package, no
// bundler, nothing a serverless build can forget to ship.
const { createPostgrestClient } = require('./postgrest-client');

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
/**
 * How the current client was obtained:
 *   'unconfigured'  — SUPABASE_URL/key are missing (expected in local dev)
 *   'npm'           — official @supabase/supabase-js SDK
 *   'rest-fallback' — SDK unavailable; dependency-free PostgREST transport
 *   'unavailable'   — configured, but no transport could be built at all
 */
let transport = 'unconfigured';
/** `{ stage, message }` for the most recent failure, surfaced by /api/health. */
let lastError = null;

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
    transport = 'unconfigured';
    lastError = null;
    return null;
  }

  // Rebuild if the credentials changed (tests, or a re-used warm lambda whose
  // environment was updated between invocations).
  const nextCacheKey = `${url}::${key}`;
  if (client && cacheKey === nextCacheKey) return client;

  let built = null;

  if (!createClient) {
    lastError = {
      stage: 'sdk-import',
      message: createClientImportError && createClientImportError.message
        ? createClientImportError.message
        : 'unknown import failure'
    };
    console.error(
      '[SUPABASE] @supabase/supabase-js is not loaded — falling back to the ' +
      'dependency-free PostgREST transport:',
      lastError.message
    );
  } else {
    // createClient itself CAN throw — e.g. realtime-js resolves a global
    // WebSocket constructor eagerly, which does not exist on Node < 22. An
    // exception here must never take down a request path (diagnostics pages,
    // link resolution, webhook handling), and it must never mean "the ledger
    // is empty": the PostgREST transport covers the same ground over HTTP.
    try {
      built = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false }
      });
    } catch (error) {
      lastError = {
        stage: 'sdk-construct',
        message: error && error.message ? error.message : String(error)
      };
      console.error(
        '[SUPABASE] Client construction failed — falling back to the ' +
        'dependency-free PostgREST transport:',
        lastError.message
      );
      built = null;
    }
  }

  if (built) {
    transport = 'npm';
    lastError = null;
    console.log('[SUPABASE] Client initialized', {
      urlConfigured: true,
      transport,
      credentialType: serviceRoleKey ? 'service-role' : 'anon'
    });
  } else {
    // The ledger must not go dark just because an npm package is missing from
    // the bundle. PostgREST speaks the same query language over plain HTTPS.
    try {
      built = createPostgrestClient({ url, key });
      transport = 'rest-fallback';
      console.warn(
        '[SUPABASE] Using the dependency-free PostgREST transport ' +
        `(reason: ${lastError ? lastError.stage : 'sdk unavailable'}). ` +
        'Reads and writes work, but fix the deployment bundle so the official SDK is used.'
      );
    } catch (fallbackError) {
      lastError = {
        stage: 'rest-fallback',
        message: fallbackError && fallbackError.message ? fallbackError.message : String(fallbackError)
      };
      transport = 'unavailable';
      built = null;
      console.error(
        '[SUPABASE] No transport available — every ledger read/write will fail:',
        lastError.message
      );
    }
  }

  client = built;
  cacheKey = nextCacheKey; // memoize for this credential pair, success or not
  missingEnvironmentLogged = false;

  return client;
}

/**
 * Which transport is actually in use, and why. Surfaced by /api/health so a
 * deployment where the SDK is missing is visible in one GET instead of
 * masquerading as "no sales yet" on the dashboard.
 *
 * Values never include secrets: only a transport name, a stage and an error
 * message from the runtime (never a key, URL or row).
 */
function clientDiagnostics() {
  const state = supabaseConfigState();
  return {
    configured: state.configured,
    credentialType: state.credentialType,
    transport,
    clientReady: Boolean(client),
    sdkImportError: createClientImportError && createClientImportError.message
      ? createClientImportError.message
      : null,
    lastError
  };
}

/** Test helper — drop the memoised client so new env vars take effect. */
function resetSupabaseClient() {
  client = null;
  cacheKey = null;
  missingEnvironmentLogged = false;
  transport = 'unconfigured';
  lastError = null;
}

const moduleExports = {
  getSupabaseClient,
  isSupabaseConfigured,
  supabaseConfigState,
  missingSupabaseEnvMessage,
  clientDiagnostics,
  resetSupabaseClient
};

// Backwards compatible `supabase` export. It is a lazy getter, so requiring this
// module never creates a client (and never throws) before the env is ready.
Object.defineProperty(moduleExports, 'supabase', {
  enumerable: true,
  get: getSupabaseClient
});

module.exports = moduleExports;
