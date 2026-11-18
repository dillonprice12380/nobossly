// Supabase, after "Connect with Supabase". NoBossly reads through Supabase's
// own read-only query endpoint (it runs as supabase_read_only_user), so the
// member makes no role and runs no SQL. Only the Projects Read and Database
// Read permissions are needed. Counts only, like the other connectors.

const { call } = require('../connections/common');
const { DAYS } = require('./common');

const API = 'https://api.supabase.com/v1';
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";
const q = id => '"' + String(id).replace(/"/g, '""') + '"';

const explain = status => (status === 401 ? 'Supabase says NoBossly is not allowed in any more. Connect Supabase again.'
  : status === 403 ? 'NoBossly cannot read that project. Connect again and allow it, or choose another project.'
  : status === 404 ? 'That Supabase project was not found.'
  : status === 429 ? 'Supabase asked us to slow down. We will try again shortly.'
  : 'Supabase did not answer properly (' + (status || 'no response') + '). We will try again later.');

async function projects(access, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, API + '/projects', { headers: { Authorization: 'Bearer ' + access, Accept: 'application/json' } });
  if (r.status !== 200 || !Array.isArray(r.body)) return { error: explain(r.status) };
  return { projects: r.body.map(p => ({ id: p.ref || p.id, name: p.name || p.ref, note: p.region || '' })).filter(p => /^[a-z0-9]{10,40}$/.test(p.id)) };
}

async function sql(p, text, fetchImpl = fetch) {
  const r = await call(fetchImpl, API + '/projects/' + p.project + '/database/query/read-only', {
    method: 'POST', headers: { Authorization: 'Bearer ' + p.access, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: text })
  });
  if ((r.status !== 200 && r.status !== 201) || !Array.isArray(r.body)) {
    const m = r.body && (r.body.message || r.body.error);
    return { error: r.status === 400 && m ? 'Supabase could not run the count: ' + String(m).slice(0, 140) : explain(r.status) };
  }
  return { rows: r.body };
}

async function tables(p, opts = {}) {
  const r = await sql(p, `select table_schema as s, table_name as t, column_name as c, data_type as d from information_schema.columns
    where table_schema not in ('pg_catalog', 'information_schema', 'storage', 'realtime', 'vault', 'pgsodium', 'supabase_functions', 'supabase_migrations', 'net', 'cron', 'extensions', 'graphql', 'graphql_public', 'pgbouncer')
      and table_schema not like 'pg_%'
      and data_type in ('timestamp with time zone', 'timestamp without time zone', 'date', 'bigint', 'integer')
    order by (table_schema = 'auth' and table_name = 'users') desc, (table_name ~* 'user|member|account|customer|profile|signup|waitlist|subscriber') desc, table_schema, table_name
    limit 600`, opts.fetchImpl);
  if (r.error) return r;
  const by = new Map();
  for (const x of r.rows) {
    const k = x.s + '.' + x.t;
    if (x.s === 'auth' && x.t !== 'users') continue;
    if (!by.has(k)) by.set(k, { schema: x.s, table: x.t, key: k, columns: [] });
    by.get(k).columns.push({ name: x.c, type: x.d, epoch: /int/.test(x.d) });
  }
  return { tables: [...by.values()].filter(t => t.columns.some(c => !c.epoch || /creat|join|sign|regist|_at$|time/i.test(c.name))).slice(0, 80) };
}

const ts = (col, epoch) => (epoch ? 'to_timestamp(' + q(col) + ')' : q(col));

async function counts(p, cfg, opts = {}) {
  const chk = await sql(p, `select column_name as c from information_schema.columns where table_schema = ${lit(cfg.schema)} and table_name = ${lit(cfg.table)}`, opts.fetchImpl);
  if (chk.error) return chk;
  const have = new Set(chk.rows.map(r => r.c));
  if (!have.has(cfg.created) || (cfg.active && !have.has(cfg.active))) return { error: 'The table or columns chosen are no longer there. Choose them again.' };
  const t = q(cfg.schema) + '.' + q(cfg.table), c = ts(cfg.created, cfg.createdEpoch);
  const a = cfg.active ? ts(cfg.active, cfg.activeEpoch) : null;
  const tot = await sql(p, 'select count(*)::bigint as n' + (a ? `, count(*) filter (where ${a} >= now() - interval '7 days')::bigint as a7, count(*) filter (where ${a} >= now() - interval '30 days')::bigint as a30` : '') + ' from ' + t, opts.fetchImpl);
  if (tot.error) return tot;
  const days = await sql(p, `select to_char(date_trunc('day', ${c} at time zone 'UTC'), 'YYYY-MM-DD') as d, count(*)::bigint as n from ${t} where ${c} >= now() - interval '${DAYS} days' group by 1`, opts.fetchImpl);
  if (days.error) return days;
  const byDay = {};
  days.rows.forEach(r => { byDay[r.d] = Number(r.n); });
  const row = tot.rows[0] || {};
  return { total: Number(row.n), active7: a ? Number(row.a7) : null, active30: a ? Number(row.a30) : null, byDay };
}

const SUGGEST = { schema: 'auth', table: 'users', created: 'created_at', active: 'last_sign_in_at' };

module.exports = { projects, tables, counts, sql, explain, SUGGEST };
