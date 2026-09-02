const router = require('express').Router();
const { planOf } = require('../middleware/auth');
const { gate } = require('../upgrade');
const ai = require('../ai');
const qs = require('../questionnaires');
const { sweepMilestones } = require('../milestones_engine');

// This page used to be the AI idea generator: answer a questionnaire, receive
// six business ideas, pick one. That is retired. The beginning of NoBossly is
// the Founder Compass, and the only ideas that land here now are ones the
// founder drafted themselves and ran past the Compass advisor (/compass/draft).
//
// The route survives because those drafts need somewhere to live, be reviewed
// and be turned into a blueprint.

const PATH_LABELS = {
  existing: 'Already in business',
  idea: 'Started from an idea',
  exploring: 'Started from a blank page'
};

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
      title: 'Your ideas', ideas: ideas || [], groups,
      showRunHeadings: groups.length > 1,
      hasQuestionnaire: finishedRuns > 0, aiReady: ai.hasKey()
    });
  } catch (e) { next(e); }
});

// Old links and cached clients still ask for the retired generator. Without
// this they fall through to /:id below and only redirect by accident, because
// "generate" fails to parse as a uuid. Say what actually happened instead.
router.get('/generate', (req, res) => res.redirect(
  '/compass?msg=' + encodeURIComponent('NoBossly no longer generates ideas for you \u2014 you draft yours here, and the advisor stress-tests it.')));
router.post('/generate', (req, res) => res.json({ redirect: '/compass' }));

router.get('/:id', async (req, res, next) => {
  try {
    const { data: idea } = await req.sb.from('generated_ideas').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.redirect('/ideas');
    const [{ data: bp }, { data: versions }, { data: signals }] = await Promise.all([
      req.sb.from('blueprints').select('id').eq('idea_id', idea.id).eq('user_id', req.user.id).maybeSingle(),
      // Oldest first: the score trajectory only reads as progress in the order
      // it actually happened.
      req.sb.from('idea_versions').select('version_no, fit_passed, fit_total, success_likelihood, created_at')
        .eq('idea_id', idea.id).eq('user_id', req.user.id).order('version_no'),
      req.sb.from('idea_signals').select('*').eq('idea_id', idea.id).eq('user_id', req.user.id).order('created_at')
    ]);
    res.render('idea_detail', {
      title: idea.name, idea, blueprintId: bp ? bp.id : null, plan: planOf(req.profile),
      msg: req.query.msg || null,
      versions: versions || [],
      signals: signals || [],
      founderSignals: (signals || []).filter(x => x.source === 'founder').length
    });
  } catch (e) { next(e); }
});

// A signal the founder found themselves. AI search evidence is free and teaches
// nothing on its own — the Level 1 quest needs at least one the founder went and
// dug up, which is why source is recorded rather than assumed.
router.post('/:id/signals', async (req, res, next) => {
  try {
    const { data: idea } = await req.sb.from('generated_ideas').select('id').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.redirect('/ideas');
    const b = req.body || {};
    const t = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
    const claim = t(b.claim, 500);
    if (!claim) return res.redirect('/ideas/' + idea.id + '?msg=' + encodeURIComponent('Say what the signal actually shows.'));
    const url = t(b.url, 500);
    // Only http(s) links, and never rendered as a link unless it parses — a
    // javascript: url in a founder's own note is still a stored payload.
    const safeUrl = /^https?:\/\//i.test(url) ? url : null;
    const strength = ['strong', 'moderate', 'weak'].includes(b.strength) ? b.strength : 'moderate';
    await req.sb.from('idea_signals').insert({
      idea_id: idea.id, user_id: req.user.id, source: 'founder',
      claim, url: safeUrl, strength
    });
    try { await sweepMilestones(req.sb, req.user.id, req.profile, res.locals.plan === 'paid'); } catch (_) {}
    res.redirect('/ideas/' + idea.id);
  } catch (e) { next(e); }
});

router.post('/:id/signals/:signalId/delete', async (req, res, next) => {
  try {
    await req.sb.from('idea_signals').delete().eq('id', req.params.signalId).eq('user_id', req.user.id);
    res.redirect('/ideas/' + req.params.id);
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
      // Mirror the search results into idea_signals so they count toward the
      // Level 1 evidence quest alongside the founder's own. Replacing the
      // previous AI rows rather than appending keeps a refresh from inflating
      // the count with the same findings twice.
      await req.sb.from('idea_signals').delete().eq('idea_id', idea.id).eq('user_id', req.user.id).eq('source', 'ai');
      const t = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
      const rows = ev.signals.slice(0, 6).map(sig => ({
        idea_id: idea.id, user_id: req.user.id, source: 'ai',
        claim: t(sig && sig.claim, 500) || t(sig && sig.source, 500),
        url: /^https?:\/\//i.test(String((sig && sig.url) || '')) ? t(sig.url, 500) : null,
        strength: ['strong', 'moderate', 'weak'].includes(sig && sig.strength) ? sig.strength : 'moderate'
      })).filter(r => r.claim);
      if (rows.length) await req.sb.from('idea_signals').insert(rows);
      try { await sweepMilestones(req.sb, req.user.id, req.profile, res.locals.plan === 'paid'); } catch (_) {}
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
