const router = require('express').Router();
const ai = require('../ai');
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');
const { planOf } = require('../middleware/auth');
const { sweepMilestones } = require('../milestones_engine');

const isPaid = req => planOf(req.profile) === 'paid';

// The trophy case. Trophies are earned automatically by playing — completing
// tasks, finishing challenges, keeping streaks — never by clicking a claim
// button. Every visit runs a sweep first, so whatever the founder just did is
// already reflected when the page renders.
router.get('/', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    let fresh = [], metrics = {};
    try { ({ fresh, metrics } = await sweepMilestones(req.sb, req.user.id, req.profile, paid)); }
    catch (e) { console.error('milestone sweep', e); }

    const [{ data: defs }, { data: mine }, { data: badges }, { data: custom }] = await Promise.all([
      req.sb.from('predefined_milestones').select('*').order('position'),
      req.sb.from('user_milestones').select('predefined_milestone_id, earned_at').eq('user_id', req.user.id),
      req.sb.from('badges').select('id, name, emoji, tier'),
      req.sb.from('user_custom_milestones').select('*').eq('user_id', req.user.id).order('created_at')
    ]);
    const earned = {};
    (mine || []).forEach(m => earned[m.predefined_milestone_id] = m);
    const badgeMap = {};
    (badges || []).forEach(b => badgeMap[b.id] = b);

    // Active trophies group by category; retired definitions (no measurable
    // criterion any more) still display if this founder earned them back then.
    const cats = {};
    const legacy = [];
    (defs || []).forEach(d => {
      if (d.is_active && d.auto_kind) (cats[d.category] = cats[d.category] || []).push(d);
      else if (earned[d.id]) legacy.push(d);
    });
    const earnedCount = (defs || []).filter(d => earned[d.id]).length;

    res.render('milestones', {
      title: 'Milestones', cats, earned, badgeMap, metrics, fresh, legacy, earnedCount,
      paid, custom: custom || [], msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// Manual claiming is retired. Old cached pages may still POST here — just
// bounce back to the trophy case, where the sweep tells the truth.
router.post('/:id/achieve', (req, res) => res.redirect('/milestones'));

// Generate an AI-tailored set of personal goals from the founder's active blueprint (paid only).
router.post('/generate', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('user_id', req.user.id).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bp) return res.redirect('/milestones?msg=' + encodeURIComponent('Create a launch blueprint first, then I can tailor goals to it.'));
    let items;
    try { items = await ai.generateMilestones(req.accessToken, bp); }
    catch (err) { return res.redirect('/milestones?msg=' + encodeURIComponent('Could not generate goals: ' + err.message)); }
    if (!Array.isArray(items) || !items.length) return res.redirect('/milestones?msg=' + encodeURIComponent('No goals were generated \u2014 please try again.'));
    // Replace any not-yet-achieved AI goals with the fresh set; keep achieved ones.
    await req.sb.from('user_custom_milestones').delete().eq('user_id', req.user.id).eq('achieved', false);
    const rows = items.slice(0, 10).map(m => ({
      user_id: req.user.id, blueprint_id: bp.id,
      title: String(m.title || 'Milestone').slice(0, 120),
      description: String(m.description || '').slice(0, 400),
      emoji: String(m.emoji || '\ud83c\udfaf').slice(0, 8),
      category: String(m.category || 'Tailored').slice(0, 40),
      xp_reward: Math.max(10, Math.min(200, parseInt(m.xp_reward, 10) || 50))
    }));
    await req.sb.from('user_custom_milestones').insert(rows);
    res.redirect('/milestones?msg=' + encodeURIComponent('Your AI-tailored goals are ready.'));
  } catch (e) { next(e); }
});

// Achieve an AI-tailored personal goal (paid). These are the founder's own
// self-tracked goals — distinct from trophies, which only the engine awards.
router.post('/custom/:id/achieve', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: m } = await req.sb.from('user_custom_milestones').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (m && !m.achieved) {
      await req.sb.from('user_custom_milestones').update({
        achieved: true, date_achieved: new Date().toISOString().slice(0, 10), achieved_at: new Date().toISOString()
      }).eq('id', m.id);
      await awardXP(req.sb, req.user.id, req.profile, m.xp_reward || 50, 'Goal: ' + m.title, 'user_custom_milestones', m.id);
      await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' achieved the goal ' + (m.emoji || '\ud83c\udfc6') + ' \u201c' + m.title + '\u201d', 'user_custom_milestones', m.id);
    }
    res.redirect('/milestones');
  } catch (e) { next(e); }
});

module.exports = router;
