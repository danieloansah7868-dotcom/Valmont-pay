/**
 * Shared Supabase client (CommonJS so it can be required by server.js and
 * imported by the ESM serverless functions inside /api).
 *
 * Vercel injects environment variables before the function module is loaded.
 * SUPABASE_SERVICE_ROLE_KEY is preferred for trusted server-side writes so Row
 * Level Security does not reject webhooks; SUPABASE_ANON_KEY remains supported
 * for projects that have an explicit insert policy.
 */

const { createClient } = require('@supabase/supabase-js');

let client = null;
let missingEnvironmentLogged = false;

function getSupabaseClient() {
  if (client) return client;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const supabaseKey = serviceRoleKey || anonKey;

  if (!supabaseUrl || !supabaseKey) {
    if (!missingEnvironmentLogged) {
      console.error(
        '[SUPABASE] Client disabled: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) are required'
      );
      missingEnvironmentLogged = true;
    }
    return null;
  }

  client = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  console.log('[SUPABASE] Client initialized', {
    urlConfigured: true,
    credentialType: serviceRoleKey ? 'service-role' : 'anon'
  });
  return client;
}

// Preserve the existing `supabase` export for all current callers while also
// exposing a lazy getter for the webhook's explicit configuration checks.
const supabase = getSupabaseClient();

module.exports = { supabase, getSupabaseClient };
