// App data (src/app_data, src/routes/app_data.js): a member connects their own
// app's database (Supabase, Neon or any Postgres, MySQL/PlanetScale, Firebase,
// WordPress) and NoBossly counts its users: total, new each day, active. Only
// read-only logins, only public addresses, only counts. Every outside call is
// a fake here; the Postgres SQL was also run against a real Postgres.
//
//   node test/app_data.js        (APPDATA_OUT=dir also writes the pages as HTML)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ejs = require('ejs');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const { FLAGS } = require('../src/features');
const safety = require('../src/app_data/safety');
const pg = require('../src/app_data/postgres');
const my = require('../src/app_data/mysql');
const fb = require('../src/app_data/firebase');
const wp = require('../src/app_data/wordpress');
const C = require('../src/app_data/common');
const AD = require('../src/app_data');

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find(k => url.startsWith(k));
    if (!key) return { status: 404, headers: { get: () => null }, json: async () => ({}) };
    const [status, body, headers = {}] = await routes[key](url, opts);
    return { status, headers: { get: h => headers[h.toLowerCase()] ?? null }, json: async () => body };
  };
  f.calls = calls;
  return f;
}
function fakeSb(answers = {}, rpcs = {}) {
  const writes = [], calls = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, eq: {}, in: {}, single: false };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          let out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          if (state.single && out && Array.isArray(out.data)) out = Object.assign({}, out, { data: out.data[0] || null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (k === 'maybeSingle') return () => { state.single = true; return chain; };
        if (['eq', 'in', 'lt', 'gte', 'is', 'neq'].includes(k)) return (c, v) => { (state[k] = state[k] || {})[c] = v; return chain; };
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p, o) => { state.op = k; state.payload = p; writes.push({ table, op: k, payload: p, opts: o, state }); return chain; };
        return () => chain;
      }
    });
    return chain;
  };
  return { from: q, writes, calls, rpc: (n, a) => { calls.push({ name: n, args: a }); const r = rpcs[n]; return Promise.resolve(typeof r === 'function' ? r(a) : (r || { data: null, error: null })); } };
}
const now = new Date('2026-11-18T15:00:00Z');
const lookupAs = (...addrs) => async () => addrs.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));

