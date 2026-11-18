// App data: a member connects their own app's database and NoBossly counts
// its users each day (src/app_data/postgres|mysql|firebase|wordpress). This
// file is the flow around them: connect, choose what to count, sync, and fill
// in the member's own dashboard numbers if they ask it to.

const pg = require('./postgres');
const my = require('./mysql');
const fb = require('./firebase');
const wp = require('./wordpress');
const C = require('./common');
const registry = require('../engines/registry');
const metrics = require('../engines/metrics');
require('../path_dashboards');   // registers every path's numbers

const EVERY_HOURS = 6;
const MAX = 3;

// Supabase does not let a project's own roles grant access to its auth
// schema, so the reader gets a view of the three columns instead, in a schema
// of its own that Supabase's API does not expose.
const SUPABASE_SQL = `create role nobossly_reader with login password 'choose-a-long-password';
create schema if not exists nobossly;
create or replace view nobossly.users as select id, created_at, last_sign_in_at from auth.users;
revoke all on schema nobossly from public;
grant usage on schema nobossly to nobossly_reader;
grant select on nobossly.users to nobossly_reader;`;
const POSTGRES_SQL = `create role nobossly_reader with login password 'choose-a-long-password';
grant usage on schema public to nobossly_reader;
grant select on public.users to nobossly_reader;   -- your users table`;
const MYSQL_SQL = `create user 'nobossly_reader'@'%' identified by 'choose-a-long-password';
grant select on your_database.users to 'nobossly_reader'@'%';   -- your users table`;

// What a member can pick on the connect page.
const PRESETS = {
  supabase: { key: 'supabase', kind: 'postgres', label: 'Supabase', emoji: '⚡', blurb: 'Sign-ups and sign-ins from Supabase Auth, or any table.',
    fields: [{ name: 'url', label: 'Connection string (Session pooler)', placeholder: 'postgresql://nobossly_reader.abcd…@aws-0-….pooler.supabase.com:5432/postgres', secret: true }],
    sql: SUPABASE_SQL,
    where: [
      'In your Supabase project, open the SQL Editor and run the lines below, with a password of your own (letters and numbers only, so it fits in the connection string). They make a role that can only read sign-up and sign-in times, through a view of three columns.',
      'Open Connect (top of the dashboard) → Session pooler, and copy the connection string.',
      'In the string, change the user from postgres.<your project ref> to nobossly_reader.<your project ref> (keep the part after the dot), and put in the password you chose.'
    ] },
  neon: { key: 'neon', kind: 'postgres', label: 'Neon', emoji: '🟢', blurb: 'Any users table in a Neon Postgres database.',
    fields: [{ name: 'url', label: 'Connection string', placeholder: 'postgresql://nobossly_reader:…@ep-….neon.tech/neondb?sslmode=require', secret: true }],
    sql: POSTGRES_SQL,
    where: [
      'In the Neon SQL Editor, run the lines below with your own users table. They make a role that can only read it.',
      'In Connection Details, pick that role and copy the connection string.'
    ] },
  postgres: { key: 'postgres', kind: 'postgres', label: 'Other Postgres', emoji: '🐘', blurb: 'Railway, Render, AWS RDS, DigitalOcean and any Postgres.',
    fields: [{ name: 'url', label: 'Connection string', placeholder: 'postgresql://nobossly_reader:…@host:5432/database', secret: true }],
    sql: POSTGRES_SQL,
    where: [
      'Run the lines below with your own users table. They make a role that can only read it.',
      'Copy your database\'s connection string and put that role and its password in it. The database has to accept connections from the internet.'
    ] },
  mysql: { key: 'mysql', kind: 'mysql', label: 'MySQL / PlanetScale', emoji: '🐬', blurb: 'Any users table in MySQL, including PlanetScale.',
    fields: [{ name: 'url', label: 'Connection string', placeholder: 'mysql://nobossly_reader:…@host:3306/database', secret: true }],
    sql: MYSQL_SQL,
    where: [
      'Make a user that can only SELECT your users table (the lines below). On PlanetScale, create a password with the Read-only role instead.',
      'Paste the connection string for that user, ending in your database name.'
    ] },
  firebase: { key: 'firebase', kind: 'firebase', label: 'Firebase', emoji: '🔥', blurb: 'Sign-ups and sign-ins from Firebase Authentication.',
    fields: [{ name: 'key', label: 'Service account key (JSON)', placeholder: '{ "type": "service_account", … }', secret: true, area: true }],
    where: [
      'In Google Cloud console → IAM → Service accounts (same project as Firebase), create a service account named nobossly-reader.',
      'Give it only the Firebase Authentication Viewer role.',
      'Under Keys, add a JSON key, open the file and paste all of it here.'
    ] },
  wordpress: { key: 'wordpress', kind: 'wordpress', label: 'WordPress', emoji: '📝', blurb: 'New registered users on a WordPress site.',
    fields: [
      { name: 'url', label: 'Site address', placeholder: 'https://example.com' },
      { name: 'user', label: 'Username (an administrator)' },
      { name: 'password', label: 'Application password', placeholder: 'abcd efgh ijkl mnop qrst uvwx', secret: true }
    ],
    where: [
      'In WordPress, open Users → Profile → Application Passwords.',
      'Name it NoBossly, click Add, and copy the password it shows once.',
      'WordPress has no read-only application passwords and does not record sign-ins, so NoBossly counts sign-ups only. You can revoke the password from the same screen at any time.'
    ] }
};
const KINDS = { postgres: pg, mysql: my, firebase: fb, wordpress: wp };

