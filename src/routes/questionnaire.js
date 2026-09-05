const router = require('express').Router();
const qs = require('../questionnaires');
const paths = require('../paths');
const { sweepMilestones } = require('../milestones_engine');

// Onboarding, driven by the founder's chosen PATH.
//
// This used to be a hand-written form with a branch per stage, and every
// founder answered the same generic questions regardless of what they were
// building. It is now a renderer over src/paths.js: step 1 picks the path,
// step 2 is the core set that path needs, and everything after is optional
// depth the founder opts into once they have seen their Compass.
//
// Adding or changing a question is a change to paths.js alone — this file
// does not know what any of them are.

const REQUIRED_STEPS = paths.REQUIRED_STEPS;   // chooser + core

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 500);
const csv = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 25);
const arr = v => (Array.isArray(v) ? v : (v ? [v] : [])).map(x => str(x, 120)).filter(Boolean).slice(0, 25);

// Reads one question's answer out of a submitted form body, in the shape that
// question type stores.
function readAnswer(q, body) {
  const raw = body[q.name];
  if (q.type === 'checks') return arr(raw);
  if (q.type === 'csv') return csv(raw);
  if (q.type === 'select' && (q.name === 'tech_level' || q.name === 'sales_comfort')) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (q.type === 'url') { const u = str(raw, 500); return /^https?:\/\//i.test(u) ? u : ''; }
  if (q.type === 'textarea') return str(raw, 2000);
  return str(raw, 500);
}

const answered = v => Array.isArray(v) ? v.length > 0 : (v !== null && v !== undefined && String(v).trim() !== '');

// Splits a set of answers into the columns they belong in. Universal questions
// carry a `col` and write to their own column, because the fit-criteria library
// matches on those exact fields; everything else is path-specific and goes to
// path_answers.
function partition(questions, body, existingPathAnswers) {
  const cols = {};
  const pathAnswers = { ...(existingPathAnswers || {}) };
  for (const q of questions) {
    const val = readAnswer(q, body);
    if (!answered(val) && q.type !== 'checks' && q.type !== 'csv') continue;
    if (q.col) cols[q.col] = val;
    else pathAnswers[q.name] = val;
  }
  return { cols, pathAnswers };
}

// Readiness: how much of this path's own question set the founder has filled
// in. Used to tell them what a deeper Compass would be drawn from.
function readinessScore(path, run) {
  const all = paths.coreQuestions(path).concat(paths.depthQuestions(path));
  if (!all.length) return 0;
  const pa = run.path_answers || {};
  const done = all.filter(q => answered(q.col ? run[q.col] : pa[q.name])).length;
  return Math.round(100 * done / all.length);
}

function render(req, res, run, step) {
  const path = run && run.founder_path;
  const steps = paths.depthSteps(path);
  res.render('questionnaire', {
    title: step === 1 ? 'Choose your path' : 'Your questions',
    paths: paths.PATHS,
    path: path || null,
    pathDef: paths.get(path),
    step,
    totalSteps: paths.totalSteps(path),
    requiredSteps: REQUIRED_STEPS,
    deepening: step > REQUIRED_STEPS,
    questions: step === 1 ? [] : (step === 2 ? paths.coreQuestions(path) : (steps[step - REQUIRED_STEPS - 1] || [])),
    q: run || {},
    pathAnswers: (run && run.path_answers) || {},
    run: run ? run.run_number : 1,
    canCancel: !!(req.profile && req.profile.onboarding_completed),
    msg: req.query.msg || null
  });
}

router.get('/', async (req, res, next) => {
  try {
    let run = await qs.latest(req.sb, req.user.id);
    if (!run) run = await qs.startNew(req.sb, req.user.id);

    // A path landing page can send someone straight here with their path
    // already chosen (/questionnaire?path=creator). It only pre-selects — the
    // founder still confirms on step 1, and it never overwrites a path they
    // have already started answering for.
    const wanted = req.query.path;
    if (paths.isPath(wanted) && !run.founder_path) {
      await req.sb.from('questionnaire_responses').update({ founder_path: wanted }).eq('id', run.id);
      run = { ...run, founder_path: wanted };
    }

    let step = parseInt(req.query.step, 10);
    if (!Number.isFinite(step) || step < 1) step = run.founder_path ? 2 : 1;
    // Never let a step past this path's own length render an empty form.
    step = Math.min(step, paths.totalSteps(run.founder_path));
    if (step > 1 && !run.founder_path) step = 1;
    render(req, res, run, step);
  } catch (e) { next(e); }
});

// A fresh run. Answering again is how a founder changes path — early founders
// pivot, and the newest completed run is the one everything reads.
router.get('/new', async (req, res, next) => {
  try {
    const { data: blank } = await req.sb.from('questionnaire_responses')
      .select('id').eq('user_id', req.user.id).is('founder_path', null).eq('completed', false).limit(1);
    if (blank && blank[0]) return res.redirect('/questionnaire?step=1');
    const { count } = await req.sb.from('questionnaire_responses')
      .select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
    await req.sb.from('questionnaire_responses').insert({ user_id: req.user.id, run_number: (count || 0) + 1 });
    res.redirect('/questionnaire?step=1');
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const step = Math.max(1, parseInt(req.body.step, 10) || 1);
    let run = await qs.latest(req.sb, req.user.id);
    if (!run) run = await qs.startNew(req.sb, req.user.id);

    // ---------- step 1: the path ----------
    if (step === 1) {
      const chosen = str(req.body.founder_path, 40);
      if (!paths.isPath(chosen)) {
        return res.redirect('/questionnaire?step=1&msg=' + encodeURIComponent('Pick the one that fits best — you can change it later by answering again.'));
      }
      // Changing path mid-run clears path answers that belonged to the old one,
      // rather than leaving a creator's follower count on a plumber's profile.
      const patch = { founder_path: chosen };
      if (run.founder_path && run.founder_path !== chosen) patch.path_answers = {};
      await req.sb.from('questionnaire_responses').update(patch).eq('id', run.id);
      return res.redirect('/questionnaire?step=2');
    }

    const path = run.founder_path;
    if (!paths.isPath(path)) return res.redirect('/questionnaire?step=1');

    // ---------- step 2+: answers ----------
    const steps = paths.depthSteps(path);
    const questions = step === REQUIRED_STEPS
      ? paths.coreQuestions(path)
      : (steps[step - REQUIRED_STEPS - 1] || []);

    const { cols, pathAnswers } = partition(questions, req.body, run.path_answers);
    await req.sb.from('questionnaire_responses')
      .update({ ...cols, path_answers: pathAnswers, updated_at: new Date().toISOString() })
      .eq('id', run.id);

    if (step < REQUIRED_STEPS) return res.redirect('/questionnaire?step=' + (step + 1));

    // Clearing the core completes onboarding. Readiness is recomputed on every
    // save, so deepening later sharpens it rather than needing a redo.
    const fresh = await qs.byId(req.sb, req.user.id, run.id);
    await req.sb.from('questionnaire_responses')
      .update({ completed: true, readiness_score: readinessScore(path, fresh) }).eq('id', run.id);
    await req.sb.from('profiles').update({
      onboarding_completed: true,
      display_name: fresh.founder_name || undefined,
      // Mirrored so challenge matching and the Coach do not have to join
      // through the questionnaire on every request.
      path
    }).eq('id', req.user.id);

    // Answering is the Level 1 quest, so award its trophy now rather than
    // leaving the founder to find it on a later page.
    try { await sweepMilestones(req.sb, req.user.id, req.profile, res.locals.plan === 'paid'); } catch (_) {}

    // Depth steps run AFTER the Compass exists. Finishing the last one redraws
    // it against the fuller profile; stopping partway is fine.
    const total = paths.totalSteps(path);
    if (step > REQUIRED_STEPS && step < total) return res.redirect('/questionnaire?step=' + (step + 1));
    res.redirect('/compass/generate');
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.readinessScore = readinessScore;
module.exports.partition = partition;
module.exports.readAnswer = readAnswer;
