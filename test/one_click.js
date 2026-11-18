// One-click connections: "Connect with …" sign-ins instead of pasting keys,
// for Supabase, Google (Firebase), PlanetScale and WordPress (app data), and
// Shopify, Stripe and Admitad (money). Each shows "Coming soon" until its
// keys are set; pasting stays as the fallback. Every outside call is a fake.
//
//   node test/one_click.js

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

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find(k => url.startsWith(k));
    if (!key) return { status: 404, headers: { get: () => null }, json: async () => ({}) };
    const [status, body] = await routes[key](url, opts);
    return { status, headers: { get: () => null }, json: async () => body };
  };
  f.calls = calls;
  return f;
}
function fakeSb(answers = {}, rpcs = {}) {
  const writes = [], calls = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, eq: {} };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') { const a = answers[table]; const out = typeof a === 'function' ? a(state) : (a || { data: [], error: null }); return (res, rej) => Promise.resolve(out).then(res, rej); }
        if (['eq', 'in', 'lt', 'gte', 'is', 'neq'].includes(k)) return (c, v) => { state.eq[c] = v; return chain; };
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p) => { state.op = k; state.payload = p; writes.push({ table, op: k, payload: p, state }); return chain; };
        return () => chain;
      }
    });
    return chain;
  };
  return { from: q, writes, calls, rpc: (n, a) => { calls.push({ name: n, args: a }); const r = rpcs[n]; return Promise.resolve(typeof r === 'function' ? r(a) : (r || { data: null, error: null })); } };
}
const form = s => Object.fromEntries(new URLSearchParams(s));