// The secret a kind keeps, from what the member pasted, and back again.
function parseInput(preset, body) {
  const b = body || {};
  if (preset.kind === 'postgres') return pg.parse(b.url);
  if (preset.kind === 'mysql') return my.parse(b.url);
  if (preset.kind === 'firebase') return fb.parse(b.key);
  return wp.parse(b);
}
function secretOfParsed(kind, p) {
  if (kind === 'postgres' || kind === 'mysql') return p.url;
  if (kind === 'firebase') return JSON.stringify({ type: 'service_account', project_id: p.project, client_email: p.email, private_key: p.key, private_key_id: p.keyId });
  return JSON.stringify({ url: p.url, user: p.user, password: p.password });
}
function parsedOfSecret(kind, s) {
  if (kind === 'postgres') return pg.parse(s);
  if (kind === 'mysql') return my.parse(s);
  if (kind === 'firebase') return fb.parse(s);
  try { return wp.parse(JSON.parse(s)); } catch (_) { return { error: 'unreadable' }; }
}
const needsTable = kind => kind === 'postgres' || kind === 'mysql';

/** Check what the member pasted, then keep it in the Vault. → { id } or { error }. */
async function connect(sc, userId, presetKey, body, opts = {}) {
  const preset = PRESETS[presetKey];
  if (!preset) return { error: 'Unknown database.' };
  const p = parseInput(preset, body);
  if (p.error) return { error: p.error };
  const mod = KINDS[preset.kind];
  const ok = await mod.verify(p, opts);
  if (!ok.ok) return { error: ok.error };
  const { data, error } = await C.store(sc, { id: opts.replaceId || null, userId, kind: preset.kind, provider: preset.kind === 'postgres' ? (p.provider === 'postgres' ? presetKey : p.provider) : (p.provider || presetKey),
    label: preset.label, host: p.host, secret: secretOfParsed(preset.kind, p) });
  if (error) return { error: /three app databases/i.test(error.message || '') ? 'You can connect up to ' + MAX + ' app databases. Disconnect one first.' : 'save', dbError: error };
  return { id: data };
}

async function parsedFor(sc, conn) {
  const s = await C.secretOf(sc, conn);
  if (!s) return { error: 'The connection could not be read. Disconnect and connect it again.' };
  const p = parsedOfSecret(conn.kind, s);
  return p.error ? { error: 'The connection could not be read. Disconnect and connect it again.' } : p;
}

/** The tables a Postgres or MySQL connection could count, for the set-up page. */
async function tablesFor(sc, conn, opts = {}) {
  if (!needsTable(conn.kind)) return { tables: [] };
  const p = await parsedFor(sc, conn);
  if (p.error) return p;
  return KINDS[conn.kind].tables(p, opts);
}

// Numbers a member can have filled in: count numbers, theirs first.
function fillable(pathMetricKeys = []) {
  const all = registry.all().metrics.filter(m => m.unit === 'count');
  const mine = new Set(pathMetricKeys);
  return all.sort((a, b) => (mine.has(b.key) - mine.has(a.key)) || a.label.localeCompare(b.label)).map(m => ({ key: m.key, label: m.label, period: m.period, mine: mine.has(m.key) }));
}
const DEFAULT_FILL = { total: 'sw_waitlist', active: 'sw_active' };

/**
 * The member's choices from the set-up page → config, checked against the
 * tables NoBossly listed (so a typed table name never reaches SQL) and the
 * numbers that exist. → { config } or { error }.
 */
function configFrom(conn, body, tables) {
  const b = body || {};
  const cfg = {};
  if (needsTable(conn.kind)) {
    const t = (tables || []).find(x => x.key === String(b.table || ''));
    if (!t) return { error: 'Choose the table your users are in.' };
    const col = name => t.columns.find(c => c.name === String(name || ''));
    const created = col(b.created);
    if (!created) return { error: 'Choose the column that says when each user signed up.' };
    const active = b.active ? col(b.active) : null;
    if (b.active && !active) return { error: 'That last-active column is not in the table.' };
    Object.assign(cfg, { schema: t.schema, table: t.table, created: created.name, createdEpoch: !!created.epoch },
      active ? { active: active.name, activeEpoch: !!active.epoch } : {});
  }
  const keys = new Set(fillable().map(m => m.key));
  const fill = {};
  for (const k of ['total', 'active', 'new']) {
    const v = String(b['fill_' + k] || '');
    if (v && keys.has(v)) fill[k] = v;
  }
  if (fill.active && needsTable(conn.kind) && !cfg.active) delete fill.active;
  if (fill.active && conn.kind === 'wordpress') delete fill.active;
  cfg.fill = fill;
  return { config: cfg };
}

