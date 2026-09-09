const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

// --------------------------------------------------------------------------
// Why every client is wrapped.
//
// supabase-js RESOLVES on a database error rather than rejecting. A failed
// write comes back as `{ data: null, error: {...} }`, so this:
//
//   try { await sb.from('x').insert(row); } catch (e) { next(e); }
//
// never enters the catch. It is not a careless pattern — it reads as careful —
// but for a database error it is exactly as silent as no handling at all. A
// hundred and seventeen writes in this codebase are written that way, and it is
// why a stale CHECK constraint could reject every notification in the product
// for months with nothing in the log.
//
// Rewriting all of them means a hundred and seventeen decisions about what to
// do on failure, most of which is "nothing sensible, the caller cannot recover".
// The useful part is the record. So the client itself keeps it: every write
// still resolves exactly as before, and every write that failed also says so
// once, naming the table and the operation.
//
// This changes nothing about control flow. Callers that check `error` still
// check it; callers that ignore it still ignore it. The difference is that the
// failure is now in the log rather than nowhere.

const WRITES = ['insert', 'update', 'upsert', 'delete'];

// PostgrestBuilder is a thenable, and its filter methods (.eq, .select, …)
// return the same instance, so shadowing `then` once with an own property
// survives the whole chain.
function watch(builder, label) {
  if (!builder || typeof builder.then !== 'function' || builder.__dbWatched) return builder;
  const then = builder.then.bind(builder);
  Object.defineProperty(builder, '__dbWatched', { value: true, enumerable: false });
  builder.then = (onOk, onErr) => then((res) => {
    if (res && res.error) {
      console.error('[db] ' + label + ' failed:', res.error.code || '', res.error.message || res.error);
      // Marked so quiet() in src/db.js does not report the same failure twice.
      try { Object.defineProperty(res, '__dbLogged', { value: true, enumerable: false }); } catch (_) {}
    }
    return onOk ? onOk(res) : res;
  }, onErr);
  return builder;
}

function withWriteLogging(client) {
  const from = client.from.bind(client);
  client.from = (table) => {
    const qb = from(table);
    for (const verb of WRITES) {
      if (typeof qb[verb] !== 'function') continue;
      const original = qb[verb].bind(qb);
      qb[verb] = (...args) => watch(original(...args), table + '.' + verb);
    }
    return qb;
  };
  const rpc = client.rpc.bind(client);
  client.rpc = (fn, ...rest) => watch(rpc(fn, ...rest), 'rpc ' + fn);
  return client;
}

// Anonymous client (no user context) — for auth calls
function anonClient() {
  return withWriteLogging(createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } }));
}

// Client acting as the logged-in user (RLS applies)
function userClient(accessToken) {
  return withWriteLogging(createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  }));
}

// Service-role client — bypasses RLS; only use in trusted server-side contexts.
// Requires SUPABASE_SERVICE_ROLE_KEY in .env (Supabase Dashboard -> Settings -> API).
function serviceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return withWriteLogging(createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }));
}

module.exports = { anonClient, userClient, serviceClient, withWriteLogging };
