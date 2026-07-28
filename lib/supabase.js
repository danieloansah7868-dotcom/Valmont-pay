/**
 * Shared Supabase client (CommonJS so it can be required by server.js and
 * imported by the ESM serverless functions inside /api).
 *
 * Requires SUPABASE_URL and SUPABASE_ANON_KEY environment variables.
 * When these are not set, the exported `supabase` will be null so callers
 * can gracefully degrade instead of crashing at module-load time.
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

let supabase = null;

if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
} else {
  console.log('[SUPABASE] SUPABASE_URL or SUPABASE_ANON_KEY not set — Supabase client disabled');
}

module.exports = { supabase };
