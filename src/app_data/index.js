// App data: a member connects their own app's database and NoBossly counts
// its users each day (src/app_data/postgres|mysql|firebase|wordpress). This
// file is the flow around them: connect, choose what to count, sync, and fill
// in the member's own dashboard numbers if they ask it to.

const pg = require('./postgres');
const my = require('./mysql');
const fb = require('./firebase');
const wp = require('./wordpress');
const C = require('./common');
const sbapi = require('./supabase_api');
const ps = require('./planetscale');
const OA = require('./oauth');
const TR = require('./trackers');
const registry = require('../engines/registry');
const metrics = require('../engines/metrics');
require('../path_dashboards');   // registers every path's numbers

const EVERY_HOURS = 6;
const MAX = 3;

// Supabase does not let a project's own roles grant access to its auth
// schema, so the reader gets a view of the three columns instead, in a schema
// of its own that Supabase's API does not expose.
const SUPABASE_SQL = `do $$ begin
  create role nobossly_reader with login password 'choose-a-long-password';
exception when duplicate_object then
  alter role nobossly_reader with login password 'choose-a-long-password';
end $$;
create schema if not exists nobossly;
create or replace view nobossly.users as select id, created_at, last_sign_in_at from auth.users;
revoke all on schema nobossly from public;
grant usage on schema nobossly to nobossly_reader;
grant select on nobossly.users to nobossly_reader;`;
const POSTGRES_SQL = `do $$ begin
  create role nobossly_reader with login password 'choose-a-long-password';
exception when duplicate_object then
  alter role nobossly_reader with login password 'choose-a-long-password';
end $$;
grant usage on schema public to nobossly_reader;
grant select on public.users to nobossly_reader;   -- your users table`;
const MYSQL_SQL = `create user 'nobossly_reader'@'%' identified by 'choose-a-long-password';
grant select on your_database.users to 'nobossly_reader'@'%';   -- your users table`;

