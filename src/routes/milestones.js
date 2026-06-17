const router = require('express').Router();
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');

router.get('/', async (req, res, next) => {
  try {
    const [{ data: defs }, { data: mine }, { data: badges }] = await Promise.all([
      req.sb.from('predefined_milestones').select('*').eq('is_active', true).order('position'),
      req.sb.from('user_milestones').select('predefined_milestone_id, earned_at').eq('user_id', req.user.id),
      req.sb.from('badges').select('id, name, emoji, tier')
    ]);
    const earned = {};
    (mine || []).forEach(m => earned[m.predefined_milestone_id] = m);
    const badgeMap = {};
    (badges || []).forEach(b => badgeMap[b.id] = b);
    const cats = {};
    (defs || []).forEach(d => { (cats[d.category] = cats[d.category] || []).push(d); });
    res.render('milestones', { title: 'Milestones', cats, earned, badgeMap });
  } catch (e) { next(e); }
});

router.post('/:id/achieve', async (req, res, next) => {
  try {
    const { data: def } = await req.sb.from('predefined_milestones').select('*').eq('id', req.params.id).maybeSingle();
    if (def) {
      const { data: existing } = await req.sb.from('user_milestones').select('id').eq('user_id', req.user.id).eq('predefined_milestone_id', def.id).maybeSingle();
      if (!existing) {
        await req.sb.from('user_milestones').insert({
          user_id: req.user.id, predefined_milestone_id: def.id, emoji: def.emoji,
          date_achieved: new Date().toISOString().slice(0, 10)
        });
        await awardXP(req.sb, req.user.id, req.profile, def.xp_reward || 50, 'Milestone: ' + def.title, 'predefined_milestones', def.id);
        await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' achieved the milestone ' + (def.emoji || '\uD83C\uDFC6') + ' \u201C' + def.title + '\u201D', 'predefined_milestones', def.id);
        if (def.badge_id) {
          const { data: hasBadge } = await req.sb.from('user_badges').select('id').eq('user_id', req.user.id).eq('badge_id', def.badge_id).maybeSingle();
          if (!hasBadge) {
            await req.sb.from('user_badges').insert({ user_id: req.user.id, badge_id: def.badge_id });
            const { data: b } = await req.sb.from('badges').select('name, emoji').eq('id', def.badge_id).maybeSingle();
            if (b) {
              await req.sb.rpc('push_notification', { target_user: req.user.id, ntype: 'badge', nmessage: 'You earned the ' + b.emoji + ' "' + b.name + '" badge!', nentity_type: 'badges', nentity_id: def.badge_id }).then(() => {}, () => {});
              await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' earned the ' + b.emoji + ' \u201C' + b.name + '\u201D badge', 'badges', def.badge_id);
            }
          }
        }
      }
    }
    res.redirect('/milestones');
  } catch (e) { next(e); }
});

module.exports = router;
