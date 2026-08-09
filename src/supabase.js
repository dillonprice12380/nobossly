const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

// Anonymous client (no user context) — for auth calls
function anonClient() {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Client acting as the logged-in user (RLS applies)
function userClient(accessToken) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

// Service-role client — bypasses RLS; only use in trusted server-side contexts.
// Requires SUPABASE_SERVICE_ROLE_KEY in .env (Supabase Dashboard -> Settings -> API).
function serviceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

module.exports = { anonClient, userClient, serviceClient };
