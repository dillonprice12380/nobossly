const router = require('express').Router();
const ai = require('../ai');
const cai = require('../compass_ai');
const qsvc = require('../questionnaires');
const { awardXP } = require('../xp');
const { sweepMilestones } = require('../milestones_engine');
const fitLib = require('../fit');
const lib = require('../fit_library');
const pathsLib = require('../paths');

// One line per path, shown while the Compass is being drawn.
const LABELS = {
  creator: 'Reading your niche against what is already working on that platform\u2026',
  freelancer: 'Reading your skill against what that work sells for right now\u2026',
  consultant: 'Reading your expertise against who is paying for that advice\u2026',
  local_service: 'Reading your trade and your area against local demand\u2026',
  brick_mortar: 'Reading your concept against your rent ceiling and the market\u2026',
  online_store: 'Reading your product against margin, channel and competition\u2026',
  physical_product: 'Reading your product against what it costs to make and what it can sell for\u2026',
  software: 'Reading your problem against what people already use for it\u2026',
  exploring: 'Reading your profile and drawing your Compass\u2026'
};

const STEPS = path => !pathsLib.isPath(path) || path === 'exploring' ? [
  { id: 'queued', label: 'Reading your answers' },
  { id: 'generate', label: 'Naming your archetype and mapping your territories' },
  { id: 'save', label: 'Writing your fit test, avoid list and toolkit' }
] : [
  { id: 'queued', label: 'Reading your answers' },
  { id: 'scan', label: 'Searching the live market around you' },
  { id: 'generate', label: 'Naming your archetype and mapping your territories' },
  { id: 'save', label: 'Writing your fit test, avoid list and toolkit' }
];

const FLOORS = { queued: 2, scan: 8, generate: 40, generateNoScan: 8, save: 90 };

