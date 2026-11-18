// Postgres app databases: Supabase, Neon, Railway, Render, RDS, DigitalOcean
// and any other host. The member makes a read-only role and pastes its
// connection string. NoBossly refuses a role that can write to any table,
// connects only to a public address over TLS, and runs every query inside a
// read-only transaction with a short time limit. It only ever counts rows.

const { Client } = require('pg');
const { resolvePublic } = require('./safety');
const { TIMEOUT_MS, CONNECT_MS, DAYS } = require('./common');

// Which host a connection string is for, to name it and pick defaults.
function providerOf(host) {
  if (/\.supabase\.(co|com)$/.test(host)) return 'supabase';
  if (/\.neon\.tech$/.test(host)) return 'neon';
  if (/\.rlwy\.net$|railway\.app$/.test(host)) return 'railway';
  if (/\.render\.com$/.test(host)) return 'render';
  if (/\.rds\.amazonaws\.com$/.test(host)) return 'rds';
  if (/\.ondigitalocean\.com$/.test(host)) return 'digitalocean';
  return 'postgres';
}

/** A pasted connection string → its parts, or { error }. */
function parse(raw) {
  const s = String(raw || '').trim();
  let u;
  try { u = new URL(s); } catch (_) { return { error: 'Paste the whole connection string; it starts with postgresql://' }; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { error: 'That is not a Postgres connection string (it should start with postgresql://).' };
  const user = decodeURIComponent(u.username || ''), password = decodeURIComponent(u.password || '');
  const database = decodeURIComponent((u.pathname || '').replace(/^\//, '')) || 'postgres';
  if (!user || !password) return { error: 'The connection string needs the read-only user and its password in it.' };
  if (!u.hostname) return { error: 'The connection string has no host in it.' };
  const port = Number(u.port || 5432);
  if (!(port > 0 && port < 65536)) return { error: 'That port does not look right.' };
  return { host: u.hostname.toLowerCase(), port, user, password, database, url: s, provider: providerOf(u.hostname.toLowerCase()) };
}

// Quote an identifier that has already been checked against the catalogue.
const q = id => '"' + String(id).replace(/"/g, '""') + '"';

async function open(p, { lookup, ClientImpl = Client, resolve = resolvePublic } = {}) {
  const r = await resolve(p.host, { lookup });
  if (r.error) return { error: r.error };
  const client = new ClientImpl({
    host: r.address, port: p.port, user: p.user, password: p.password, database: p.database,
    // Encrypted always; the name is sent for providers that route by it (Neon).
    ssl: { rejectUnauthorized: false, servername: p.host },
    connectionTimeoutMillis: CONNECT_MS, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 2000,
    application_name: 'NoBossly (read-only counts)'
  });
  try { await client.connect(); } catch (e) { return { error: explain(e) }; }
  try { await client.query('begin transaction read only'); await client.query("set local statement_timeout = '" + TIMEOUT_MS + "ms'"); }
  catch (e) { await client.end().catch(() => {}); return { error: explain(e) }; }
  return { client, close: () => client.query('rollback').catch(() => {}).then(() => client.end()).catch(() => {}) };
}

function explain(e) {
  const m = String((e && e.message) || e || '');
  const code = e && e.code;
  if (code === '28P01' || /password authentication failed/i.test(m)) return 'The database did not accept that user and password.';
  if (code === '3D000' || /database .* does not exist/i.test(m)) return 'That database name was not found.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'We could not find that host. Check the connection string.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout|ENETUNREACH|EHOSTUNREACH/i.test(m)) return 'We could not reach the database. Check the host and port, and that it accepts connections from the internet.';
  if (/permission denied/i.test(m)) return 'That user cannot read the table it needs. Grant it SELECT on that table.';
  if (/ssl|tls/i.test(m)) return 'The database refused an encrypted connection.';
  return 'The database answered with an error: ' + m.slice(0, 160);
}

// Tables this role can write to. Any at all and the connection is refused.
const WRITABLE = `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
    and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE') or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))
  limit 3`;

async function verify(p, opts = {}) {
  const o = await open(p, opts);
  if (o.error) return { ok: false, error: o.error };
  try {
    const su = await o.client.query('select rolsuper from pg_roles where rolname = current_user');
    if (su.rows[0] && su.rows[0].rolsuper) return { ok: false, error: 'That user is a superuser, so it could change your data. Make a read-only role (the steps are on this page) and use that.' };
    const w = await o.client.query(WRITABLE);
    if (w.rows.length) return { ok: false, error: 'That user can change data (for example in ' + w.rows.map(r => r.t).join(', ') + '). Use a read-only role that can only SELECT.' };
    return { ok: true };
  } catch (e) { return { ok: false, error: explain(e) }; }
  finally { await o.close(); }
}

// Tables the role can read that have a date column to count sign-ups by.
const TABLES = `select table_schema as s, table_name as t, column_name as c, data_type as d
  from information_schema.columns
  where table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg_toast%'
    and data_type in ('timestamp with time zone', 'timestamp without time zone', 'date', 'bigint', 'integer')
    and has_column_privilege(quote_ident(table_schema) || '.' || quote_ident(table_name), column_name, 'SELECT')
  order by (table_schema = 'auth' and table_name = 'users') desc, (table_name ~* 'user|member|account|customer|profile|signup|waitlist|subscriber') desc, table_schema, table_name, ordinal_position
  limit 600`;

async function tables(p, opts = {}) {
  const o = await open(p, opts);
  if (o.error) return { error: o.error };
  try {
    const r = await o.client.query(TABLES);
    return { tables: group(r.rows) };
  } catch (e) { return { error: explain(e) }; }
  finally { await o.close(); }
}
function group(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.s + '.' + r.t;
    if (!by.has(k)) by.set(k, { schema: r.s, table: r.t, key: k, columns: [] });
    by.get(k).columns.push({ name: r.c, type: r.d, epoch: /int/.test(r.d) });
  }
  return [...by.values()].filter(t => t.columns.some(c => !c.epoch || /creat|join|sign|regist|_at$|time/i.test(c.name))).slice(0, 80);
}

// A column as a timestamp expression (whole-second epoch numbers allowed).
const ts = (col, epoch) => (epoch ? 'to_timestamp(' + q(col) + ')' : q(col));

/**
 * Counts for a chosen table. cfg: { schema, table, created, createdEpoch,
 * active (optional), activeEpoch } — checked against the catalogue first, so
 * nothing the member typed reaches SQL unquoted.
 */
async function counts(p, cfg, opts = {}) {
  const o = await open(p, opts);
  if (o.error) return { error: o.error };
  try {
    const chk = await o.client.query(`select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = any($3)`,
      [cfg.schema, cfg.table, [cfg.created, cfg.active].filter(Boolean)]);
    const have = new Set(chk.rows.map(r => r.column_name));
    if (!have.has(cfg.created) || (cfg.active && !have.has(cfg.active))) return { error: 'The table or columns chosen are no longer there. Choose them again.' };
    const t = q(cfg.schema) + '.' + q(cfg.table), c = ts(cfg.created, cfg.createdEpoch);
    const a = cfg.active ? ts(cfg.active, cfg.activeEpoch) : null;
    const total = await o.client.query('select count(*)::bigint as n' + (a ? `, count(*) filter (where ${a} >= now() - interval '7 days')::bigint as a7, count(*) filter (where ${a} >= now() - interval '30 days')::bigint as a30` : '') + ' from ' + t);
    const days = await o.client.query(`select to_char(date_trunc('day', ${c} at time zone 'UTC'), 'YYYY-MM-DD') as d, count(*)::bigint as n from ${t}
      where ${c} >= now() - interval '${DAYS} days' group by 1`);
    const byDay = {};
    days.rows.forEach(r => { byDay[r.d] = Number(r.n); });
    const row = total.rows[0] || {};
    return { total: Number(row.n), active7: a ? Number(row.a7) : null, active30: a ? Number(row.a30) : null, byDay };
  } catch (e) { return { error: explain(e) }; }
  finally { await o.close(); }
}

// Supabase keeps sign-ups in auth.users; most apps have it.
const SUGGEST = { schema: 'auth', table: 'users', created: 'created_at', active: 'last_sign_in_at' };

module.exports = { parse, providerOf, verify, tables, counts, explain, group, q, SUGGEST, WRITABLE };
