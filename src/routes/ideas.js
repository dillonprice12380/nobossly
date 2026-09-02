const router = require('express').Router();
const { planOf } = require('../middleware/auth');
const { gate } = require('../upgrade');
const ai = require('../ai');
const qs = require('../questionnaires');

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
