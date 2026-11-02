// The generic workspace pages behind every path dashboard: a board of cards
// in stages, a calendar of dated cards, a metric log, a checklist. Which
// boards, metrics and checklists exist is declared in code
// (src/engines/registry.js); this file only shows them and saves edits.
//
// Mounted at /workspace behind requireAuth. Every query names the member as
// well as relying on row policies — belt and braces on private data.
//
// Until migrations/2026-11-01_workspace_foundations.sql is applied the tables
// are missing; pages then say "being set up" instead of failing.
const router = require('express').Router();
const registry = require('../engines/registry');
const pipeline = require('../engines/pipeline');
const metrics = require('../engines/metrics');
const checklists = require('../engines/checklists');
const fmt = require('../engines/format');
const dates = require('../engines/dates');
const { missing } = require('../engines/errors');

const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where this router is mounted, so links survive a move.
const rootOf = req => req.baseUrl || '/workspace';

// The engines' own messages are written for members; nothing else is shown.
const say = e => (e && e.user ? e.message : 'Something went wrong. Please try again.');

const notFound = (res, message) => res.status(404).render('error', { title: 'Not found', message });

// A POST that went wrong: back to the page with the reason in ?err=.
function bounce(res, to, e) {
  if (e && e.notFound) return notFound(res, e.message);
  if (e && !e.user && !missing(e)) console.error('[workspace]', e.code || '', e.message || e);
  const sep = to.includes('?') ? '&' : '?';
  // A missing table: the page itself explains, so no error on top.
  return res.redirect(missing(e) ? to : to + sep + 'err=' + enc(say(e)));
}

const msgOf = req => (typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null);

// ---------------------------------------------------------------------------
// Boards

router.param('board', (req, res, next, key) => {
  const def = registry.board(key);
  if (!def) return notFound(res, 'There is no board called "' + String(key).slice(0, 40) + '".');
  req.boardDef = def;
  next();
});

router.param('id', (req, res, next, id) => {
  if (!UUID.test(id)) return notFound(res, 'That is gone, or was never here.');
  next();
});

router.get('/boards/:board', async (req, res, next) => {
  const def = req.boardDef, root = rootOf(req);
  const view = { title: def.label, def, root, fmt, msg: msgOf(req), notReady: false };
  try {
    const b = await pipeline.list(req.sb, req.user.id, def.key);
    res.render('workspace/board', Object.assign(view, { columns: b.columns, totals: b.totals }));
  } catch (e) {
    if (!missing(e)) return next(e);
    res.render('workspace/board', Object.assign(view, {
      notReady: true, columns: def.stages.map(s => ({ stage: s, items: [] })), totals: pipeline.totalsOf(def, [])
    }));
  }
});

router.post('/boards/:board', async (req, res) => {
  const def = req.boardDef, to = rootOf(req) + '/boards/' + def.key;
  try {
    const item = await pipeline.create(req.sb, req.user.id, def.key, req.body || {});
    res.redirect(to + '?msg=' + enc('Added "' + item.title.slice(0, 60) + '".') + '#item-' + item.id);
  } catch (e) { bounce(res, to, e); }
});

router.get('/boards/:board/:id', async (req, res, next) => {
  const def = req.boardDef, root = rootOf(req);
  try {
    const { item } = await pipeline.get(req.sb, req.user.id, def.key, req.params.id);
    res.render('workspace/board_item', { title: item.title + ' · ' + def.label, def, item, root, fmt, msg: msgOf(req) });
  } catch (e) {
    if (missing(e)) return res.redirect(root + '/boards/' + def.key);
    if (e.notFound) return notFound(res, e.message);
    next(e);
  }
});

router.post('/boards/:board/:id', async (req, res) => {
  const def = req.boardDef, root = rootOf(req);
  try {
    const item = await pipeline.update(req.sb, req.user.id, def.key, req.params.id, req.body || {});
    res.redirect(root + '/boards/' + def.key + '?msg=' + enc('Saved "' + item.title.slice(0, 60) + '".') + '#item-' + item.id);
  } catch (e) { bounce(res, root + '/boards/' + def.key + '/' + req.params.id, e); }
});

router.post('/boards/:board/:id/move', async (req, res) => {
  const def = req.boardDef, to = rootOf(req) + '/boards/' + def.key;
  try {
    const item = await pipeline.move(req.sb, req.user.id, def.key, req.params.id, String((req.body || {}).stage || ''));
    res.redirect(to + '#item-' + item.id);
  } catch (e) { bounce(res, to, e); }
});

router.post('/boards/:board/:id/delete', async (req, res) => {
  const def = req.boardDef, to = rootOf(req) + '/boards/' + def.key;
  try {
    await pipeline.remove(req.sb, req.user.id, def.key, req.params.id);
    res.redirect(to + '?msg=' + enc('Deleted.'));
  } catch (e) { bounce(res, to, e); }
});

// ---------------------------------------------------------------------------
// Calendar: dated cards from one or more boards on a month grid.
// No ?boards= means every board there is.

