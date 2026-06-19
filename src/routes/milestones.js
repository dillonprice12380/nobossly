const router = require('express').Router();
const ai = require('../ai');
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');
const { planOf } = require('../middleware/auth');

const isPaid = req => planOf(req.profile) === 'paid';

router.get('/', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    const [{ data: defs }, { data: mine }, { data: badges }, { data: custom }] = await Promise.all([
      req.sb.from('predefined_milestones').select('*').eq('is_active', true).order('position'),
      req.sb.from('user_milestones').select('predefined_milestone_id, earned_at').eq('user_id', req.user.id),
      req.sb.from('badges').select('id, name, emoji, tier'),
      req.sb.from('user_custom_milestones').select('*').eq('user_id', req.user.id).order('created_at')
    ]);
    const earned = {};
    (mine || []).forEach(m => earned[m.predefined_milestone_id] = m);
    const badgeMap = {};
    (badges || []).forEach(b => badgeMap[b.id] = b);
    const cats = {};
    (defs || []).forEach(d => { (cats[d.category] = cats[d.category] || []).push(d); });
    res.render('milestones', {
      title: 'Milestones', cats, earned, badgeMap,
      paid, custom: custom || [], msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// Achieve a pre-chosen milestone. Free users record it for personal tracking and
// earn XP, but it does NOT pin to their public profile, post to the community, or
// grant a badge — those are paid-only rewards.
router.post('/:id/achieve', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    const { data: def } = await req.sb.from('predefined_milestones').select('*').eq('id', req.params.id).maybeSingle();
    if (def) {
      const { data: existing } = await req.sb.from('user_milestones').select('id').eq('user_id', req.user.id).eq('predefined_milestone_id', def.id).maybeSingle();
      if (!existing) {
        await req.sb.from('user_milestones').insert({
          user_id: req.user.id, predefined_milestone_id: def.id, emoji: def.emoji,
          date_achieved: new Date().toISOString().slice(0, 10), pinned: paid
        });
        await awardXP(req.sb, req.user.id, req.profile, def.xp_reward || 50, 'Milestone: ' + def.title, 'predefined_milestones', def.id);
        if (paid) {
          await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' achieved the milestone ' + (def.emoji || '🏆') + ' “' + def.title + '”', 'predefined_milestones', def.id);
          if (def.badge_id) {
            const { data: hasBadge } = await req.sb.from('user_badges').select('id').eq('user_id', req.user.id).eq('badge_id', def.badge_id).maybeSingle();
            if (!hasBadge) {
              await req.sb.from('user_badges').insert({ user_id: req.user.id, badge_id: def.badge_id });
              const { data: b } = await req.sb.from('badges').select('name, emoji').eq('id', def.badge_id).maybeSingle();
              if (b) {
                await req.sb.rpc('push_notification', { target_user: req.user.id, ntype: 'badge', nmessage: 'You earned the ' + b.emoji + ' "' + b.name + '" badge!', nentity_type: 'badges', nentity_id: def.badge_id }).then(() => {}, () => {});
                await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' earned the ' + b.emoji + ' “' + b.name + '” badge', 'badges', def.badge_id);
              }
            }
          }
        }
      }
    }
    res.redirect('/milestones');
  } catch (e) { next(e); }
});

// Generate an AI-tailored set of milestones from the founder's active blueprint (paid only).
router.post('/generate', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('user_id', req.user.id).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bp) return res.redirect('/milestones?msg=' + encodeURIComponent('Create a launch blueprint first, then I can tailor milestones to it.'));
    let items;
    try { items = await ai.generateMilestones(req.accessToken, bp); }
    catch (err) { return res.redirect('/milestones?msg=' + encodeURIComponent('Could not generate milestones: ' + err.message)); }
    if (!Array.isArray(items) || !items.length) return res.redirect('/milestones?msg=' + encodeURIComponent('No milestones were generated — please try again.'));
    // Replace any not-yet-achieved AI milestones with the fresh set; keep achieved ones.
    await req.sb.from('user_custom_milestones').delete().eq('user_id', req.user.id).eq('achieved', false);
    const rows = items.slice(0, 10).map(m => ({
      user_id: req.user.id, blueprint_id: bp.id,
      title: String(m.title || 'Milestone').slice(0, 120),
      description: String(m.description || '').slice(0, 400),
      emoji: String(m.emoji || '🎯').slice(0, 8),
      category: String(m.category || 'Tailored').slice(0, 40),
      xp_reward: Math.max(10, Math.min(200, parseInt(m.xp_reward, 10) || 50))
    }));
    await req.sb.from('user_custom_milestones').insert(rows);
    res.redirect('/milestones?msg=' + encodeURIComponent('Your AI-tailored milestones are ready.'));
  } catch (e) { next(e); }
});

// Achieve an AI-tailored milestone (paid). Pins to profile + posts + XP.
router.post('/custom/:id/achieve', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: m } = await req.sb.from('user_custom_milestones').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (m && !m.achieved) {
      await req.sb.from('user_custom_milestones').update({
        achieved: true, date_achieved: new Date().toISOString().slice(0, 10), achieved_at: new Date().toISOString()
      }).eq('id', m.id);
      await awardXP(req.sb, req.user.id, req.profile, m.xp_reward || 50, 'Milestone: ' + m.title, 'user_custom_milestones', m.id);
      await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' achieved the milestone ' + (m.emoji || '🏆') + ' “' + m.title + '”', 'user_custom_milestones', m.id);
    }
    res.redirect('/milestones');
  } catch (e) { next(e); }
});

module.exports = router;
