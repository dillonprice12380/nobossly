const router = require('express').Router();
const { planOf } = require('../middleware/auth');
const { gate, gateJson } = require('../upgrade');
const ai = require('../ai');
const qs = require('../questionnaires');
const { awardXP } = require('../xp');

const PATH_LABELS = {
  existing: 'Already in business',
  idea: 'Started from an idea',
  exploring: 'Started from a blank page'
};

// Copy shown while the generator runs — each path is doing something different.
const GENERATING_LABELS = {
  existing: 'Running a market read on your business and mapping your strongest paths forward…',
  idea: 'Stacking your idea against live demand and finding your angle…',
  exploring: 'Analyzing your profile and generating tailored business ideas…'
};

// The steps the generating screen lists, in order. Each id maps to a slice of the
// progress bar in generating.ejs; the server reports a stage as it actually starts
// it, so the bar can never run ahead of the work.
const IDEA_STEPS = {
  existing: [
    { id: 'queued', label: 'Reading your questionnaire answers' },
    { id: 'scan', label: 'Reading your website and searching for your business' },
    { id: 'generate', label: 'Weighing your business against what the market is doing' },
    { id: 'save', label: 'Scoring each path and writing your first steps' }
  ],
  idea: [
    { id: 'queued', label: 'Reading your questionnaire answers' },
    { id: 'scan', label: 'Searching the web for demand and competitors in your space' },
    { id: 'generate', label: 'Stacking your idea against the market and finding your angle' },
    { id: 'save', label: 'Scoring each option and writing your first steps' }
  ],
  exploring: [
    { id: 'queued', label: 'Reading your questionnaire answers' },
    { id: 'generate', label: 'Matching your skills and constraints to business models' },
    { id: 'save', label: 'Scoring each idea and writing your first steps' }
  ]
};

// Where each stage starts on the bar. The scan-less path hands its slice to generate.
const FLOORS = { queued: 2, scan: 6, generate: 38, generateNoScan: 6, save: 88 };

const stepLabel = (path, id) => (IDEA_STEPS[path].find(s => s.id === id) || {}).label || '';

// Normalize the AI competitors field into a clean array of exactly the shape the view expects.
function cleanCompetitors(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw.slice(0, 3).map(c => {
    if (!c || typeof c !== 'object') return null;
    const s = v => (v == null ? '' : String(v)).slice(0, 400);
    const name = s(c.name).slice(0, 120);
    if (!name) return null;
    return { name, what_they_do: s(c.what_they_do), strength: s(c.strength), weakness: s(c.weakness), your_edge: s(c.your_edge) };
  }).filter(Boolean);
  return out.length ? out : null;
}

router.get('/', async (req, res, next) => {
  try {
    // Newest run first, then the order the generator returned within that run —
    // for the existing-business path, position 0 is the verdict on their business.
    const [{ data: ideas }, runs, finishedRuns] = await Promise.all([
      req.sb.from('generated_ideas').select('*').eq('user_id', req.user.id)
        .order('created_at', { ascending: false }).order('position', { ascending: true }),
      qs.all(req.sb, req.user.id),
      qs.completedCount(req.sb, req.user.id)
    ]);
    const runMap = {};
    runs.forEach(r => { runMap[r.id] = r; });
    const groups = [];
    const byRun = {};
    (ideas || []).forEach(i => {
      const key = i.questionnaire_id || 'unlinked';
      if (!byRun[key]) {
        const run = runMap[i.questionnaire_id] || null;
        byRun[key] = {
          key,
          runNumber: run ? run.run_number : null,
          pathLabel: run ? (PATH_LABELS[run.founder_path] || '') : '',
          date: i.created_at,
          ideas: []
        };
        groups.push(byRun[key]);
      }
      byRun[key].ideas.push(i);
    });
    res.render('ideas', {
      title: 'Your Business Ideas', ideas: ideas || [], groups,
      showRunHeadings: groups.length > 1,
      hasQuestionnaire: finishedRuns > 0, aiReady: ai.hasKey()
    });
  } catch (e) { next(e); }
});

router.get('/generate', async (req, res, next) => {
  try {
    const q = await qs.latestCompleted(req.sb, req.user.id);
    if (!q) return res.redirect('/questionnaire');
    const path = ai.pathOf(q);
    res.render('generating', {
      title: 'Generating ideas', action: '/ideas/generate',
      label: GENERATING_LABELS[path], steps: IDEA_STEPS[path]
    });
  } catch (e) { next(e); }
});

