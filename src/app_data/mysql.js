// MySQL app databases, PlanetScale included. Same rules as Postgres: a
// read-only user (one with INSERT, UPDATE, DELETE or ALL is refused), a
// public address over TLS, a read-only transaction with a time limit, and
// only counts.

const mysql = require('mysql2/promise');
const { resolvePublic } = require('./safety');
const { TIMEOUT_MS, CONNECT_MS, DAYS } = require('./common');

function providerOf(host) {
  if (/\.psdb\.cloud$|planetscale/.test(host)) return 'planetscale';
  if (/\.rds\.amazonaws\.com$/.test(host)) return 'rds';
  if (/\.ondigitalocean\.com$/.test(host)) return 'digitalocean';
  if (/\.rlwy\.net$|railway\.app$/.test(host)) return 'railway';
  return 'mysql';
}

function parse(raw) {
  const s = String(raw || '').trim();
  let u;
  try { u = new URL(s); } catch (_) { return { error: 'Paste the whole connection string; it starts with mysql://' }; }
  if (u.protocol !== 'mysql:') return { error: 'That is not a MySQL connection string (it should start with mysql://).' };
  let user, password;
  try { user = decodeURIComponent(u.username || ''); password = decodeURIComponent(u.password || ''); }
  catch (_) { return { error: 'The password has a symbol that breaks the connection string. Use a password of only letters and numbers.' }; }
  const database = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
  if (!user || !password) return { error: 'The connection string needs the read-only user and its password in it.' };
  if (!database) return { error: 'The connection string needs the database name at the end.' };
  const port = Number(u.port || 3306);
  if (!(port > 0 && port < 65536)) return { error: 'That port does not look right.' };
  return { host: u.hostname.toLowerCase(), port, user, password, database, url: s, provider: providerOf(u.hostname.toLowerCase()) };
}

const q = id => '`' + String(id).replace(/`/g, '``') + '`';

function explain(e) {
  const m = String((e && e.message) || e || '');
  const code = e && e.code;
  if (code === 'ER_ACCESS_DENIED_ERROR' || /access denied for user/i.test(m)) return 'The database did not accept that user and password.';
  if (code === 'ER_BAD_DB_ERROR') return 'That database name was not found.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'We could not find that host. Check the connection string.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout|ENETUNREACH|EHOSTUNREACH/i.test(m)) return 'We could not reach the database. Check the host and port, and that it accepts connections from the internet.';
  if (/command denied|SELECT command denied/i.test(m)) return 'That user cannot read the table it needs. Grant it SELECT on that table.';
  return 'The database answered with an error: ' + m.slice(0, 160);
}

async function open(p, { lookup, create = mysql.createConnection, resolve = resolvePublic } = {}) {
  const r = await resolve(p.host, { lookup });
  if (r.error) return { error: r.error };
  let c;
  try {
    c = await create({ host: r.address, port: p.port, user: p.user, password: p.password, database: p.database,
      ssl: { rejectUnauthorized: false, servername: p.host, minVersion: 'TLSv1.2' }, connectTimeout: CONNECT_MS, dateStrings: true });
  } catch (e) { return { error: explain(e) }; }
  // Older servers and MariaDB name the time limit differently; either may be missing.
  await c.query('SET SESSION max_execution_time = ' + TIMEOUT_MS).catch(() => c.query('SET SESSION max_statement_time = ' + TIMEOUT_MS / 1000).catch(() => {}));
  try { await c.query('START TRANSACTION READ ONLY'); } catch (e) { await c.end().catch(() => {}); return { error: explain(e) }; }
  return { c, close: () => c.query('ROLLBACK').catch(() => {}).then(() => c.end()).catch(() => {}) };
}

// Grants that can change data.
const WRITES = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i;
function writeGrants(lines) {
  return lines.filter(l => /^GRANT /i.test(l) && !/^GRANT USAGE ON/i.test(l) && !/ ON `?(information_schema|performance_schema)`?\./i.test(l))
    .filter(l => WRITES.test(l.replace(/ ON [\s\S]*$/i, '')));
}

async function verify(p, opts = {}) {
  const o = await open(p, opts);
  if (o.error) return { ok: false, error: o.error };
  try {
    const [rows] = await o.c.query('SHOW GRANTS FOR CURRENT_USER()');
    const lines = rows.map(r => String(Object.values(r)[0] || ''));
    const bad = writeGrants(lines);
    if (bad.length) return { ok: false, error: 'That user can change data (' + bad[0].replace(/ TO [\s\S]*$/i, '').slice(0, 90) + '). Use a read-only user that has only SELECT.' };
    return { ok: true };
  } catch (e) { return { ok: false, error: explain(e) }; }
  finally { await o.close(); }
}

async function tables(p, opts = {}) {
  const o = await open(p, opts);
  if (o.error) return { error: o.error };
  try {
    const [rows] = await o.c.query(`select table_schema as s, table_name as t, column_name as c, data_type as d from information_schema.columns
      where table_schema = database() and data_type in ('datetime', 'timestamp', 'date', 'bigint', 'int')
      order by (table_name regexp 'user|member|account|customer|profile|signup|waitlist|subscriber') desc, table_name, ordinal_position limit 600`);
    const by = new Map();
    for (const r of rows) {
      const k = r.s + '.' + r.t;
      if (!by.has(k)) by.set(k, { schema: r.s, table: r.t, key: k, columns: [] });
      by.get(k).columns.push({ name: r.c, type: r.d, epoch: /int/.test(r.d) });
    }
    return { tables: [...by.values()].filter(t => t.columns.some(c => !c.epoch || /creat|join|sign|regist|_at$|time/i.test(c.name))).slice(0, 80) };
  } catch (e) { return { error: explain(e) }; }
  finally { await o.close(); }
}

const ts = (col, epoch) => (epoch ? 'FROM_UNIXTIME(' + q(col) + ')' : q(col));

async function counts(p, cfg, opts = {}) {
  const o = await open(p, opts);
  if (o.error) return { error: o.error };
  try {
    const [chk] = await o.c.query('select column_name as c from information_schema.columns where table_schema = ? and table_name = ?', [cfg.schema, cfg.table]);
    const have = new Set(chk.map(r => r.c));
    if (!have.has(cfg.created) || (cfg.active && !have.has(cfg.active))) return { error: 'The table or columns chosen are no longer there. Choose them again.' };
    const t = q(cfg.schema) + '.' + q(cfg.table), c = ts(cfg.created, cfg.createdEpoch);
    const a = cfg.active ? ts(cfg.active, cfg.activeEpoch) : null;
    const [[row]] = await o.c.query('select count(*) as n' + (a ? `, sum(${a} >= UTC_TIMESTAMP() - interval 7 day) as a7, sum(${a} >= UTC_TIMESTAMP() - interval 30 day) as a30` : '') + ' from ' + t);
    const [days] = await o.c.query(`select date_format(${c}, '%Y-%m-%d') as d, count(*) as n from ${t} where ${c} >= UTC_TIMESTAMP() - interval ${DAYS} day group by 1`);
    const byDay = {};
    days.forEach(r => { if (r.d) byDay[r.d] = Number(r.n); });
    return { total: Number(row.n), active7: a ? Number(row.a7 || 0) : null, active30: a ? Number(row.a30 || 0) : null, byDay };
  } catch (e) { return { error: explain(e) }; }
  finally { await o.close(); }
}

module.exports = { parse, providerOf, verify, tables, counts, explain, writeGrants, q };