(async () => {
  console.log('Only public addresses:');
  ok('private, loopback, link-local and metadata addresses are private', ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.5', '100.64.0.1', '0.0.0.0', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1'].every(safety.isPrivate));
  ok('...public ones are not', ['8.8.8.8', '34.120.1.2', '2606:4700::1111'].every(ip => !safety.isPrivate(ip)));
  ok('a host that resolves to a private address is refused', /private network/.test((await safety.resolvePublic('db.example.com', { lookup: lookupAs('34.1.1.1', '10.0.0.5') })).error));
  {
    const refused = [];
    for (const h of ['127.0.0.1', '8.8.8.8', 'localhost', 'db.internal', 'x']) if ((await safety.resolvePublic(h, { lookup: lookupAs('8.8.8.8') })).error) refused.push(h);
    ok('...so is a bare IP, localhost or an internal name', refused.length === 5, refused.join());
  }
  const r = await safety.resolvePublic('DB.Example.com', { lookup: lookupAs('2606:4700::1', '34.1.1.1') });
  ok('a public host connects to the address that was checked (IPv4 first)', r.address === '34.1.1.1' && r.host === 'db.example.com');

  console.log('\nPostgres (Supabase, Neon, any):');
  const sp = pg.parse('postgresql://nobossly_reader.abcd:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
  ok('a connection string is read, password decoded, host named', sp.user === 'nobossly_reader.abcd' && sp.password === 'p@ss' && sp.provider === 'supabase' && sp.port === 5432);
  ok('Neon, Railway and others are named; anything else is Postgres', pg.parse('postgres://a:b@ep-x.us-east-2.aws.neon.tech/neondb').provider === 'neon' && pg.parse('postgresql://a:b@db.example.com/x').provider === 'postgres');
  ok('a string without a password, or not Postgres, is refused', !!pg.parse('postgresql://a@h/db').error && !!pg.parse('mysql://a:b@h/db').error && !!pg.parse('nonsense').error);
  ok('a password with a stray % gives a plain reason, not a crash', /letters and numbers/.test(pg.parse('postgresql://a:50%off@h.example.com/db').error || '') && /letters and numbers/.test(my.parse('mysql://a:50%off@h.example.com/db').error || ''));
  ok('identifiers are quoted, quotes doubled', pg.q('us"ers') === '"us""ers"');
  ok('a role that can write to any table is refused; superusers too', /has_table_privilege\(c\.oid, 'INSERT'\)/.test(pg.WRITABLE) && /rolsuper/.test(read('src/app_data/postgres.js')));
  ok('every query runs in a read-only transaction with a time limit', /begin transaction read only/.test(read('src/app_data/postgres.js')) && /statement_timeout/.test(read('src/app_data/postgres.js')));
  {
    // A fake pg client: answers by query text.
    const seen = [];
    class FakeClient {
      constructor(o) { this.o = o; }
      async connect() { seen.push(['connect', this.o.host, this.o.ssl && this.o.ssl.servername]); }
      async end() {}
      async query(sql, params) {
        seen.push(['q', sql.trim().slice(0, 40), params]);
        if (/rolsuper/.test(sql)) return { rows: [{ rolsuper: false }] };
        if (/has_table_privilege\(c\.oid/.test(sql)) return { rows: [] };
        if (/from information_schema\.columns where table_schema = \$1/.test(sql)) return { rows: params[2].map(c => ({ column_name: c })) };
        if (/count\(\*\)::bigint as n, count/.test(sql)) return { rows: [{ n: '200', a7: '24', a30: '67' }] };
        if (/to_char\(date_trunc/.test(sql)) return { rows: [{ d: '2026-11-18', n: '3' }, { d: '2026-11-17', n: '5' }] };
        return { rows: [] };
      }
    }
    const opts = { ClientImpl: FakeClient, lookup: lookupAs('34.1.1.1') };
    ok('a read-only role connects, to the checked address, with the host name for TLS', (await pg.verify(sp, opts)).ok && seen[0][1] === '34.1.1.1' && seen[0][2] === sp.host);
    const c = await pg.counts(sp, pg.SUGGEST, opts);
    ok('counts: users, active in 7 and 30 days, new per day', c.total === 200 && c.active7 === 24 && c.active30 === 67 && c.byDay['2026-11-17'] === 5);
    ok('...the columns are checked against the catalogue before any count', seen.findIndex(x => /information_schema/.test(x[1])) < seen.findIndex(x => /count/.test(x[1])));
  }
  ok('a private host never gets as far as connecting', /private network/.test((await pg.verify(sp, { lookup: lookupAs('10.0.0.9'), ClientImpl: class { connect() { throw new Error('should not connect'); } } })).error));

  console.log('\nMySQL / PlanetScale:');
  ok('a connection string needs a database name', !!my.parse('mysql://a:b@host').error && my.parse('mysql://ro:pw@aws.connect.psdb.cloud/app').provider === 'planetscale');
  ok('SELECT-only grants pass', !my.writeGrants(['GRANT USAGE ON *.* TO `ro`@`%`', 'GRANT SELECT ON `app`.* TO `ro`@`%`']).length);
  ok('INSERT, ALL PRIVILEGES and the like are refused', my.writeGrants(['GRANT SELECT, INSERT ON `app`.* TO `rw`@`%`']).length === 1 && my.writeGrants(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`']).length === 1);
  ok('identifiers are quoted, backticks doubled; a read-only transaction', my.q('a`b') === '`a``b`' && /START TRANSACTION READ ONLY/.test(read('src/app_data/mysql.js')));

  console.log('\nFirebase:');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const keyFile = JSON.stringify({ type: 'service_account', project_id: 'my-app-123', private_key_id: 'k1', private_key: privateKey, client_email: 'nobossly-reader@my-app-123.iam.gserviceaccount.com' });
  const fp = fb.parse(keyFile);
  ok('a service account key is read; anything else is refused', fp.project === 'my-app-123' && !!fb.parse('{"type":"authorized_user"}').error && !!fb.parse('not json').error);
  const jwt = fb.assertion(fp, now.getTime()).split('.');
  ok('the token request is signed with the key, for a short time', crypto.createVerify('RSA-SHA256').update(jwt[0] + '.' + jwt[1]).verify(publicKey, Buffer.from(jwt[2], 'base64url')) && JSON.parse(Buffer.from(jwt[1], 'base64url')).exp - JSON.parse(Buffer.from(jwt[1], 'base64url')).iat === 600);
  const users = [
    { localId: 'a', createdAt: String(now.getTime() - 2 * 86400000), lastLoginAt: String(now.getTime() - 86400000) },
    { localId: 'b', createdAt: String(now.getTime() - 200 * 86400000), lastLoginAt: String(now.getTime() - 20 * 86400000) },
    { localId: 'c', createdAt: String(now.getTime() - 400 * 86400000) }
  ];
  const fbFetch = (perms = []) => fakeFetch({
    'https://oauth2.googleapis.com/token': () => [200, { access_token: 'gtok' }],
    'https://cloudresourcemanager.googleapis.com/': () => [200, { permissions: perms }],
    'https://identitytoolkit.googleapis.com/': (u) => [200, /nextPageToken=p2/.test(u) ? { users: [users[2]] } : /maxResults=1$/.test(u) ? { users: [users[0]] } : { users: users.slice(0, 2), nextPageToken: 'p2' }]
  });
  ok('a viewer key passes', (await fb.verify(fp, { fetchImpl: fbFetch(), now: now.getTime() })).ok);
  ok('a key that can change or delete users is refused', /change or delete users/.test((await fb.verify(fp, { fetchImpl: fbFetch(['firebaseauth.users.update']), now: now.getTime() })).error));
  const fc = await fb.counts(fp, {}, { fetchImpl: fbFetch(), now: now.getTime() });
  ok('users are counted page by page: total, active, new per day', fc.total === 3 && fc.active7 === 1 && fc.active30 === 2 && fc.byDay['2026-11-16'] === 1 && Object.keys(fc.byDay).length === 1);

  console.log('\nWordPress:');
  const wpIn = wp.parse({ url: 'example.com/wp-admin/', user: 'ana', password: 'abcd EFGH 1234 ijkl MNOP 5678' });
  ok('the site address is tidied; https is required; only an application password', wpIn.url === 'https://example.com' && !!wp.parse({ url: 'http://example.com', user: 'a', password: 'abcd EFGH 1234 ijkl MNOP 5678' }).error && !!wp.parse({ url: 'example.com', user: 'a', password: 'my login password' }).error);
  const wpFetch = fakeFetch({ 'https://example.com/wp-json/wp/v2/users': (u, o) => {
    if (o.redirect !== 'manual') return [500, {}];
    if (o.headers.Authorization !== 'Basic ' + Buffer.from('ana:abcd EFGH 1234 ijkl MNOP 5678').toString('base64')) return [401, { code: 'incorrect_password' }];
    return [200, /page=1$/.test(u) || /per_page=1&/.test(u) ? [{ id: 9, registered_date: '2026-11-17T10:00:00' }, { id: 8, registered_date: '2026-11-17T08:00:00' }, { id: 7, registered_date: '2026-01-01T00:00:00' }] : [], { 'x-wp-total': '312' }];
  } });
  const wopts = { fetchImpl: wpFetch, lookup: lookupAs('34.1.1.1'), now: now.getTime() };
  ok('an application password that works passes; redirects are not followed', (await wp.verify(wpIn, wopts)).ok);
  ok('a wrong one says so', /did not accept/.test((await wp.verify(Object.assign({}, wpIn, { password: 'zzzz zzzz zzzz zzzz zzzz zzzz' }), wopts)).error));
  const wc = await wp.counts(wpIn, {}, wopts);
  ok('registrations are counted until they are older than 90 days; no active numbers', wc.total === 312 && wc.byDay['2026-11-17'] === 2 && wc.active7 === null);
  ok('a site on a private address is refused', /private network/.test((await wp.verify(wpIn, Object.assign({}, wopts, { lookup: lookupAs('192.168.0.10') }))).error));

  console.log('\nConnecting and choosing what to count:');
  {
    const stored = [];
    const sc = fakeSb({}, { data_connection_store: a => { stored.push(a); return { data: '00000000-0000-0000-0000-0000000000c1', error: null }; } });
    const bad = await AD.connect(sc, 'me', 'supabase', { url: 'postgresql://a@h/db' });
    ok('a bad paste is refused before anything is stored', !!bad.error && !stored.length);
    const good = await AD.connect(sc, 'me', 'firebase', { key: keyFile }, { fetchImpl: fbFetch(), now: now.getTime() });
    ok('a good one is checked, then stored by the server', good.id === '00000000-0000-0000-0000-0000000000c1' && stored[0].p_kind === 'firebase' && stored[0].p_host === 'my-app-123 (Firebase)' && JSON.parse(stored[0].p_secret).private_key === privateKey);
    const full = await AD.connect(fakeSb({}, { data_connection_store: { data: null, error: { message: 'three app databases at most' } } }), 'me', 'firebase', { key: keyFile }, { fetchImpl: fbFetch(), now: now.getTime() });
    ok('...three at most', /up to 3/.test(full.error));
    ok('secrets round-trip for each kind', AD.parsedOfSecret('postgres', AD.secretOfParsed('postgres', sp)).host === sp.host && AD.parsedOfSecret('firebase', AD.secretOfParsed('firebase', fp)).email === fp.email && AD.parsedOfSecret('wordpress', AD.secretOfParsed('wordpress', wpIn)).user === 'ana');
  }
  const tables = [{ schema: 'auth', table: 'users', key: 'auth.users', columns: [{ name: 'created_at', epoch: false }, { name: 'last_sign_in_at', epoch: false }] }, { schema: 'public', table: 'waitlist', key: 'public.waitlist', columns: [{ name: 'joined', epoch: true }] }];
  const pgConn = { id: 'c1', user_id: 'me', kind: 'postgres' };
  const cfg = AD.configFrom(pgConn, { table: 'auth.users', created: 'created_at', active: 'last_sign_in_at', fill_total: 'sw_waitlist', fill_active: 'sw_active', fill_new: 'not_a_metric' }, tables);
  ok('a table and columns from the list are taken; numbers to fill are checked', !cfg.error && cfg.config.table === 'users' && cfg.config.active === 'last_sign_in_at' && cfg.config.fill.total === 'sw_waitlist' && cfg.config.fill.active === 'sw_active' && !cfg.config.fill.new);
  ok('a table that was not listed is refused (no typed SQL)', !!AD.configFrom(pgConn, { table: 'auth.users; drop table x', created: 'created_at' }, tables).error && !!AD.configFrom(pgConn, { table: 'auth.users', created: 'email' }, tables).error);
  ok('epoch columns are remembered as such', AD.configFrom(pgConn, { table: 'public.waitlist', created: 'joined' }, tables).config.createdEpoch === true);
  ok('without a last-active column, active users are not filled in', !AD.configFrom(pgConn, { table: 'auth.users', created: 'created_at', fill_active: 'sw_active' }, tables).config.fill.active);
  ok('WordPress never fills active users; Firebase needs no table', !AD.configFrom({ kind: 'wordpress' }, { fill_active: 'sw_active', fill_total: 'sw_waitlist' }).config.fill.active && !AD.configFrom({ kind: 'firebase' }, { fill_active: 'sw_active' }).error);
  ok('the numbers on offer are counts, the member\'s path first', AD.fillable(['sw_active']).every(m => m.key) && AD.fillable(['sw_active'])[0].key === 'sw_active' && !AD.fillable().some(m => m.key === 'sw_mrr'));

  console.log('\nCounting:');
  {
    const sc = fakeSb({ metric_entries: s => ({ data: s.op === 'upsert' ? [Object.assign({ id: 'm1' }, s.payload)] : [], error: null }) },
      { data_connection_secret: { data: AD.secretOfParsed('firebase', fp), error: null } });
    const conn = { id: 'c1', user_id: 'me', kind: 'firebase', label: 'Firebase', config: { fill: { total: 'sw_waitlist', active: 'sw_active', new: 'sw_paying' } } };
    const r = await AD.sync(sc, conn, { fetchImpl: fbFetch(), now });
    const ups = sc.writes.filter(w => w.table === 'app_metrics');
    ok('90 days of new users, then today with the totals, saved separately', ups.length === 2 && ups[0].payload.length === 89 && !('total_users' in ups[0].payload[0]) && ups[1].payload[0].day === '2026-11-18' && ups[1].payload[0].total_users === 3 && ups[1].payload[0].active_30d === 2);
    const me = sc.writes.filter(w => w.table === 'metric_entries');
    ok('the chosen dashboard numbers are logged for this month, saying where they came from', r.filled.length === 3 && me.find(w => w.payload.metric === 'sw_waitlist').payload.value === 3 && me.find(w => w.payload.metric === 'sw_active').payload.value === 2 && me[0].payload.period === '2026-11-01' && /counted by NoBossly/.test(me[0].payload.note));
    ok('..."new" counts only this month\'s sign-ups', me.find(w => w.payload.metric === 'sw_paying').payload.value === 1);
    ok('the connection is marked counted', sc.writes.some(w => w.table === 'data_connections' && w.payload.status === 'active' && w.payload.last_synced_at));
    const sc2 = fakeSb({}, { data_connection_secret: { data: AD.secretOfParsed('firebase', fp), error: null } });
    const r2 = await AD.sync(sc2, conn, { fetchImpl: fakeFetch({ 'https://oauth2.googleapis.com/token': () => [400, {}] }), now });
    ok('a refused key marks the connection as needing attention', /did not accept that key/.test(r2.error) && sc2.writes.some(w => w.table === 'data_connections' && w.payload.status === 'error'));
    ok('a table connection that was never set up is not counted', /Choose what to count/.test((await AD.sync(fakeSb(), { id: 'c2', kind: 'postgres', config: null })).error));
  }
  const rows = [];
  for (let i = 0; i < 90; i++) rows.push({ day: C.ymd(now.getTime() - i * 86400000), new_users: i < 7 ? 2 : 1, total_users: i === 0 ? 500 : i === 3 ? 480 : null, active_7d: i === 0 ? 40 : null, active_30d: i === 0 ? 120 : null });
  const s = AD.summary(rows, now);
  ok('the page summary: latest totals, new this week and month, 12 weekly bars', s.total === 500 && s.active30 === 120 && s.new7 === 14 && s.new30 === 37 && s.weeks.length === 12 && s.weeks[11].n === 14 && s.max === 14);
  ok('the background pass counts set-up connections every few hours', /appData\.runAll/.test(read('server.js')) && AD.EVERY_HOURS === 6);

  console.log('\nPages:');
  const base = { title: 'App', user: { id: 'me' }, profile: { id: 'me', username: 'ana', path: 'software' }, plan: 'free', currentPath: '/app-data', canonicalUrl: '', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
  const render = (v, d) => { try { return ejs.render(read('views/' + v), Object.assign({}, base, d), { filename: path.join(ROOT, 'views', v) }); } catch (e) { return 'ERR ' + e.message; } };
  const list = [
    { id: 'c1', kind: 'postgres', provider: 'supabase', label: 'Supabase', host_label: 'aws-0-us-east-1.pooler.supabase.com', config: { schema: 'auth', table: 'users', created: 'created_at', active: 'last_sign_in_at', fill: { active: 'sw_active' } }, status: 'active', last_synced_at: '2026-11-18T12:00:00Z' },
    { id: 'c2', kind: 'wordpress', provider: 'wordpress', label: 'WordPress', host_label: 'example.com', config: { fill: {} }, status: 'error', last_error: 'WordPress did not accept that username and application password.', last_synced_at: '2026-11-18T12:00:00Z' }
  ];
  const sums = { c1: s, c2: AD.summary(rows.map(r => Object.assign({}, r, { active_7d: null, active_30d: null })), now) };
  const page = render('app_data.ejs', { list, sums, ready: true, presets: Object.values(AD.PRESETS), max: 3, canSync: true, everyHours: 6 });
  ok('the page shows each app: users, new, active, and a weekly chart', !page.startsWith('ERR') && page.includes('500') && page.includes('New this week') && (page.match(/class="ad-bar"/g) || []).length === 24, page.startsWith('ERR') ? page.slice(0, 300) : undefined);
  ok('...WordPress says it has no sign-ins; an error is shown', page.includes('WordPress does not record sign-ins') && page.includes('did not accept that username'));
  ok('...and offers another, with every kind of database', ['supabase', 'neon', 'postgres', 'mysql', 'firebase', 'wordpress'].every(k => page.includes('href="/app-data/connect/' + k + '"')));
  ok('before the migration it says "being switched on"', render('app_data.ejs', { list: [], sums: {}, ready: false, presets: Object.values(AD.PRESETS), max: 3, canSync: true, everyHours: 6 }).includes('Being set up'));
  const cp = render('app_data_connect.ejs', { preset: AD.PRESETS.supabase, ready: true, full: false, max: 3 });
  ok('the Supabase page shows the read-only role to make and the pooler string', !cp.startsWith('ERR') && cp.includes('create or replace view nobossly.users as select id, created_at, last_sign_in_at from auth.users;') && cp.includes('grant select on nobossly.users to nobossly_reader;') && !cp.includes('grant usage on schema auth') && cp.includes('Session pooler') && /name="url" type="password"/.test(cp), cp.startsWith('ERR') ? cp.slice(0, 300) : undefined);
  ok('Firebase asks for the key file in a text box', /<textarea name="key"/.test(render('app_data_connect.ejs', { preset: AD.PRESETS.firebase, ready: true, full: false, max: 3 })));
  const su = render('app_data_setup.ejs', { conn: { id: 'c1', kind: 'postgres', label: 'Supabase', host_label: 'h', status: 'setup', config: null }, tables, tablesError: null, needsTable: true, fillable: AD.fillable(['sw_active', 'sw_waitlist']), defaults: AD.DEFAULT_FILL });
  ok('set-up lists the readable tables and guesses the columns', !su.startsWith('ERR') && su.includes('<option value="auth.users"') && /value="created_at" selected/.test(su) && /value="last_sign_in_at" selected/.test(su), su.startsWith('ERR') ? su.slice(0, 300) : undefined);
  ok('...and suggests filling in Active users and Waitlist sign-ups', /name="fill_active"[\s\S]*?value="sw_active" selected/.test(su) && /name="fill_total"[\s\S]*?value="sw_waitlist" selected/.test(su));
  ok('workspace and the Active users page link here', read('views/workspace/index.ejs').includes('href="/app-data"') && read('views/workspace/metric.ejs').includes('href="/app-data"'));
  ok('routes are behind sign-in; secrets stored by the server only', /app\.use\('\/app-data', requireAuth/.test(read('server.js')) && /data_connection_store/.test(read('src/app_data/common.js')) && !/data_connection_secret/.test(read('src/routes/app_data.js')));
  ok('the migration is marked applied, and its tables are in the live snapshot', /^-- Applied live/.test(read('migrations/2026-11-18_app_data.sql')) && !require('./schema-pending.json').migrations['2026-11-18_app_data.sql'] && require('./schema-snapshot.json').columns.app_metrics.includes('active_30d'));

  if (process.env.APPDATA_OUT) {
    const fix = h => h.replace(/href="\/css\/([a-z]+)\.css\?v=\d+"/g, (m, n) => 'href="' + path.join(ROOT, 'public/css/' + n + '.css') + '"');
    fs.writeFileSync(path.join(process.env.APPDATA_OUT, 'page.html'), fix(page));
    fs.writeFileSync(path.join(process.env.APPDATA_OUT, 'connect.html'), fix(cp));
    fs.writeFileSync(path.join(process.env.APPDATA_OUT, 'setup.html'), fix(su));
  }
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