// Runs in the background after the POST responds with a job id, so the HTTP
// request never outlives the host proxy's timeout during long AI generations.
async function runIdeaGeneration(req, q, plan, jobId) {
  const sb = req.sb;
  const path = ai.pathOf(q);
  const patchJob = patch => sb.from('generation_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', jobId)
    .then(() => {}, e => console.error('job update', e && e.message));
  const finish = patchJob;
  // Reported as each step actually begins, so the progress bar reflects real work
  // rather than a timer. Failing to write progress must never fail the generation.
  const report = (stage, progress, label) =>
    patchJob({ stage, progress, stage_label: label || stepLabel(path, stage) });

  try {
    await report('queued', FLOORS.queued);
    // Two calls rather than one: a short web-search pass, then generation with
    // those findings pasted in. A single search-enabled generation ran ~150s and
    // got killed at the edge function's request limit. If the scan fails we push
    // on without it — an ungrounded set of ideas beats no ideas at all.
    let scan = null;
    let scanFailed = false;
    if (path !== 'exploring') {
      await report('scan', FLOORS.scan);
      try {
        scan = await ai.marketScan(req.accessToken, q);
      } catch (err) { scanFailed = true; console.error('market scan', err && err.message); }
    }
    await report('generate', path === 'exploring' ? FLOORS.generateNoScan : FLOORS.generate,
      scanFailed ? 'Live market data was unavailable — generating from your profile instead…' : null);
    const ideas = await ai.generateIdeas(req.accessToken, q, { scan });
    await report('save', FLOORS.save);
    const { count } = await sb.from('generated_ideas').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
    const rows = ideas.slice(0, 6).map((i, idx) => ({
      user_id: req.user.id, questionnaire_id: q.id,
      name: String(i.name || 'Untitled idea'), tagline: i.tagline || '', category: i.category || '',
      profile_summary: i.profile_summary || '', why_you: i.why_you || '',
      market_analysis: i.market_analysis || '', competitor_landscape: i.competitor_landscape || '',
      competitors: cleanCompetitors(i.competitors),
      success_likelihood: Math.min(100, parseInt(i.success_likelihood, 10) || 50),
      demand_score: Math.min(10, parseInt(i.demand_score, 10) || 5),
      passion_score: Math.min(10, parseInt(i.passion_score, 10) || 5),
      time_to_revenue: i.time_to_revenue || '', startup_cost_lean: i.startup_cost_lean || '',
      startup_cost_standard: i.startup_cost_standard || '', startup_cost_full: i.startup_cost_full || '',
      legal_nuances: i.legal_nuances || '', first_steps: i.first_steps || '',
      status: 'active', position: (count || 0) + idx
    }));
    const { data: inserted, error } = await sb.from('generated_ideas').insert(rows).select('id');
    if (error) throw error;
    await awardXP(sb, req.user.id, req.profile, 25, 'Generated business ideas', 'generated_ideas', null);
    await sb.from('profiles').update({ generations_used: (req.profile.generations_used || 0) + 1 }).eq('id', req.user.id);
    // Auto-disperse the top idea's first steps into the task board with staggered deadlines (paid feature)
    try {
      const top = rows[0];
      if (plan === 'paid' && top && top.first_steps) {
        // Reuse a list of the same name rather than stacking a fresh duplicate on
        // every regeneration — that is what filled the board with repeats.
        const listName = ('Idea: ' + top.name).slice(0, 60);
        const { data: found } = await sb.from('task_lists').select('id')
          .eq('user_id', req.user.id).eq('name', listName).limit(1);
        let list = found && found[0];
        if (!list) {
          const { data: made } = await sb.from('task_lists')
            .insert({ user_id: req.user.id, name: listName, color: '#10b981' }).select('id').maybeSingle();
          list = made;
        }
        const steps = String(top.first_steps).split(/\n+/).map(t => t.replace(/^\s*\d+[).:-]?\s*/, '').trim()).filter(t => t.length > 3).slice(0, 7);
        const taskRows = steps.map((title, i) => ({
          user_id: req.user.id, list_id: list ? list.id : null, title: title.slice(0, 200),
          description: 'First step for "' + top.name + '" — generated by NoBossly AI.',
          priority: i === 0 ? 'high' : 'medium', status: 'todo', position: i, labels: ['idea'],
          due_date: new Date(Date.now() + (i + 1) * 3 * 86400000).toISOString().slice(0, 10)
        }));
        if (taskRows.length) await sb.from('tasks').insert(taskRows);
        await sb.rpc('push_notification', { target_user: req.user.id, ntype: 'tasks', nmessage: 'Your idea "' + top.name + '" was broken into ' + taskRows.length + ' tasks with deadlines — check your Tasks board.', nentity_type: null, nentity_id: null }).then(() => {}, () => {});
      }
    } catch (e2) { console.error('task dispersal', e2.message); }
    // Auto-gather live demand signals for the top idea (paid feature). Fire-and-forget:
    // never blocks job completion, never fails the generation.
    try {
      if (plan === 'paid' && inserted && inserted.length) {
        const topId = inserted[0].id;
        const token = req.accessToken, uid = req.user.id;
        (async () => {
          try {
            const { data: created } = await sb.from('generated_ideas').select('*').eq('id', topId).eq('user_id', uid).maybeSingle();
            if (created && !created.demand_evidence) {
              const ev = await ai.demandEvidence(token, created);
              if (ev && Array.isArray(ev.signals)) {
                await sb.from('generated_ideas').update({ demand_evidence: ev, evidence_at: new Date().toISOString() }).eq('id', topId);
                await sb.rpc('push_notification', { target_user: uid, ntype: 'ideas', nmessage: 'Live demand signals are ready for "' + created.name + '" — open the idea to see the evidence.', nentity_type: null, nentity_id: null }).then(() => {}, () => {});
              }
            }
          } catch (err) { console.error('auto demand evidence', err.message); }
        })();
      }
    } catch (e3) { console.error('auto evidence setup', e3.message); }
    await finish({ status: 'done', progress: 100, stage: 'done', redirect: '/ideas' });
  } catch (e) {
    console.error('idea generation', e);
    await finish({ status: 'error', error: 'Idea generation failed: ' + e.message });
  }
}

