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
    res.render('app_data_connect', { title: 'Connect ' + AD.PRESETS[req.params.preset].label, preset: AD.PRESETS[req.params.preset], ready, full: list.length >= AD.MAX, max: AD.MAX, msg: req.query.msg || null });
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

// -------------------------------------------------------------- What to count
router.get('/:id/setup', async (req, res, next) => {
  try {
    const conn = await one(req, req.params.id);
    if (!conn) return go(res, '/app-data');
    const sc = service();
    const t = sc ? await AD.tablesFor(sc, Object.assign({}, conn, { user_id: req.user.id })) : { error: 'Not switched on right now. Try again later.' };
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
