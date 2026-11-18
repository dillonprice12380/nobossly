// App data (src/app_data): a member connects their own app's database and
// NoBossly counts its users. Mounted at /app-data behind requireAuth.
//
// Secrets never pass through the member's own client: the server checks what
// it was given, stores it with the service role (data_connection_store), and
// reads it back only to count.

const router = require('express').Router();
const { serviceClient } = require('../supabase');
const AD = require('../app_data');
const dashboards = require('../path_dashboards');
const crypto = require('crypto');
const wpConnect = require('../app_data/wordpress');
const OA = require('../app_data/oauth');
const SITE = (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');

const service = () => { try { return serviceClient(); } catch (_) { return null; } };
const enc = encodeURIComponent;
const go = (res, path, m) => res.redirect(path + (m ? (path.includes('?') ? '&' : '?') + 'msg=' + enc(m) : ''));
const ID = /^[0-9a-f-]{36}$/i;
const missing = err => !!err && (err.code === '42P01' || err.code === 'PGRST205' || err.code === '42883' || err.code === 'PGRST202' || /does not exist|Could not find/i.test(err.message || ''));
const COLS = 'id, kind, provider, label, host_label, config, status, last_error, last_synced_at, created_at';

async function mine(req) {
  const r = await req.sb.from('data_connections').select(COLS).eq('user_id', req.user.id).order('created_at');
  return { list: r.data || [], ready: !r.error };
}
async function one(req, id) {
  if (!ID.test(id)) return null;
  const r = await req.sb.from('data_connections').select(COLS + ', user_id').eq('id', id).eq('user_id', req.user.id).maybeSingle();
  return r.data || null;
}
const pathMetricKeys = profile => { const it = dashboards.pathItemsFor(profile || {}); return it ? it.metrics.map(m => m.key) : []; };

// ------------------------------------------------------------------ Overview
router.get('/', async (req, res, next) => {
  try {
    const { list, ready } = await mine(req);
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const ids = list.map(c => c.id);
    const rows = ids.length ? ((await req.sb.from('app_metrics').select('connection_id, day, total_users, new_users, active_7d, active_30d').in('connection_id', ids).gte('day', since).order('day').limit(1000)).data || []) : [];
    const sums = {};
    list.forEach(c => { sums[c.id] = AD.summary(rows.filter(r => r.connection_id === c.id)); });
    res.render('app_data', { title: 'Your app\'s users', list, sums, ready, presets: Object.values(AD.PRESETS), max: AD.MAX, canSync: !!service(), everyHours: AD.EVERY_HOURS, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- Connect
const PRESETS = Object.keys(AD.PRESETS).join('|');
router.get('/connect/:preset(' + PRESETS + ')', async (req, res, next) => {
  try {
    const { list, ready } = await mine(req);
    const preset = AD.PRESETS[req.params.preset];
    res.render('app_data_connect', { title: 'Connect ' + preset.label, preset, ready, oauthReady: preset.oauth ? OA.configured(preset.oauth) : false, full: list.length >= AD.MAX, max: AD.MAX, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/connect/:preset(' + PRESETS + ')', async (req, res, next) => {
  try {
    const back = '/app-data/connect/' + req.params.preset;
    const sc = service();
    if (!sc) return go(res, back, 'Connecting is not switched on right now. Try again later.');
    const r = await AD.connect(sc, req.user.id, req.params.preset, req.body);
    if (r.error === 'save') return go(res, back, missing(r.dbError) ? 'Connecting app databases is being switched on. Check back shortly.' : 'Could not save the connection. Please try again.');
    if (r.error) return go(res, back, r.error);
    go(res, '/app-data/' + r.id + '/setup', 'Connected. Now choose what to count.');
  } catch (e) { next(e); }
});

// ------------------------------------------------- Connect with WordPress
// The member names their site; WordPress's own approval page does the rest
// and sends them back here with an application password made for NoBossly.
const WP_COOKIE = 'nb_wp_connect';
const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/app-data', maxAge: 15 * 60 * 1000 };

router.post('/connect/wordpress/start', async (req, res, next) => {
  try {
    const back = '/app-data/connect/wordpress';
    const a = await wpConnect.authorizeUrl(req.body && req.body.url);
    if (a.error) return go(res, back, a.error);
    const state = crypto.randomBytes(18).toString('base64url');
    res.cookie(WP_COOKIE, JSON.stringify({ state, site: a.site, host: a.host }), cookieOpts);
    const cb = SITE + '/app-data/connect/wordpress/callback?state=' + state;
    res.redirect(wpConnect.approvalLink(a, cb, cb + '&rejected=1'));
  } catch (e) { next(e); }
});

router.get('/connect/wordpress/callback', async (req, res, next) => {
  try {
    const back = '/app-data/connect/wordpress';
    let want = null;
    try { want = JSON.parse((req.cookies && req.cookies[WP_COOKIE]) || 'null'); } catch (_) { want = null; }
    res.clearCookie(WP_COOKIE, { path: '/app-data' });
    const got = String(req.query.state || '');
    const same = want && want.state && got.length === want.state.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want.state));
    if (!same) return go(res, back, 'That WordPress approval did not finish. Try again.');
    if (req.query.rejected) return go(res, back, 'WordPress was not connected (you said no).');
    let host = null;
    try { host = new URL(String(req.query.site_url || '')).hostname.toLowerCase(); } catch (_) { host = null; }
    if (host !== want.host) return go(res, back, 'That approval came from a different site. Try again.');
    const sc = service();
    if (!sc) return go(res, back, 'Connecting is not switched on right now. Try again later.');
    const r = await AD.connect(sc, req.user.id, 'wordpress', { url: want.site, user: req.query.user_login, password: req.query.password });
    if (r.error === 'save') return go(res, back, missing(r.dbError) ? 'Connecting app databases is being switched on. Check back shortly.' : 'Could not save the connection. Please try again.');
    if (r.error) return go(res, back, r.error);
    go(res, '/app-data/' + r.id + '/setup', 'WordPress connected. Choose what to fill in, then save.');
  } catch (e) { next(e); }
});

// ------------------------------------- Connect with Supabase / Google / PlanetScale
const OAUTH_COOKIE = 'nb_ad_oauth';
const NAMES = { supabase: 'Supabase', google: 'Google', planetscale: 'PlanetScale' };
const BACK = { supabase: '/app-data/connect/supabase', google: '/app-data/connect/firebase', planetscale: '/app-data/connect/mysql' };

router.get('/oauth/:provider(supabase|google|planetscale)/start', (req, res) => {
  const p = req.params.provider;
  if (!OA.configured(p)) return go(res, BACK[p], 'Connect with ' + NAMES[p] + ' is coming soon. Set it up by hand below for now.');
  const s = OA.start(p);
  res.cookie(OAUTH_COOKIE, JSON.stringify({ state: s.state, verifier: s.verifier }), cookieOpts);
  res.redirect(s.url);
});

router.get('/oauth/:provider(supabase|google|planetscale)/callback', async (req, res, next) => {
  try {
    const p = req.params.provider, back = BACK[p];
    let want = null;
    try { want = JSON.parse((req.cookies && req.cookies[OAUTH_COOKIE]) || 'null'); } catch (_) { want = null; }
    res.clearCookie(OAUTH_COOKIE, { path: '/app-data' });
    const got = String(req.query.state || '');
    const same = want && want.state && want.state.startsWith(p + '.') && got.length === want.state.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want.state));
    if (!same) return go(res, back, 'That ' + NAMES[p] + ' sign-in did not finish. Try again.');
    if (req.query.error || !req.query.code) return go(res, back, NAMES[p] + ' was not connected' + (req.query.error === 'access_denied' ? ' (you said no).' : '.'));
    const sc = service();
    if (!sc) return go(res, back, 'Connecting is not switched on right now. Try again later.');
    const t = await OA.exchange(p, String(req.query.code), want.verifier);
    if (t.error) return go(res, back, t.error);
    const r = await AD.connectOAuth(sc, req.user.id, p, t.token);
    if (r.error === 'save') return go(res, back, missing(r.dbError) || /unknown kind|check constraint/i.test((r.dbError && r.dbError.message) || '') ? 'Connect with ' + NAMES[p] + ' is being switched on. Check back shortly.' : 'Could not save the connection. Please try again.');
    if (r.error) return go(res, back, r.error);
    go(res, '/app-data/' + r.id + '/setup', 'Signed in. Now choose the project.');
  } catch (e) { next(e); }
});

router.post('/:id/project', async (req, res, next) => {
  try {
    const conn = await one(req, req.params.id);
    if (!conn) return go(res, '/app-data');
    const sc = service();
    if (!sc) return go(res, '/app-data', 'Not switched on right now. Try again later.');
    const r = await AD.chooseProject(sc, Object.assign({}, conn, { user_id: req.user.id }), req.body && req.body.project);
    go(res, '/app-data/' + conn.id + '/setup', r.error || null);
  } catch (e) { next(e); }
});

// -------------------------------------------------------------- What to count
router.get('/:id/setup', async (req, res, next) => {
  try {
    const conn = await one(req, req.params.id);
    if (!conn) return go(res, '/app-data');
    const sc = service();
    const full = Object.assign({}, conn, { user_id: req.user.id });
    if (AD.needsProject(conn)) {
      const pr = sc ? await AD.projectsFor(sc, full) : { error: 'Not switched on right now. Try again later.' };
      return res.render('app_data_project', { title: 'Choose a project', conn, projects: pr.projects || [], error: pr.error || null, msg: req.query.msg || null });
    }
    const t = sc ? await AD.tablesFor(sc, full) : { error: 'Not switched on right now. Try again later.' };
    res.render('app_data_setup', { title: 'What to count', conn, tables: t.tables || [], tablesError: t.error || null, needsTable: AD.needsTable(conn.kind),
      fillable: AD.fillable(pathMetricKeys(req.profile)), defaults: AD.DEFAULT_FILL, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/:id/setup', async (req, res, next) => {
  try {
    const conn = await one(req, req.params.id);
    if (!conn) return go(res, '/app-data');
    const back = '/app-data/' + conn.id + '/setup';
    const sc = service();
    if (!sc) return go(res, back, 'Not switched on right now. Try again later.');
    const full = Object.assign({}, conn, { user_id: req.user.id });
    const t = await AD.tablesFor(sc, full);
    if (t.error) return go(res, back, t.error);
    const c = AD.configFrom(full, req.body, t.tables);
    if (c.error) return go(res, back, c.error);
    const s = await AD.saveConfig(sc, full, c.config);
    if (s.error) return go(res, back, s.error);
    const r = await AD.sync(sc, Object.assign(full, { config: c.config }));
    go(res, '/app-data', r.error ? r.error : 'Counted: ' + (r.total == null ? 'sign-ups' : r.total.toLocaleString('en-US') + ' users') + (r.active30 != null ? ', ' + r.active30.toLocaleString('en-US') + ' active in the last 30 days' : '') + '.' + (r.filled.length ? ' Your dashboard numbers are filled in too.' : ''));
  } catch (e) { next(e); }
});

router.post('/:id/sync', async (req, res, next) => {
  try {
    const conn = await one(req, req.params.id);
    if (!conn) return go(res, '/app-data');
    const sc = service();
    if (!sc) return go(res, '/app-data', 'Syncing is not switched on right now. Try again later.');
    if (conn.last_synced_at && Date.now() - new Date(conn.last_synced_at).getTime() < 60000) return go(res, '/app-data', 'Counted less than a minute ago.');
    const r = await AD.sync(sc, Object.assign({}, conn, { user_id: req.user.id }));
    go(res, '/app-data', r.error ? r.error : 'Counted again.');
  } catch (e) { next(e); }
});

router.post('/:id/disconnect', async (req, res, next) => {
  try {
    if (!ID.test(req.params.id)) return go(res, '/app-data');
    await req.sb.rpc('data_disconnect', { p_id: req.params.id });
    go(res, '/app-data', 'Disconnected. The access details are deleted from NoBossly, and so are this app\'s counts. You can also delete the read-only user or key on your side.');
  } catch (e) { next(e); }
});

module.exports = router;
