const router = require('express').Router();
const ai = require('../ai');
const { awardXP } = require('../xp');
const { planOf } = require('../middleware/auth');

const clampXP = v => Math.max(10, Math.min(200, parseInt(v, 10) || 50));
const okDays = v => [30, 60, 90].includes(parseInt(v, 10)) ? parseInt(v, 10) : 30;

// Paid founders get an AI-tailored set of milestones & challenges built from their
// blueprint. Runs in the background after the blueprint response so it never blocks
// or fails blueprint creation; the results appear on the Milestones/Challenges pages.
async function generateTailoredSets(req, bp) {
  const [ms, chs] = await Promise.all([
    ai.generateMilestones(req.accessToken, bp).catch(() => null),
    ai.generateChallenges(req.accessToken, bp).catch(() => null)
  ]);
  if (Array.isArray(ms) && ms.length) {
    await req.sb.from('user_custom_milestones').delete().eq('user_id', req.user.id).eq('achieved', false);
    await req.sb.from('user_custom_milestones').insert(ms.slice(0, 10).map(m => ({
      user_id: req.user.id, blueprint_id: bp.id,
      title: String(m.title || 'Milestone').slice(0, 120), description: String(m.description || '').slice(0, 400),
      emoji: String(m.emoji || '🎯').slice(0, 8), category: String(m.category || 'Tailored').slice(0, 40),
      xp_reward: clampXP(m.xp_reward)
    })));
  }
  if (Array.isArray(chs) && chs.length) {
    await req.sb.from('user_custom_challenges').delete().eq('user_id', req.user.id).in('status', ['pending', 'abandoned']);
    await req.sb.from('user_custom_challenges').insert(chs.slice(0, 10).map(c => ({
      user_id: req.user.id, blueprint_id: bp.id,
      title: String(c.title || 'Challenge').slice(0, 120), description: String(c.description || '').slice(0, 400),
      emoji: String(c.emoji || '🏁').slice(0, 8), suggested_days: okDays(c.suggested_days),
      xp_reward: clampXP(c.xp_reward)
    })));
  }
}

router.get('/start/:ideaId', async (req, res, next) => {
  try {
    const { data: idea } = await req.sb.from('generated_ideas').select('*').eq('id', req.params.ideaId).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.redirect('/ideas');
    const { data: existing } = await req.sb.from('blueprints').select('id').eq('idea_id', idea.id).eq('user_id', req.user.id).maybeSingle();
    if (existing) return res.redirect('/blueprint/' + existing.id);
    // Free founders can create ONE blueprint; paid is unlimited.
    if (planOf(req.profile) !== 'paid') {
      const { count } = await req.sb.from('blueprints').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
      if ((count || 0) >= 1) return res.redirect('/pricing?upgrade=1');
    }
    res.render('generating', { title: 'Building blueprint', action: '/blueprint/start/' + idea.id, label: 'Building your launch blueprint for "' + idea.name + '"…' });
  } catch (e) { next(e); }
});

router.post('/start/:ideaId', async (req, res) => {
  try {
    const { data: idea } = await req.sb.from('generated_ideas').select('*').eq('id', req.params.ideaId).eq('user_id', req.user.id).maybeSingle();
    if (!idea) return res.json({ redirect: '/ideas' });
    const { data: dupe } = await req.sb.from('blueprints').select('id').eq('idea_id', idea.id).eq('user_id', req.user.id).maybeSingle();
    if (dupe) return res.json({ redirect: '/blueprint/' + dupe.id });
    // Free founders can create ONE blueprint; paid is unlimited.
    if (planOf(req.profile) !== 'paid') {
      const { count } = await req.sb.from('blueprints').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
      if ((count || 0) >= 1) return res.json({ redirect: '/pricing?upgrade=1' });
    }

    const { data: q } = await req.sb.from('questionnaire_responses').select('*').eq('user_id', req.user.id).maybeSingle();

    const bp = await ai.generateBlueprint(req.accessToken, idea, q || {});
    const row = {
      user_id: req.user.id, idea_id: idea.id,
      business_name: bp.business_name || idea.name, tagline: bp.tagline || idea.tagline,
      positioning: bp.positioning || '', elevator_pitch: bp.elevator_pitch || '',
      icp_archetype: bp.icp_archetype || '', icp_description: bp.icp_description || '',
      icp_demographics: bp.icp_demographics || [], icp_motivations: bp.icp_motivations || [],
      icp_pain_points: bp.icp_pain_points || [], icp_watering_holes: bp.icp_watering_holes || [],
      revenue_type: bp.revenue_type || '', revenue_rationale: bp.revenue_rationale || '',
      pricing_tiers: bp.pricing_tiers || [],
      projection_month3: bp.projection_month3 || '', projection_month6: bp.projection_month6 || '', projection_month12: bp.projection_month12 || '',
      differentiators: bp.differentiators || [], roadmap_summary: bp.roadmap_summary || '',
      gtm_strategy: bp.gtm_strategy || '', gtm_first_customer: bp.gtm_first_customer || '',
      gtm_channels: bp.gtm_channels || [], gtm_week1_actions: bp.gtm_week1_actions || [],
      is_active: true
    };
    const { data: created, error } = await req.sb.from('blueprints').insert(row).select().maybeSingle();
    if (error) throw error;
    await req.sb.from('generated_ideas').update({ status: 'converted' }).eq('id', idea.id);
    await awardXP(req.sb, req.user.id, req.profile, 50, 'Created a launch blueprint', 'blueprints', created.id);
    res.json({ redirect: '/blueprint/' + created.id });
    if (planOf(req.profile) === 'paid') {
      generateTailoredSets(req, created).catch(e => console.error('tailored gen', e && e.message));
    }
  } catch (e) {
    console.error('blueprint generation', e);
    res.json({ error: 'Blueprint generation failed: ' + e.message });
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!bp) return res.redirect('/ideas');
    const { data: sprint } = await req.sb.from('sprints').select('id').eq('blueprint_id', bp.id).eq('user_id', req.user.id).limit(1).maybeSingle();
    res.render('blueprint', { title: bp.business_name, bp, hasSprint: !!sprint });
  } catch (e) { next(e); }
});

module.exports = router;