router.get('/calendar', async (req, res, next) => {
  const root = rootOf(req);
  const asked = String(req.query.boards || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  const keys = asked.length ? asked.filter(k => registry.board(k)) : registry.all().boards.map(b => b.key);
  if (asked.length && !keys.length) return notFound(res, 'None of those boards exist.');
  const month = dates.parseMonth(req.query.month) || dates.today().slice(0, 7);
  const view = { title: 'Calendar · ' + fmt.monthLabel(month), root, fmt, boardsParam: asked.length ? keys.join(',') : '', notReady: false, msg: msgOf(req) };
  const empty = () => ({
    month, prev: dates.addMonths(month, -1), next: dates.addMonths(month, 1), boards: Object.fromEntries(keys.map(k => [k, registry.board(k)])),
    byDate: {}, count: 0, weeks: pipeline.monthGrid(month).map(w => w.map(c => Object.assign(c, { items: [] })))
  });
  try {
    const cal = keys.length ? await pipeline.calendar(req.sb, req.user.id, keys, month) : empty();
    res.render('workspace/calendar', Object.assign(view, { cal }));
  } catch (e) {
    if (!missing(e)) return next(e);
    res.render('workspace/calendar', Object.assign(view, { cal: empty(), notReady: true }));
  }
});

// ---------------------------------------------------------------------------
// Metrics

router.param('metric', (req, res, next, key) => {
  const def = registry.metric(key);
  if (!def) return notFound(res, 'There is no metric called "' + String(key).slice(0, 40) + '".');
  req.metricDef = def;
  next();
});

// A number kept in dollars belongs to Dashboard → Money in the nav.
router.param('metric', (req, res, next, key) => {
  const def = registry.metric(key);
  if (def && def.unit === 'money') res.locals.navSub = 'money';
  next();
});

router.get('/metrics/:metric', async (req, res, next) => {
  const def = req.metricDef, root = rootOf(req);
  const current = metrics.periodOf(def, '');
  const view = {
    title: def.label, def, root, fmt, msg: msgOf(req), notReady: false,
    periodValue: metrics.periodInput(def, current), periodLabel: metrics.periodLabel(def, current)
  };
  try {
    const [s, history] = await Promise.all([
      metrics.series(req.sb, req.user.id, def.key, 12),
      metrics.entries(req.sb, req.user.id, def.key, 120)
    ]);
    res.render('workspace/metric', Object.assign(view, { card: metrics.present(def, s), history }));
  } catch (e) {
    if (!missing(e)) return next(e);
    const blank = [];
    for (let i = 11, p = metrics.step(def, current, -11); i >= 0; i--, p = metrics.step(def, p, 1)) blank.push({ period: p, label: metrics.periodLabel(def, p, true), value: null, id: null, note: null });
    res.render('workspace/metric', Object.assign(view, { notReady: true, card: metrics.present(def, blank), history: [] }));
  }
});

router.post('/metrics/:metric', async (req, res) => {
  const def = req.metricDef, to = rootOf(req) + '/metrics/' + def.key;
  const b = req.body || {};
  try {
    const saved = await metrics.log(req.sb, req.user.id, def.key, b.period, b.value, b.note);
    res.redirect(to + '?msg=' + enc('Logged ' + fmt.byUnit(def.unit, saved.value) + ' for ' + metrics.periodLabel(def, String(saved.period).slice(0, 10)) + '.'));
  } catch (e) { bounce(res, to, e); }
});

router.post('/metrics/:metric/:id/delete', async (req, res) => {
  const def = req.metricDef, to = rootOf(req) + '/metrics/' + def.key;
  try {
    await metrics.remove(req.sb, req.user.id, def.key, req.params.id);
    res.redirect(to + '?msg=' + enc('Entry deleted.'));
  } catch (e) { bounce(res, to, e); }
});

// ---------------------------------------------------------------------------
// Checklists

router.param('checklist', (req, res, next, key) => {
  const def = registry.checklist(key);
  if (!def) return notFound(res, 'There is no checklist called "' + String(key).slice(0, 40) + '".');
  req.checklistDef = def;
  next();
});

router.get('/checklists/:checklist', async (req, res, next) => {
  const def = req.checklistDef, root = rootOf(req);
  const view = { title: def.label, def, root, fmt, msg: msgOf(req), notReady: false };
  try {
    res.render('workspace/checklist', Object.assign(view, { progress: await checklists.progress(req.sb, req.user.id, def.key) }));
  } catch (e) {
    if (!missing(e)) return next(e);
    res.render('workspace/checklist', Object.assign(view, { notReady: true, progress: checklists.merge(def, []) }));
  }
});

// done=1 / done=0 from the form; without it the tick flips.
router.post('/checklists/:checklist/:item/toggle', async (req, res) => {
  const def = req.checklistDef, to = rootOf(req) + '/checklists/' + def.key;
  const d = (req.body || {}).done;
  try {
    await checklists.toggle(req.sb, req.user.id, def.key, req.params.item, d === '1' ? true : d === '0' ? false : undefined);
    res.redirect(to + '#' + enc('item-' + req.params.item));
  } catch (e) { bounce(res, to, e); }
});

router.post('/checklists/:checklist/:item/due', async (req, res) => {
  const def = req.checklistDef, to = rootOf(req) + '/checklists/' + def.key;
  try {
    const d = await checklists.setDue(req.sb, req.user.id, def.key, req.params.item, (req.body || {}).due_on);
    res.redirect(to + '?msg=' + enc(d ? 'Renew-by date set to ' + fmt.date(d) + '.' : 'Renew-by date cleared.') + '#' + enc('item-' + req.params.item));
  } catch (e) { bounce(res, to, e); }
});

router.post('/checklists/:checklist/:item/note', async (req, res) => {
  const def = req.checklistDef, to = rootOf(req) + '/checklists/' + def.key;
  try {
    await checklists.setNote(req.sb, req.user.id, def.key, req.params.item, (req.body || {}).note);
    res.redirect(to + '?msg=' + enc('Note saved.') + '#' + enc('item-' + req.params.item));
  } catch (e) { bounce(res, to, e); }
});

module.exports = router;
