const router = require('express').Router();
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');

router.get('/', async (req, res, next) => {
  try {
    const [{ data: challenges }, { data: acc }] = await Promise.all([
      req.sb.from('challenges').select('*').eq('is_active', true).order('position'),
      req.sb.from('challenge_acceptances').select('*').eq('user_id', req.user.id)
    ]);
    const accMap = {};
    (acc || []).forEach(a => accMap[a.challenge_id] = a);
    res.render('challenges', { title: 'Challenges', challenges: challenges || [], accMap });
  } catch (e) { next(e); }
});

router.post('/:id/accept', async (req, res, next) => {
  try {
    const duration = [30, 60, 90].includes(parseInt(req.body.duration_days, 10)) ? parseInt(req.body.duration_days, 10) : 30;
    const { data: ch } = await req.sb.from('challenges').select('id, title').eq('id', req.params.id).maybeSingle();
    if (ch) {
      const due = new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10);
      const { data: existing } = await req.sb.from('challenge_acceptances').select('id, status').eq('user_id', req.user.id).eq('challenge_id', ch.id).maybeSingle();
      if (existing) {
        if (existing.status === 'completed') return res.redirect('/challenges');
        await req.sb.from('challenge_acceptances').update({ status: 'active', duration_days: duration, due_date: due, accepted_at: new Date().toISOString(), completed_at: null }).eq('id', existing.id);
      } else {
        await req.sb.from('challenge_acceptances').insert({ user_id: req.user.id, challenge_id: ch.id, duration_days: duration, due_date: due });
      }
      await awardXP(req.sb, req.user.id, req.profile, 5, 'Accepted challenge: ' + ch.title, 'challenges', ch.id);
      await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' took on the challenge \u201C' + ch.title + '\u201D', 'challenges', ch.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

router.post('/:id/finish', async (req, res, next) => {
  try {
    const { data: a } = await req.sb.from('challenge_acceptances').select('*').eq('challenge_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (a && a.status === 'active') {
      await req.sb.from('challenge_acceptances').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', a.id);
      const { data: ch } = await req.sb.from('challenges').select('*').eq('id', a.challenge_id).maybeSingle();
      const { data: existing } = await req.sb.from('challenge_completions').select('id').eq('user_id', req.user.id).eq('challenge_id', a.challenge_id).maybeSingle();
      if (!existing) await req.sb.from('challenge_completions').insert({ user_id: req.user.id, challenge_id: a.challenge_id, proof_note: req.body.proof_note || '' });
      if (ch) {
        await awardXP(req.sb, req.user.id, req.profile, ch.xp_reward || 50, 'Completed challenge: ' + ch.title, 'challenges', ch.id);
        await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' completed the challenge \u201C' + ch.title + '\u201D \uD83C\uDF89', 'challenges', ch.id);
        if (ch.badge_id) {
          const { data: hasBadge } = await req.sb.from('user_badges').select('id').eq('user_id', req.user.id).eq('badge_id', ch.badge_id).maybeSingle();
          if (!hasBadge) {
            await req.sb.from('user_badges').insert({ user_id: req.user.id, badge_id: ch.badge_id });
            const { data: bdg } = await req.sb.from('badges').select('name, emoji').eq('id', ch.badge_id).maybeSingle();
            if (bdg) await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A founder') + ' earned the ' + bdg.emoji + ' \u201C' + bdg.name + '\u201D badge', 'badges', ch.badge_id);
          }
        }
      }
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

router.post('/:id/abandon', async (req, res, next) => {
  try {
    await req.sb.from('challenge_acceptances').update({ status: 'abandoned' }).eq('challenge_id', req.params.id).eq('user_id', req.user.id);
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

module.exports = router;