// The Compass page: latest compass, or route the user to generate one.
router.get('/', async (req, res, next) => {
  try {
    const { data: compass } = await req.sb.from('founder_compasses').select('*')
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const q = await qsvc.latestCompleted(req.sb, req.user.id);
    if (!compass) return res.redirect(q ? '/compass/generate' : '/questionnaire');
    // `motivation` is only ever asked in the final depth step, so its absence is
    // an exact test for "this founder has only answered the core seven".
    const canDeepen = !!q && !q.motivation;
    res.render('compass', { title: 'Your Compass', compass, canDeepen, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.get('/generate', async (req, res, next) => {
  try {
    const q = await qsvc.latestCompleted(req.sb, req.user.id);
    if (!q) return res.redirect('/questionnaire');
    const path = ai.pathOf(q);
    res.render('generating', { title: 'Drawing your Compass', action: '/compass/generate', label: LABELS[path] || LABELS.exploring, steps: STEPS(path) });
  } catch (e) { next(e); }
});

async function runCompassGeneration(req, q, jobId) {
  const sb = req.sb;
  const path = ai.pathOf(q);
  const patchJob = patch => sb.from('generation_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', jobId)
    .then(() => {}, e => console.error('compass job update', e && e.message));
  const report = (stage, progress, label) => patchJob({ stage, progress, stage_label: label || (STEPS(path).find(s => s.id === stage) || {}).label || '' });
  try {
    await report('queued', FLOORS.queued);
    let scan = null;
    if (pathsLib.hasSubject(q)) {
      await report('scan', FLOORS.scan);
      try { scan = await ai.marketScan(req.accessToken, q); }
      catch (err) { console.error('compass market scan', err && err.message); }
    }
    await report('generate', pathsLib.hasSubject(q) ? FLOORS.generate : FLOORS.generateNoScan);
    // The fit test comes from the curated library first, matched to this
    // founder's own answers, and the model is asked only for whatever gap is
    // left. Library criteria arrive already typed, so they can be graded by
    // arithmetic rather than opinion.
    const facts = lib.founderFacts(q);
    let fromLibrary = [];
    try {
      const { data: rows } = await sb.from('fit_criteria_library').select('*').eq('is_active', true);
      fromLibrary = lib.selectFromLibrary(rows, facts);
    } catch (err) {
      // A library that cannot be read is a degraded test, not a failed Compass:
      // the model still writes all five, exactly as it used to.
      console.error('fit library', err && err.message);
    }
    const data = await cai.generateCompass(req.accessToken, q, scan, fromLibrary);
    await report('save', FLOORS.save);
    // The library's criteria are authoritative — whatever the model returned for
    // those slots is discarded, and only its gap-fillers are kept.
    data.fit_test = lib.mergeFitTest(fromLibrary, data && data.fit_test, facts);
    const { error } = await sb.from('founder_compasses').insert({
      user_id: req.user.id, questionnaire_id: q.id, founder_path: path, data
    });
    if (error) throw error;
    await awardXP(sb, req.user.id, req.profile, 25, 'Compass drawn', 'founder_compasses', null);
    await patchJob({ status: 'done', progress: 100, stage: 'done', redirect: '/compass' });
  } catch (e) {
    console.error('compass generation', e);
    await patchJob({ status: 'error', error: 'Compass generation failed: ' + e.message });
  }
}

router.post('/generate', async (req, res) => {
  try {
    const q = await qsvc.latestCompleted(req.sb, req.user.id);
    if (!q) return res.json({ redirect: '/questionnaire' });
    const { data: job, error: jobErr } = await req.sb.from('generation_jobs')
      .insert({ user_id: req.user.id, kind: 'compass' }).select('id').maybeSingle();
    if (jobErr || !job) throw (jobErr || new Error('could not create generation job'));
    res.json({ job: job.id });
    runCompassGeneration(req, q, job.id);
  } catch (e) {
    console.error('compass generation start', e);
    res.json({ error: 'Compass generation failed to start: ' + e.message });
  }
});

const s = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n || 400);

async function compassData(req) {
  const { data } = await req.sb.from('founder_compasses').select('data')
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data && data.data;
}

function cleanCompetitors(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw.slice(0, 3).map(c => {
    if (!c || typeof c !== 'object') return null;
    const name = s(c.name, 120);
    if (!name) return null;
    return { name, what_they_do: s(c.what_they_do), strength: s(c.strength), weakness: s(c.weakness), your_edge: s(c.your_edge) };
  }).filter(Boolean);
  return out.length ? out : null;
}

async function runAdvisor(req, idea, compass, q, draft, plan) {
  // The criteria pinned to this idea when it was drafted, never the Compass's
  // current ones: redrawing the Compass must not move the goalposts under an
  // idea already being scored.
  const pinned = Array.isArray(idea.fit_test) && idea.fit_test.length
    ? idea.fit_test
    : fitLib.pinFitTest(compass && compass.fit_test);
  const adv = await cai.adviseIdea(req.accessToken, q, compass, draft, pinned);
  const modelResults = Array.isArray(adv.fit_results)
    ? adv.fit_results.map(f => ({ criterion: s(f && f.criterion, 200), pass: !!(f && f.pass), note: s(f && f.note, 300) }))
    : null;
  const version = (idea.revision_count || 0) + 1;
  const patch = {
    name: s(adv.name, 140) || idea.name,
    tagline: s(adv.tagline, 200) || idea.tagline,
    category: s(adv.category, 80) || 'Your idea',
    profile_summary: s(adv.profile_summary, 1000),
    why_you: s(adv.why_you, 1000),
    market_analysis: s(adv.market_analysis, 1500),
    competitor_landscape: s(adv.competitor_landscape, 1000),
    competitors: cleanCompetitors(adv.competitors),
    success_likelihood: Math.min(100, Math.max(0, parseInt(adv.success_likelihood, 10) || 50)),
    demand_score: Math.min(10, Math.max(1, parseInt(adv.demand_score, 10) || 5)),
    passion_score: Math.min(10, Math.max(1, parseInt(adv.passion_score, 10) || 5)),
    time_to_revenue: s(adv.time_to_revenue, 60), startup_cost_lean: s(adv.startup_cost_lean, 60),
    startup_cost_standard: s(adv.startup_cost_standard, 60), startup_cost_full: s(adv.startup_cost_full, 60),
    legal_nuances: s(adv.legal_nuances, 600), first_steps: s(adv.first_steps, 2000),
    advisor: {
      fit_results: null,   // filled in below, once the estimates it grades against exist
      sharper_version: s(adv.sharper_version, 800),
      considerations: Array.isArray(adv.considerations) ? adv.considerations.slice(0, 5).map(c => s(c, 300)).filter(Boolean) : null,
      advised_at: new Date().toISOString()
    },
    revision_count: version,
    updated_at: new Date().toISOString()
  };

  // Grade only now: the numeric criteria are checked against the advisor's own
  // cost and timing estimates, which are the fields just written above. Doing
  // this in code rather than taking the model's word is what stops the score
  // drifting between runs of an unchanged idea.
  const fit = fitLib.gradeFitTest(pinned, modelResults, patch);
  patch.advisor.fit_results = fit.results;
  patch.fit_test = pinned || null;
  patch.fit_passed = fit.passed;
  patch.fit_total = fit.total;
  patch.fit_verified = fit.verified;
  patch.fit_applicable = fit.applicable;
  patch.fit_pct = fit.pct;
  // The high-water marks, never lowered: a founder who revises into a worse
  // score has not un-earned the trophy they already have. best_fit_pct is what
  // the ladder reads, because it does not care how long the test is.
  patch.best_fit_passed = Math.max(idea.best_fit_passed || 0, fit.passed || 0);
  patch.best_fit_pct = Math.max(idea.best_fit_pct || 0, fit.pct || 0);
  await req.sb.from('generated_ideas').update(patch).eq('id', idea.id).eq('user_id', req.user.id);

  // History is the whole point of the loop: 2/5 -> 4/5 -> 5/5 across three
  // passes is the progress the founder is meant to see. Losing a version row
  // must never fail the advisory itself, which has already been saved above.
  await req.sb.from('idea_versions').insert({
    idea_id: idea.id, user_id: req.user.id, version_no: version,
    draft: draft || null, advisor: patch.advisor,
    fit_passed: fit.passed, fit_total: fit.total,
    success_likelihood: patch.success_likelihood
  }).then(() => {}, e => console.error('idea version', e && e.message));

  // Crossing a fit threshold is a trophy, so sweep straight away rather than
  // leaving the founder to find it on a later page.
  try { await sweepMilestones(req.sb, req.user.id, req.profile, plan === 'paid'); } catch (_) {}
}

// The founder drafts THEIR idea; the advisor stress-tests it against their
// Compass. The idea is saved first so a failed advisory never loses the draft.
router.post('/draft', async (req, res, next) => {
  try {
    const b = req.body;
    const name = s(b.name, 140);
    if (!name) return res.redirect('/compass?msg=' + encodeURIComponent('Give your idea a name to get started.'));
    const q = await qsvc.latestCompleted(req.sb, req.user.id);
    if (!q) return res.redirect('/questionnaire');
    const { data: compass } = await req.sb.from('founder_compasses').select('*')
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const draft = { name, tagline: s(b.tagline, 200), description: s(b.description, 2000), problem: s(b.problem, 1000), customer: s(b.customer, 500), monetization: s(b.monetization, 500) };
    const { count } = await req.sb.from('generated_ideas').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
    const { data: idea, error } = await req.sb.from('generated_ideas').insert({
      user_id: req.user.id, questionnaire_id: q.id, source: 'user',
      name: draft.name, tagline: draft.tagline, category: 'Your idea',
      profile_summary: draft.description, why_you: '',
      draft, fit_test: fitLib.pinFitTest(compass && compass.data && compass.data.fit_test),
      status: 'active', position: (count || 0)
    }).select('*').maybeSingle();
    if (error || !idea) throw (error || new Error('could not save your idea'));
    await awardXP(req.sb, req.user.id, req.profile, 15, 'Drafted your own idea: ' + draft.name, 'generated_ideas', idea.id);
    try {
      await runAdvisor(req, idea, compass && compass.data, q, draft, res.locals.plan);
      return res.redirect('/ideas/' + idea.id);
    } catch (err) {
      console.error('advisor', err && err.message);
      return res.redirect('/ideas/' + idea.id + '?msg=' + encodeURIComponent('Your idea is saved. The advisor could not run just now (' + err.message + ') \u2014 you can retry from your Compass.'));
    }
  } catch (e) { next(e); }
});

// Revise the idea and re-run the advisor — the Level 1 loop. The founder edits
// their own words, the advisor re-scores against their fit test, and the version
// row runAdvisor writes is what makes the improvement visible (2/5 -> 4/5 -> 5/5)
// rather than a single number that quietly changes.
//
// Body fields are optional: a bare submit re-runs the advisor on the stored
// draft, which is what you want after a failed advisory.
router.post('/draft/:id/revise', async (req, res, next) => {
  try {
    const { data: idea } = await req.sb.from('generated_ideas').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.redirect('/ideas');
    if (idea.cut_at) return res.redirect('/ideas/' + idea.id + '?msg=' + encodeURIComponent('This idea was cut. Draft a new one from your Compass.'));
    const b = req.body || {};
    const prev = idea.draft || {};
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    const draft = {
      name: (has('name') ? s(b.name, 140) : '') || prev.name || idea.name,
      tagline: has('tagline') ? s(b.tagline, 200) : (prev.tagline || idea.tagline || ''),
      description: has('description') ? s(b.description, 2000) : (prev.description || idea.profile_summary || ''),
      problem: has('problem') ? s(b.problem, 1000) : (prev.problem || ''),
      customer: has('customer') ? s(b.customer, 500) : (prev.customer || ''),
      monetization: has('monetization') ? s(b.monetization, 500) : (prev.monetization || '')
    };
    if (!draft.name) return res.redirect('/ideas/' + idea.id + '?msg=' + encodeURIComponent('Your idea needs a name.'));
    // Saved before the advisory runs, so a failed advisory never costs the
    // founder the edit they just made.
    await req.sb.from('generated_ideas').update({ draft, updated_at: new Date().toISOString() }).eq('id', idea.id).eq('user_id', req.user.id);
    try {
      await runAdvisor(req, idea, await compassData(req), await qsvc.latestCompleted(req.sb, req.user.id) || {}, draft, res.locals.plan);
      return res.redirect('/ideas/' + idea.id);
    } catch (err) {
      console.error('advisor revise', err && err.message);
      return res.redirect('/ideas/' + idea.id + '?msg=' + encodeURIComponent('Your revision is saved, but the advisor could not run: ' + err.message));
    }
  } catch (e) { next(e); }
});

// Cutting an idea that did not hold up. This is a real move, not a failure
// state: the trophy is worth as much as a refinement threshold, because
// dropping a weak idea on the evidence is the harder call and the one every
// other platform trains people out of making.
router.post('/draft/:id/cut', async (req, res, next) => {
  try {
    const reason = s((req.body || {}).cut_reason, 600);
    if (!reason) return res.redirect('/ideas/' + req.params.id + '?msg=' + encodeURIComponent('Say what you learned before cutting it \u2014 that is the part worth keeping.'));
    const { data: idea } = await req.sb.from('generated_ideas').select('id, name, cut_at').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.redirect('/ideas');
    if (idea.cut_at) return res.redirect('/ideas/' + idea.id);
    await req.sb.from('generated_ideas').update({
      status: 'dropped', cut_at: new Date().toISOString(), cut_reason: reason, updated_at: new Date().toISOString()
    }).eq('id', idea.id).eq('user_id', req.user.id);
    try { await sweepMilestones(req.sb, req.user.id, req.profile, res.locals.plan === 'paid'); } catch (_) {}
    return res.redirect('/ideas/' + idea.id + '?msg=' + encodeURIComponent('Cut, and the reason kept. That judgement is worth more than a polished idea nobody wants.'));
  } catch (e) { next(e); }
});

module.exports = router;