async function saveConfig(sc, conn, config) {
  const { error } = await sc.from('data_connections').update({ config, status: 'active', last_error: null }).eq('id', conn.id).eq('user_id', conn.user_id);
  return error ? { error: 'Could not save that. Please try again.' } : { ok: true };
}

/** Count, save the day's numbers, and fill in the member's numbers. */
async function sync(sc, conn, opts = {}) {
  const now = opts.now || new Date();
  if (needsTable(conn.kind) && !(conn.config && conn.config.table)) return { error: 'Choose what to count first.' };
  const p = await parsedFor(sc, conn);
  if (p.error) return C.fail(sc, conn, p.error, now);
  const got = await KINDS[conn.kind].counts(p, conn.config || {}, Object.assign({}, opts, { now: now.getTime ? now.getTime() : now })).catch(e => ({ error: 'Counting failed: ' + String(e && e.message || e).slice(0, 120) }));
  if (got.error) return C.fail(sc, conn, got.error, now);
  const { history, today } = C.rowsOf(conn, got, now);
  const h = await sc.from('app_metrics').upsert(history, { onConflict: 'connection_id,day' });
  const t = await sc.from('app_metrics').upsert([today], { onConflict: 'connection_id,day' });
  if (h.error || t.error) return C.fail(sc, conn, 'Could not save the numbers. We will try again later.', now);
  const filled = [];
  const fill = (conn.config && conn.config.fill) || {};
  const values = { total: got.total, active: got.active30, new: Object.values(got.byDay || {}).reduce((a, b) => a + b, 0) };
  for (const k of ['total', 'active', 'new']) {
    const key = fill[k];
    if (!key || values[k] == null || !registry.metric(key)) continue;
    // "New" means this period's sign-ups: this month's, or this week's.
    let v = values[k];
    if (k === 'new') {
      const def = registry.metric(key), start = metrics.periodOf(def, '', now);
      v = Object.entries(got.byDay || {}).filter(([d]) => d >= start).reduce((a, [, n]) => a + n, 0);
    }
    if (k === 'active' && registry.metric(key).period === 'week') v = got.active7;
    if (v == null) continue;
    try { await metrics.log(sc, conn.user_id, key, '', v, 'From ' + (conn.label || 'your app') + ', counted by NoBossly', now); filled.push(key); } catch (_) { /* a number we could not log is skipped */ }
  }
  await sc.from('data_connections').update({ status: 'active', last_error: null, last_synced_at: now.toISOString() }).eq('id', conn.id);
  return { total: got.total, active7: got.active7, active30: got.active30, filled };
}

// The background pass: every set-up connection not synced in the last few hours.
async function runAll(sc, { now = new Date(), limit = 30 } = {}) {
  const cutoff = new Date(now.getTime() - EVERY_HOURS * 3600000).toISOString();
  const { data, error } = await sc.from('data_connections').select('id, user_id, kind, provider, label, config, status, last_synced_at')
    .in('status', ['active', 'error']).or('last_synced_at.is.null,last_synced_at.lt.' + cutoff).limit(limit);
  const out = { synced: 0, errors: 0 };
  if (error) return out;
  for (const c of data || []) {
    if (needsTable(c.kind) && !(c.config && c.config.table)) continue;
    const r = await sync(sc, c, { now }).catch(e => ({ error: e.message }));
    out.synced++; if (r.error) out.errors++;
  }
  return out;
}

/** What the member's page shows for one connection, from app_metrics rows (oldest first). */
function summary(rows, now = new Date()) {
  const list = (rows || []).slice().sort((a, b) => (a.day < b.day ? -1 : 1));
  const last = [...list].reverse().find(r => r.total_users != null) || null;
  const sumSince = days => { const from = C.ymd(now.getTime() - (days - 1) * 86400000); return list.filter(r => r.day >= from).reduce((a, r) => a + (r.new_users || 0), 0); };
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const end = now.getTime() - i * 7 * 86400000, from = C.ymd(end - 6 * 86400000), to = C.ymd(end);
    weeks.push({ from, to, n: list.filter(r => r.day >= from && r.day <= to).reduce((a, r) => a + (r.new_users || 0), 0) });
  }
  return {
    total: last ? last.total_users : null, active7: last ? last.active_7d : null, active30: last ? last.active_30d : null,
    new7: sumSince(7), new30: sumSince(30), weeks, max: Math.max(1, ...weeks.map(w => w.n)),
    totals: list.filter(r => r.total_users != null).map(r => ({ day: r.day, n: r.total_users })).slice(-30)
  };
}

module.exports = { PRESETS, KINDS, MAX, EVERY_HOURS, DEFAULT_FILL, connect, tablesFor, fillable, configFrom, saveConfig, sync, runAll, summary, needsTable, parsedOfSecret, secretOfParsed };