(async () => {
  const OA = require('../src/app_data/oauth');
  const AD = require('../src/app_data');
  const sbapi = require('../src/app_data/supabase_api');
  const ps = require('../src/app_data/planetscale');

  console.log('Until NoBossly is registered, nothing pretends to work:');
  for (const k of Object.keys(OA.PROVIDERS)) for (const e of OA.PROVIDERS[k].env) delete process.env[e];
  ok('Supabase, Google and PlanetScale are not set up', !OA.configured('supabase') && !OA.configured('google') && !OA.configured('planetscale'));
  ok('...nor Shopify, Stripe or Admitad', !require('../src/connections/shopify').configured() && !require('../src/connections/stripe_app').configured() && !require('../src/connections/affiliates/admitad').configured());

  process.env.SUPABASE_OAUTH_CLIENT_ID = 'sb-client'; process.env.SUPABASE_OAUTH_CLIENT_SECRET = 'sb-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'g-client'; process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'g-secret';
  process.env.PLANETSCALE_OAUTH_CLIENT_ID = 'ps-client'; process.env.PLANETSCALE_OAUTH_CLIENT_SECRET = 'ps-secret';

  console.log('\nSigning in (Supabase, Google, PlanetScale):');
  const s = OA.start('supabase');
  const su = new URL(s.url);
  ok('Supabase: the right page, our redirect, a state and PKCE', su.origin + su.pathname === 'https://api.supabase.com/v1/oauth/authorize' && su.searchParams.get('redirect_uri') === 'https://nobossly.com/app-data/oauth/supabase/callback' && su.searchParams.get('state') === s.state && s.state.startsWith('supabase.') && su.searchParams.get('code_challenge') === crypto.createHash('sha256').update(s.verifier).digest('base64url') && su.searchParams.get('code_challenge_method') === 'S256');
  const g = new URL(OA.start('google').url);
  ok('Google: offline access, only the Firebase scope', g.searchParams.get('access_type') === 'offline' && g.searchParams.get('scope') === 'https://www.googleapis.com/auth/firebase');
  ok('PlanetScale: its own sign-in page', OA.start('planetscale').url.startsWith('https://auth.planetscale.com/oauth/authorize?'));
  {
    const f = fakeFetch({ 'https://api.supabase.com/v1/oauth/token': (u, o) => [201, { access_token: 'sbat', refresh_token: 'sbrt', expires_in: 3600, scope: 'projects:read database:read' }] });
    const t = await OA.exchange('supabase', 'code1', 'verif', { fetchImpl: f, now: 1000 });
    const b = form(f.calls[0].opts.body);
    ok('the code is exchanged with the client secret in Basic auth and the PKCE verifier', t.token.access_token === 'sbat' && t.token.refresh_token === 'sbrt' && f.calls[0].opts.headers.Authorization === 'Basic ' + Buffer.from('sb-client:sb-secret').toString('base64') && b.code_verifier === 'verif' && !b.client_secret);
    const f2 = fakeFetch({ 'https://oauth2.googleapis.com/token': () => [200, { access_token: 'gat', refresh_token: 'grt', expires_in: 3599 }] });
    await OA.exchange('google', 'c', 'v', { fetchImpl: f2 });
    ok('Google gets the secret in the body', form(f2.calls[0].opts.body).client_secret === 'g-secret');
    ok('a refused exchange says so', /did not let NoBossly in/.test((await OA.exchange('supabase', 'x', 'v', { fetchImpl: fakeFetch({ 'https://api.supabase.com/': () => [400, {}] }) })).error));
    const saved = [];
    const r = await OA.fresh('supabase', { mode: 'oauth', access_token: 'old', refresh_token: 'rt1', expires_at: 500 }, { now: 1000, fetchImpl: fakeFetch({ 'https://api.supabase.com/v1/oauth/token': () => [201, { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }] }), save: x => saved.push(x) });
    ok('a run-out token is refreshed and the rotated refresh token saved', r.access === 'new' && saved[0].refresh_token === 'rt2');
    ok('a live token is used as it is', (await OA.fresh('supabase', { mode: 'oauth', access_token: 'live', expires_at: 5000 }, { now: 1000 })).access === 'live');
  }

  console.log('\nSupabase, read-only through Supabase:');
  {
    const f = fakeFetch({
      'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query/read-only': (u, o) => {
        const q = JSON.parse(o.body).query;
        if (/information_schema\.columns\s+where table_schema not in/.test(q)) return [201, [{ s: 'auth', t: 'users', c: 'created_at', d: 'timestamp with time zone' }, { s: 'auth', t: 'users', c: 'last_sign_in_at', d: 'timestamp with time zone' }, { s: 'auth', t: 'sessions', c: 'created_at', d: 'timestamp with time zone' }, { s: 'public', t: 'profiles', c: 'created_at', d: 'timestamp with time zone' }]];
        if (/where table_schema = 'auth' and table_name = 'users'/.test(q)) return [201, [{ c: 'created_at' }, { c: 'last_sign_in_at' }]];
        if (/count\(\*\)::bigint as n, count/.test(q)) return [201, [{ n: 340, a7: 51, a30: 140 }]];
        if (/to_char/.test(q)) return [201, [{ d: '2026-11-17', n: 4 }]];
        return [400, { message: 'unexpected' }];
      },
      'https://api.supabase.com/v1/projects': () => [200, [{ ref: 'abcdefghijklmnopqrst', name: 'Job Board', region: 'us-east-1' }, { ref: 'BAD REF', name: 'x' }]]
    });
    const pr = await sbapi.projects('tok', { fetchImpl: f });
    ok('projects are listed by ref and name', pr.projects.length === 1 && pr.projects[0].id === 'abcdefghijklmnopqrst' && pr.projects[0].name === 'Job Board');
    const p = { access: 'tok', project: 'abcdefghijklmnopqrst' };
    const t = await sbapi.tables(p, { fetchImpl: f });
    ok('tables: auth.users first; other auth tables and system schemas left out', t.tables[0].key === 'auth.users' && !t.tables.some(x => x.key === 'auth.sessions') && t.tables.some(x => x.key === 'public.profiles'));
    const c = await sbapi.counts(p, sbapi.SUGGEST, { fetchImpl: f });
    ok('counts come through the read-only endpoint', c.total === 340 && c.active30 === 140 && c.byDay['2026-11-17'] === 4 && f.calls.filter(x => /query\/read-only/.test(x.url)).length >= 3 && !f.calls.some(x => /\/database\/query$/.test(x.url)));
    const seen = [];
    await sbapi.counts(p, { schema: "x'; drop table y; --", table: 'users', created: 'created_at' }, { fetchImpl: fakeFetch({ 'https://api.supabase.com/': (u, o) => { seen.push(JSON.parse(o.body).query); return [201, []]; } }) });
    ok('a strange name is escaped in the catalogue check and goes no further', seen.length === 1 && seen[0].includes("table_schema = 'x''; drop table y; --'"));
  }

  console.log('\nAfter a sign-in, choosing the project:');
  {
    const stored = [];
    const sc = fakeSb({}, { data_connection_store: a => { stored.push(a); return { data: '00000000-0000-0000-0000-0000000000d1', error: null }; } });
    const r = await AD.connectOAuth(sc, 'me', 'google', { mode: 'oauth', access_token: 'gat', refresh_token: 'grt', expires_at: Date.now() + 3600e3 });
    ok('a Google sign-in is stored as a Firebase connection waiting for its project', r.id && stored[0].p_kind === 'firebase' && stored[0].p_provider === 'google' && JSON.parse(stored[0].p_secret).refresh_token === 'grt');
    ok('...and the set-up page asks for the project first', AD.needsProject({ kind: 'firebase', provider: 'google', config: null }) && !AD.needsProject({ kind: 'firebase', provider: 'firebase', config: null }) && !AD.needsProject({ kind: 'supabase', config: { project: { id: 'x' } } }));
    const secret = JSON.stringify({ mode: 'oauth', access_token: 'sbat', expires_at: Date.now() + 3600e3 });
    const conn = { id: 'c1', user_id: 'me', kind: 'supabase', provider: 'supabase', config: null };
    const sc2 = fakeSb({}, { data_connection_secret: { data: secret, error: null } });
    const f = fakeFetch({ 'https://api.supabase.com/v1/projects': () => [200, [{ ref: 'abcdefghijklmnopqrst', name: 'Job Board', region: 'us-east-1' }]] });
    ok('a project that was not listed is refused', /Choose one of your projects/.test((await AD.chooseProject(sc2, conn, 'someoneelsesprojectx', { fetchImpl: f })).error));
    await AD.chooseProject(sc2, conn, 'abcdefghijklmnopqrst', { fetchImpl: f });
    const up = sc2.writes.find(w => w.table === 'data_connections');
    ok('a listed one is remembered, on the member\'s own connection', up.payload.config.project.id === 'abcdefghijklmnopqrst' && up.state.eq.user_id === 'me' && up.payload.host_label === 'Job Board · us-east-1');
    const cfg = AD.configFrom(Object.assign({}, conn, { config: { project: { id: 'abcdefghijklmnopqrst' } } }), { table: 'auth.users', created: 'created_at', active: 'last_sign_in_at' }, [{ schema: 'auth', table: 'users', key: 'auth.users', columns: [{ name: 'created_at' }, { name: 'last_sign_in_at' }] }]);
    ok('choosing the table keeps the project', cfg.config.project.id === 'abcdefghijklmnopqrst' && cfg.config.table === 'users');
    const sc3 = fakeSb({}, { data_connection_secret: { data: JSON.stringify({ mode: 'oauth', access_token: 'old', refresh_token: 'rt1', expires_at: 1 }), error: null } });
    const f3 = fakeFetch({ 'https://api.supabase.com/v1/oauth/token': () => [201, { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 }], 'https://api.supabase.com/v1/projects': () => [200, []] });
    await AD.projectsFor(sc3, conn, { fetchImpl: f3 });
    ok('a run-out sign-in is refreshed and saved in place, keeping what was chosen', sc3.calls.some(c => c.name === 'data_connection_set_secret' && JSON.parse(c.args.p_secret).refresh_token === 'rt2') && !sc3.calls.some(c => c.name === 'data_connection_store'));
  }

  console.log('\nPlanetScale: a read-only login made for NoBossly:');
  {
    const f = fakeFetch({
      'https://api.planetscale.com/v1/organizations/acme/databases/shop/branches/main/passwords': (u, o) => [201, JSON.parse(o.body).role === 'reader' ? { username: 'u1', plain_text: 'pscale_pw_FAKE', access_host_url: 'aws.connect.psdb.cloud' } : {}],
      'https://api.planetscale.com/v1/organizations/acme/databases/pg/branches/main/roles': (u, o) => [201, JSON.parse(o.body).inherited_roles.join() === 'pg_read_all_data' ? { username: 'r1', password: 'pscale_pass_FAKE', access_host_url: 'pg.psdb.cloud', database_name: 'postgres' } : {}],
      'https://api.planetscale.com/v1/organizations/acme/databases': () => [200, { data: [{ name: 'shop', kind: 'mysql', default_branch: 'main' }, { name: 'pg', kind: 'postgresql' }] }],
      'https://api.planetscale.com/v1/organizations': () => [200, { data: [{ name: 'acme' }] }]
    });
    const pr = await ps.projects('pat', { fetchImpl: f });
    ok('databases are listed with whether they are MySQL or Postgres', pr.projects.length === 2 && pr.projects[0].kind === 'mysql' && pr.projects[1].kind === 'postgres');
    const m = await ps.readerLogin('pat', pr.projects[0], { fetchImpl: f });
    ok('MySQL: a "reader" password, as a connection string', m.kind === 'mysql' && m.url === 'mysql://u1:pscale_pw_FAKE@aws.connect.psdb.cloud/shop');
    const p = await ps.readerLogin('pat', pr.projects[1], { fetchImpl: f });
    ok('Postgres: a role with only pg_read_all_data', p.kind === 'postgres' && /^postgresql:\/\/r1:pscale_pass_FAKE@pg\.psdb\.cloud:5432\/postgres$/.test(p.url));
    ok('odd names never reach the URL', !!(await ps.readerLogin('pat', { org: 'acme/../x', db: 'shop', branch: 'main' })).error);
  }

  console.log('\nWordPress, Firebase and the connect pages:');
  ok('Firebase via Google lists projects and counts with the member\'s own token', /p\.access \? \{ token: p\.access \}/.test(read('src/app_data/firebase.js')) && /firebase\.googleapis\.com\/v1beta1\/projects/.test(read('src/app_data/firebase.js')));
  const base = { title: 'X', user: { id: 'me' }, profile: { id: 'me', username: 'ana' }, plan: 'free', currentPath: '/', canonicalUrl: '', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
  const render = (v, d) => { try { return ejs.render(read('views/' + v), Object.assign({}, base, d), { filename: path.join(ROOT, 'views', v) }); } catch (e) { return 'ERR ' + e.message; } };
  const on = render('app_data_connect.ejs', { preset: AD.PRESETS.supabase, ready: true, full: false, max: 3, oauthReady: true });
  ok('with Supabase set up: one button, the manual way folded away', !on.startsWith('ERR') && on.includes('href="/app-data/oauth/supabase/start"') && /<details class="ad-manual">/.test(on), on.startsWith('ERR') ? on.slice(0, 200) : undefined);
  const off = render('app_data_connect.ejs', { preset: AD.PRESETS.supabase, ready: true, full: false, max: 3, oauthReady: false });
  ok('...without: "Coming soon", and the manual way open', off.includes('Coming soon') && !off.includes('/app-data/oauth/supabase/start') && /<details class="ad-manual" open>/.test(off));
  ok('Firebase\'s button says what Google will ask for', render('app_data_connect.ejs', { preset: AD.PRESETS.firebase, ready: true, full: false, max: 3, oauthReady: true }).includes('Google has no read-only permission for this'));
  const pick = render('app_data_project.ejs', { conn: { id: 'c1', kind: 'planetscale' }, projects: [{ id: 'acme/shop', name: 'shop', note: 'acme · MySQL' }], error: null });
  ok('the project picker lists what the sign-in can see', !pick.startsWith('ERR') && pick.includes('value="acme/shop"') && pick.includes('makes its own read-only login'));
  const routes = read('src/routes/app_data.js');
  ok('the callback checks state and PKCE from a cookie, per provider', /want\.state\.startsWith\(p \+ '\.'\)/.test(routes) && /OA\.exchange\(p, String\(req\.query\.code\), want\.verifier\)/.test(routes));

  console.log('\nShopify:');
  const shopify = require('../src/connections/shopify');
  process.env.SHOPIFY_CLIENT_ID = 'shp-client'; process.env.SHOPIFY_CLIENT_SECRET = 'shp-secret';
  const au = new URL(shopify.authUrl('my-shop.myshopify.com', 'shopify.st'));
  ok('the install link asks the store for read_orders only', au.host === 'my-shop.myshopify.com' && au.searchParams.get('scope') === 'read_orders' && au.searchParams.get('redirect_uri') === 'https://nobossly.com/budget/connect/shopify/callback');
  const qs = { code: 'c1', shop: 'my-shop.myshopify.com', state: 'shopify.st', timestamp: '1700000000', host: 'abc' };
  const msg = Object.keys(qs).sort().map(k => k + '=' + qs[k]).join('&');
  const signed = Object.assign({ hmac: crypto.createHmac('sha256', 'shp-secret').update(msg).digest('hex') }, qs);
  ok('Shopify\'s signature on the way back is checked', shopify.validCallback(signed) && !shopify.validCallback(Object.assign({}, signed, { shop: 'evil.myshopify.com' })) && !shopify.validCallback(qs));
  {
    const f = fakeFetch({ 'https://my-shop.myshopify.com/admin/oauth/access_token': (u, o) => [200, form(o.body).expiring === '1' ? { access_token: 'shpat', scope: 'read_orders', expires_in: 3600, refresh_token: 'shprt' } : {}] });
    const t = await shopify.exchange('my-shop.myshopify.com', 'c1', { fetchImpl: f, now: 0 });
    ok('an expiring offline token is asked for and kept with its refresh token', t.secret.mode === 'oauth' && t.secret.refresh_token === 'shprt' && t.secret.expires_at > 0);
    const w = await shopify.exchange('my-shop.myshopify.com', 'c1', { fetchImpl: fakeFetch({ 'https://my-shop.myshopify.com/': () => [200, { access_token: 'x', scope: 'read_orders,write_orders' }] }) });
    ok('a token that can write is refused', /more than read access/.test(w.error));
  }
  const body = Buffer.from(JSON.stringify({ shop_domain: 'my-shop.myshopify.com' }));
  ok('privacy webhooks: Shopify\'s signature over the raw body is checked', shopify.validWebhook(body, crypto.createHmac('sha256', 'shp-secret').update(body).digest('base64')) && !shopify.validWebhook(body, 'nope'));
  ok('...and they are mounted before the body parsers', read('server.js').indexOf("app.post('/webhooks/shopify', express.raw") < read('server.js').indexOf('app.use(express.json())'));
  const shopPage = render('budget_connect_shopify.ejs', { conn: null, ready: true, msg: null, everyHours: 6, oneClick: true });
  ok('the Shopify page leads with Connect Shopify when set up', !shopPage.startsWith('ERR') && shopPage.includes('action="/budget/connect/shopify/start"'), shopPage.startsWith('ERR') ? shopPage.slice(0, 200) : undefined);

  console.log('\nStripe:');
  const sapp = require('../src/connections/stripe_app');
  process.env.STRIPE_APP_CLIENT_ID = 'ca_app'; process.env.STRIPE_APP_SECRET_KEY = 'sk_test_FAKE';
  ok('Connect with Stripe goes to the Stripe App install page', sapp.authUrl('stripe.x').startsWith('https://marketplace.stripe.com/oauth/v2/authorize?') && new URL(sapp.authUrl('stripe.x')).searchParams.get('redirect_uri') === 'https://nobossly.com/budget/connect/stripe/callback');
  ok('a pasted restricted key is used as it is', (await sapp.keyFor(null, {}, 'rk_live_FAKE')).key === 'rk_live_FAKE');
  {
    const sc = fakeSb({}, { payment_connection_store: { data: 'x', error: null } });
    const f = fakeFetch({ 'https://api.stripe.com/v1/oauth/token': (u, o) => [200, form(o.body).grant_type === 'refresh_token' ? { access_token: 'sat2', refresh_token: 'srt2', stripe_user_id: 'acct_1' } : {}] });
    const k = await sapp.keyFor(sc, { user_id: 'me' }, JSON.stringify({ mode: 'oauth', access_token: 'sat1', refresh_token: 'srt1', expires_at: 1, account: 'acct_1' }), { fetchImpl: f, now: 10 });
    ok('a run-out sign-in is refreshed with the app\'s key, and the new token saved', k.key === 'sat2' && f.calls[0].opts.headers.Authorization === 'Basic ' + Buffer.from('sk_test_FAKE:').toString('base64') && JSON.parse(sc.calls[0].args.p_secret).refresh_token === 'srt2');
  }
  ok('the sync uses either kind of key', /stripe_app'\)\.keyFor\(sc, conn, raw/.test(read('src/stripe_sync.js')));

  console.log('\nAdmitad:');
  const adm = require('../src/connections/affiliates/admitad');
  process.env.ADMITAD_CLIENT_ID = 'adm-client'; process.env.ADMITAD_CLIENT_SECRET = 'adm-secret';
  ok('Connect with Admitad asks for statistics only', new URL(adm.authUrl('admitad.x')).searchParams.get('scope') === 'statistics' && adm.authUrl('admitad.x').startsWith('https://api.admitad.com/authorize/?'));
  {
    const f = fakeFetch({ 'https://api.admitad.com/token/': (u, o) => [200, form(o.body).grant_type === 'authorization_code' ? { access_token: 'aat', refresh_token: 'art', expires_in: 604800, scope: 'statistics' } : { access_token: 'aat2', refresh_token: 'art2', expires_in: 604800 }] });
    const t = await adm.exchange('c', { fetchImpl: f });
    ok('the code is exchanged; more than statistics is refused', t.secret.refresh_token === 'art' && /more than/.test((await adm.exchange('c', { fetchImpl: fakeFetch({ 'https://api.admitad.com/token/': () => [200, { access_token: 'x', scope: 'statistics manage_websites' }] }) })).error));
    const saved = [];
    const k = await adm.tokenFor({ mode: 'oauth', access_token: 'old', refresh_token: 'art', expires_at: 1 }, f, x => saved.push(x), 10);
    ok('a run-out sign-in is refreshed and saved', k.token === 'aat2' && saved[0].refresh_token === 'art2');
  }

  console.log('\nThe migration:');
  const sql = read('migrations/2026-11-18_one_click.sql');
  ok('adds the kinds, an in-place secret update, and Stripe to the store; marked not applied', /^-- NOT APPLIED/.test(sql) && /'supabase', 'planetscale'/.test(sql) && /data_connection_set_secret/.test(sql) && /'stripe', 'shopify'/.test(sql));

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