// What a member can pick on the connect page.
const PRESETS = {
  supabase: { key: 'supabase', kind: 'postgres', oauth: 'supabase', oauthNote: 'You sign in to Supabase, pick your project, then choose which tables to track. Supabase only lets apps run queries with its database read-and-write permission, so its screen says so; NoBossly only ever uses Supabase\'s read-only query, which runs as a database user that cannot change anything. No role to make, no SQL to run.', label: 'Supabase', emoji: '⚡', blurb: 'Sign-ups and sign-ins from Supabase Auth, or any table.',
    fields: [{ name: 'url', label: 'Connection string (Session pooler)', placeholder: 'postgresql://nobossly_reader.abcd…@aws-0-….pooler.supabase.com:5432/postgres', secret: true }],
    sql: SUPABASE_SQL,
    where: [
      'In your Supabase project, open the SQL Editor and run the lines below, with a password of your own (letters and numbers only, so it fits in the connection string). They make a role that can only read sign-up and sign-in times, through a view of three columns.',
      'Open Connect (top of the dashboard) → Session pooler, and copy that connection string (its host ends in pooler.supabase.com). Not Direct connection: that address only works over IPv6.',
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
  mysql: { key: 'mysql', kind: 'mysql', oauth: 'planetscale', oauthNote: 'For PlanetScale databases: you sign in and pick a database, and NoBossly makes its own read-only login there. Other MySQL databases: set it up by hand below.', label: 'MySQL / PlanetScale', emoji: '🐬', blurb: 'Any users table in MySQL, including PlanetScale.',
    fields: [{ name: 'url', label: 'Connection string', placeholder: 'mysql://nobossly_reader:…@host:3306/database', secret: true }],
    sql: MYSQL_SQL,
    where: [
      'Make a user that can only SELECT your users table (the lines below). On PlanetScale, create a password with the Read-only role instead.',
      'Paste the connection string for that user, ending in your database name.'
    ] },
  firebase: { key: 'firebase', kind: 'firebase', oauth: 'google', oauthNote: 'You sign in with Google and pick your Firebase project. Google has no read-only permission for this, so its screen asks for access to your Firebase data; NoBossly only ever lists sign-up and sign-in times. Prefer a read-only key? Set it up by hand below.', label: 'Firebase', emoji: '🔥', blurb: 'Sign-ups and sign-ins from Firebase Authentication.',
    fields: [{ name: 'key', label: 'Service account key (JSON)', placeholder: '{ "type": "service_account", … }', secret: true, area: true }],
    where: [
      'In Google Cloud console → IAM → Service accounts (same project as Firebase), create a service account named nobossly-reader.',
      'Give it only the Firebase Authentication Viewer role.',
      'Under Keys, add a JSON key, open the file and paste all of it here.'
    ] },
  wordpress: { key: 'wordpress', kind: 'wordpress', label: 'WordPress', emoji: '📝', blurb: 'New registered users on a WordPress site.',
    click: { action: '/app-data/connect/wordpress/start', field: { name: 'url', label: 'Your site address', placeholder: 'https://example.com' }, button: 'Connect with WordPress',
      note: 'You go to your own site, sign in as an administrator, and click Approve. WordPress makes a password just for NoBossly, which you can revoke from your profile at any time.' },
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
const KINDS = { postgres: pg, mysql: my, firebase: fb, wordpress: wp, supabase: sbapi };

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
const needsTable = kind => kind === 'postgres' || kind === 'mysql' || kind === 'supabase';

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

// Which sign-in a connection came from, if any.
const OAUTH_OF = { supabase: 'supabase', planetscale: 'planetscale', firebase: 'google' };

async function parsedFor(sc, conn, opts = {}) {
  const s = await C.secretOf(sc, conn);
  if (!s) return { error: 'The connection could not be read. Disconnect and connect it again.' };
  let obj = null;
  try { obj = JSON.parse(s); } catch (_) { obj = null; }
  if (obj && obj.mode === 'oauth') {
    const save = next => sc.rpc('data_connection_set_secret', { p_id: conn.id, p_secret: JSON.stringify(next) });
    const t = await OA.fresh(OAUTH_OF[conn.kind], obj, { fetchImpl: opts.fetchImpl, now: Date.now(), save });
    if (t.error) return { error: t.error === 'unreadable' ? 'The connection could not be read. Disconnect and connect it again.' : t.error };
    const project = conn.config && conn.config.project ? conn.config.project.id : null;
    return { access: t.access, project, oauth: true };
  }
  const p = parsedOfSecret(conn.kind, s);
  return p.error ? { error: 'The connection could not be read. Disconnect and connect it again.' } : p;
}

// --------------------------------------------- After a "Connect with …" sign-in
/** Store a fresh sign-in as a connection waiting for its project. → { id } or { error }. */
async function connectOAuth(sc, userId, provider, token) {
  const kind = provider === 'google' ? 'firebase' : provider;
  const label = provider === 'google' ? 'Firebase' : OA.PROVIDERS[provider].label;
  const { data, error } = await C.store(sc, { userId, kind, provider: provider === 'google' ? 'google' : kind, label, host: 'choose a project', secret: token });
  if (error) return { error: /three app databases/i.test(error.message || '') ? 'You can connect up to ' + MAX + ' app databases. Disconnect one first.' : 'save', dbError: error };
  return { id: data };
}
const needsProject = conn => (conn.kind === 'supabase' || conn.kind === 'planetscale' || conn.provider === 'google') && !(conn.config && conn.config.project);

/** The projects (or databases) a sign-in can see, for the picker. */
async function projectsFor(sc, conn, opts = {}) {
  const p = await parsedFor(sc, conn, opts);
  if (p.error) return p;
  if (!p.access) return { projects: [] };
  if (conn.kind === 'supabase') return sbapi.projects(p.access, opts);
  if (conn.kind === 'firebase') return fb.projects(p.access, opts);
  if (conn.kind === 'planetscale') return ps.projects(p.access, opts);
  return { projects: [] };
}

/**
 * The member picked a project. Supabase and Firebase remember it; PlanetScale
 * makes its read-only login there and becomes an ordinary MySQL or Postgres
 * connection. The choice must be one of the projects the sign-in listed.
 */
async function chooseProject(sc, conn, value, opts = {}) {
  const list = await projectsFor(sc, conn, opts);
  if (list.error) return list;
  const pick = (list.projects || []).find(x => x.id === String(value || ''));
  if (!pick) return { error: 'Choose one of your projects.' };
  if (conn.kind === 'planetscale') {
    const p = await parsedFor(sc, conn, opts);
    if (p.error) return p;
    const login = await ps.readerLogin(p.access, pick, opts);
    if (login.error) return login;
    const parsed = login.kind === 'postgres' ? pg.parse(login.url) : my.parse(login.url);
    if (parsed.error) return { error: 'PlanetScale gave a login NoBossly could not read. Try again.' };
    const { error } = await C.store(sc, { id: conn.id, userId: conn.user_id, kind: login.kind, provider: 'planetscale', label: 'PlanetScale · ' + pick.name, host: parsed.host, secret: login.url });
    return error ? { error: 'Could not save the connection. Please try again.' } : { ok: true };
  }
  const { error } = await sc.from('data_connections').update({ config: { project: { id: pick.id, name: pick.name } }, host_label: pick.name + (pick.note && pick.note !== pick.name ? ' · ' + pick.note : '') })
    .eq('id', conn.id).eq('user_id', conn.user_id);
  return error ? { error: 'Could not save that. Please try again.' } : { ok: true };
}

/** The tables a Postgres, MySQL or Supabase connection could count, for the set-up page. */
async function tablesFor(sc, conn, opts = {}) {
  if (!needsTable(conn.kind)) return { tables: [] };
  const p = await parsedFor(sc, conn, opts);
  if (p.error) return p;
  if (conn.kind === 'supabase' && !p.project) return { error: 'Choose a project first.' };
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
  let trackers;
  if (needsTable(conn.kind)) {
    // The round-1 form (one table) still works: it becomes one tracker.
    const form = b.t_table === undefined && b.table !== undefined
      ? { t_table: b.table, t_label: 'Users', t_created: b.created, t_active: b.active || '' } : b;
    const r = TR.fromForm(form, tables);
    if (r.error) return { error: r.error };
    trackers = r.trackers;
    cfg.trackers = trackers;
  } else {
    trackers = [{ key: 'users', label: 'Users', active: conn.kind === 'wordpress' ? null : 'built-in', created: 'built-in' }];
  }
  // Dashboard numbers to fill in: which count, from which tracker.
  const keys = new Set(fillable().map(m => m.key));
  const fill = [];
  for (const k of ['total', 'active', 'new']) {
    const metric = String(b['fill_' + k] || '');
    if (!metric || !keys.has(metric)) continue;
    const tk = String(b['fill_' + k + '_from'] || '') || (trackers.find(t => (k !== 'active' || t.active) && (k !== 'new' || t.created)) || {}).key;
    const tr = trackers.find(t => t.key === tk);
    if (!tr || (k === 'active' && !tr.active) || (k === 'new' && !tr.created)) continue;
    fill.push({ what: k, tracker: tr.key, metric });
  }
  cfg.fill = fill;
  if (conn.config && conn.config.project) cfg.project = conn.config.project;
  return { config: cfg };
}

async function saveConfig(sc, conn, config) {
  const { error } = await sc.from('data_connections').update({ config, status: 'active', last_error: null }).eq('id', conn.id).eq('user_id', conn.user_id);
  return error ? { error: 'Could not save that. Please try again.' } : { ok: true };
}

const ready = conn => !needsTable(conn.kind) || TR.trackersOf(conn.config).length > 0;

/** Count each tracker, save the day's numbers, and fill in the member's numbers. */
async function sync(sc, conn, opts = {}) {
  const now = opts.now || new Date();
  if (!ready(conn)) return { error: 'Choose what to track first.' };
  const p = await parsedFor(sc, conn, opts);
  if (p.error) return C.fail(sc, conn, p.error, now);
  const nowMs = now.getTime ? now.getTime() : now;
  let results, trackers;
  if (needsTable(conn.kind)) {
    trackers = TR.trackersOf(conn.config);
    const got = await KINDS[conn.kind].countTrackers(p, trackers, Object.assign({}, opts, { now: nowMs })).catch(e => ({ error: 'Counting failed: ' + String(e && e.message || e).slice(0, 120) }));
    if (got.error) return C.fail(sc, conn, got.error, now);
    results = got.results;
  } else {
    trackers = [{ key: 'users', label: 'Users', created: 'built-in', active: conn.kind === 'wordpress' ? null : 'built-in' }];
    const got = await KINDS[conn.kind].counts(p, conn.config || {}, Object.assign({}, opts, { now: nowMs })).catch(e => ({ error: 'Counting failed: ' + String(e && e.message || e).slice(0, 120) }));
    if (got.error) return C.fail(sc, conn, got.error, now);
    results = { users: got };
  }
  // Each tracker: 90 days of new items (if it has a date), then today with the totals.
  const history = [], today = [];
  const day0 = C.ymd(now);
  for (const tr of trackers) {
    const r = results[tr.key];
    if (!r || r.error) continue;
    if (r.byDay) for (let i = C.DAYS - 1; i >= 1; i--) {
      const d = C.ymd(nowMs - i * 86400000);
      history.push({ connection_id: conn.id, user_id: conn.user_id, tracker: tr.key, day: d, new_items: C.int(r.byDay[d]) || 0 });
    }
    today.push({ connection_id: conn.id, user_id: conn.user_id, tracker: tr.key, day: day0, total: C.int(r.total),
      new_items: r.byDay ? C.int(r.byDay[day0]) || 0 : null, active_7d: C.int(r.active7), active_30d: C.int(r.active30) });
  }
  const h = history.length ? await sc.from('app_tracker_days').upsert(history, { onConflict: 'connection_id,tracker,day' }) : {};
  const t = today.length ? await sc.from('app_tracker_days').upsert(today, { onConflict: 'connection_id,tracker,day' }) : {};
  if (h.error || t.error) return C.fail(sc, conn, 'Could not save the numbers. We will try again later.', now);
  const problems = trackers.map(tr => results[tr.key] && results[tr.key].error).filter(Boolean);

  const filled = [];
  for (const f of Array.isArray(conn.config && conn.config.fill) ? conn.config.fill : []) {
    const r = results[f.tracker], def = registry.metric(f.metric);
    if (!r || r.error || !def) continue;
    let v = f.what === 'total' ? r.total : f.what === 'active' ? (def.period === 'week' ? r.active7 : r.active30) : null;
    if (f.what === 'new' && r.byDay) { const start = metrics.periodOf(def, '', now); v = Object.entries(r.byDay).filter(([d]) => d >= start).reduce((a, [, n]) => a + n, 0); }
    if (v == null || !isFinite(v)) continue;
    try { await metrics.log(sc, conn.user_id, f.metric, '', v, 'From ' + (conn.label || 'your app') + ', counted by NoBossly', now); filled.push(f.metric); } catch (_) { /* a number we could not log is skipped */ }
  }
  await sc.from('data_connections').update({ status: problems.length === trackers.length ? 'error' : 'active', last_error: problems.length ? problems.join(' ').slice(0, 300) : null, last_synced_at: now.toISOString() }).eq('id', conn.id);
  const first = results[trackers[0].key] || {};
  return { counted: trackers.length - problems.length, problems, total: first.total, active30: first.active30, filled, error: problems.length === trackers.length ? problems[0] : null };
}

// The background pass: every set-up connection not synced in the last few hours.
async function runAll(sc, { now = new Date(), limit = 30 } = {}) {
  const cutoff = new Date(now.getTime() - EVERY_HOURS * 3600000).toISOString();
  const { data, error } = await sc.from('data_connections').select('id, user_id, kind, provider, label, config, status, last_synced_at')
    .in('status', ['active', 'error']).or('last_synced_at.is.null,last_synced_at.lt.' + cutoff).limit(limit);
  const out = { synced: 0, errors: 0 };
  if (error) return out;
  for (const c of data || []) {
    if (c.kind === 'planetscale' || !ready(c)) continue;
    const r = await sync(sc, c, { now }).catch(e => ({ error: e.message }));
    out.synced++; if (r.error) out.errors++;
  }
  return out;
}

/** What the page shows for one tracker, from its app_tracker_days rows. */
function summary(rows, now = new Date()) {
  const list = (rows || []).slice().sort((a, b) => (a.day < b.day ? -1 : 1));
  const last = [...list].reverse().find(r => r.total != null) || null;
  const hasNew = list.some(r => r.new_items != null);
  const sumSince = days => { const from = C.ymd(now.getTime() - (days - 1) * 86400000); return list.filter(r => r.day >= from).reduce((a, r) => a + (r.new_items || 0), 0); };
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const end = now.getTime() - i * 7 * 86400000, from = C.ymd(end - 6 * 86400000), to = C.ymd(end);
    weeks.push({ from, to, n: list.filter(r => r.day >= from && r.day <= to).reduce((a, r) => a + (r.new_items || 0), 0) });
  }
  return {
    total: last ? Number(last.total) : null, active7: last ? last.active_7d : null, active30: last ? last.active_30d : null,
    hasNew, new7: hasNew ? sumSince(7) : null, new30: hasNew ? sumSince(30) : null, weeks, max: Math.max(1, ...weeks.map(w => w.n))
  };
}

module.exports = { TR, ready, PRESETS, KINDS, MAX, EVERY_HOURS, DEFAULT_FILL, OAUTH_OF, connectOAuth, needsProject, projectsFor, chooseProject, connect, tablesFor, fillable, configFrom, saveConfig, sync, runAll, summary, needsTable, parsedOfSecret, secretOfParsed };
