const router = require('express').Router();
const paths = require('../paths');
const dashboards = require('../path_dashboards');
const pi = require('../personal_info_filter');
const pages = require('../path_pages');

// Onboarding, now just this: pick a path, land in the product. Replaces the
// old AI-driven questionnaire + Compass. Also reachable any time to switch
// paths later.
router.get('/', (req, res) => {
  const p = req.profile || {};
  const saved = p.saved_paths && typeof p.saved_paths === 'object' ? Object.keys(p.saved_paths) : [];
  res.render('choose_path', {
    title: 'Choose your path',
    choices: pages.choices(),
    current: p.path && paths.isPath(p.path) ? p.path : null,
    saved,
    // saved_paths arrives with migrations/2026-11-10_path_pages.sql.
    keepsAnswers: Object.prototype.hasOwnProperty.call(p, 'saved_paths'),
    msg: req.query.msg || null
  });
});

router.post('/', async (req, res, next) => {
  try {
    const chosen = String(req.body.path || '').trim();
    if (!paths.isPath(chosen)) {
      return res.redirect('/choose-path?msg=' + encodeURIComponent('Pick the one that fits best — you can change it later.'));
    }
    // A new path's subpath and answers would be the old path's otherwise; the
    // old ones are put aside and come back on switching back (src/path_pages).
    await req.sb.from('profiles').update(Object.assign({ path: chosen, onboarding_completed: true },
      pages.switchPatch(req.profile, chosen))).eq('id', req.user.id);
    res.redirect('/choose-path/setup');
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Setup: right after a path is chosen, the subpath and the three or four path
// questions that shape that path's dashboard (src/path_dashboards). About a
// minute, skippable, and editable later from the dashboard.
//
// path_answers arrives with migrations/2026-11-01_workspace_foundations.sql;
// until then only the subpath is kept.
const hasAnswersColumn = p => !!p && Object.prototype.hasOwnProperty.call(p, 'path_answers');

router.get('/setup', (req, res) => {
  const slug = req.profile && req.profile.path;
  if (!slug || !paths.isPath(slug)) return res.redirect('/choose-path');
  res.render('choose_path_setup', {
    title: 'Set up your dashboard',
    def: paths.get(slug),
    subpaths: paths.subpathsOf(slug) || [],
    questions: dashboards.setupQuestions(slug),
    subpath: req.profile.subpath || '',
    answers: (req.profile.path_answers && typeof req.profile.path_answers === 'object') ? req.profile.path_answers : {}
  });
});

// One answer, cleaned to what its question allows.
function readAnswer(q, body) {
  const raw = body[q.name];
  if (q.type === 'checks') {
    const opts = q.options || [];
    return [].concat(raw || []).map(String).filter(v => opts.includes(v)).slice(0, 12);
  }
  if (q.type === 'select') return (q.options || []).includes(String(raw)) ? String(raw) : '';
  if (q.type === 'csv') return String(raw || '').split(',').map(s => s.trim().slice(0, 60)).filter(Boolean).slice(0, 12);
  return String(raw || '').trim().slice(0, q.type === 'textarea' ? 600 : 160);
}

router.post('/setup', async (req, res, next) => {
  try {
    const slug = req.profile && req.profile.path;
    if (!slug || !paths.isPath(slug)) return res.redirect('/choose-path');
    if (req.body.skip) return res.redirect('/dashboard');
    const subs = paths.subpathsOf(slug) || [];
    const subpath = subs.some(s => s.slug === req.body.subpath) ? req.body.subpath : null;
    const answers = {};
    for (const q of dashboards.setupQuestions(slug)) {
      const v = readAnswer(q, req.body);
      if (Array.isArray(v) ? v.length : v) answers[q.name] = v;
    }
    const found = pi.check(...Object.values(answers).flat());
    if (found) return pi.refuse(req, res, '/choose-path/setup', found, 'path_setup');
    const patch = { subpath };
    if (hasAnswersColumn(req.profile)) patch.path_answers = answers;
    await req.sb.from('profiles').update(patch).eq('id', req.user.id);
    res.redirect('/dashboard?msg=' + encodeURIComponent('Your dashboard is set up for your path. You can change these answers any time.'));
  } catch (e) { next(e); }
});

module.exports = router;