router.post('/generate', async (req, res) => {
  try {
    const q = await qs.latestCompleted(req.sb, req.user.id);
    if (!q) return res.json({ redirect: '/questionnaire' });
    const plan = planOf(req.profile);
    if (plan === 'free' && (req.profile.generations_used || 0) >= 1) {
      return gateJson(res, 'extra_generation');
    }
    const { data: job, error: jobErr } = await req.sb.from('generation_jobs')
      .insert({ user_id: req.user.id, kind: 'ideas' }).select('id').maybeSingle();
    if (jobErr || !job) throw (jobErr || new Error('could not create generation job'));
    res.json({ job: job.id });
    runIdeaGeneration(req, q, plan, job.id);
  } catch (e) {
    console.error('idea generation start', e);
    res.json({ error: 'Idea generation failed to start: ' + e.message });
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { data: idea } = await req.sb.from('generated_ideas').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.redirect('/ideas');
    const { data: bp } = await req.sb.from('blueprints').select('id').eq('idea_id', idea.id).eq('user_id', req.user.id).maybeSingle();
    res.render('idea_detail', { title: idea.name, idea, blueprintId: bp ? bp.id : null, plan: planOf(req.profile), msg: req.query.msg || null });
  } catch (e) { next(e); }
});

// Gather live demand signals for one idea (paid). Regular form POST — the button
// disables itself client-side while the ~20-30s search runs, then we redirect back.
router.post('/:id/evidence', async (req, res, next) => {
  try {
    if (planOf(req.profile) !== 'paid') return gate(res, 'demand_evidence');
    const { data: idea } = await req.sb.from('generated_ideas').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.redirect('/ideas');
    try {
      const ev = await ai.demandEvidence(req.accessToken, idea);
      if (!ev || !Array.isArray(ev.signals)) throw new Error('no signals returned');
      await req.sb.from('generated_ideas').update({ demand_evidence: ev, evidence_at: new Date().toISOString() }).eq('id', idea.id);
    } catch (err) {
      return res.redirect('/ideas/' + idea.id + '?msg=' + encodeURIComponent('Could not gather demand signals — please try again. (' + err.message + ')'));
    }
    res.redirect('/ideas/' + idea.id);
  } catch (e) { next(e); }
});

router.post('/:id/favorite', async (req, res) => {
  const { data: idea } = await req.sb.from('generated_ideas').select('is_favorited').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
  if (idea) await req.sb.from('generated_ideas').update({ is_favorited: !idea.is_favorited }).eq('id', req.params.id);
  // Same-origin only — never bounce the founder off-site on the strength of a
  // header someone else's page can set.
  const ref = req.get('referer') || '';
  const sameOrigin = ref.startsWith(req.protocol + '://' + req.get('host') + '/');
  res.redirect(sameOrigin ? ref : '/ideas');
});

module.exports = router;
