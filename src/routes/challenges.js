const router = require('express').Router();
const ai = require('../ai');
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');
const { planOf } = require('../middleware/auth');

const isPaid = req => planOf(req.profile) === 'paid';
const nameOf = req => (req.profile.display_name || req.profile.username || 'A founder');
const cleanDuration = v => [30, 60, 90].includes(parseInt(v, 10)) ? parseInt(v, 10) : 30;

router.get('/', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    const [{ data: challenges }, { data: acc }, { data: custom }] = await Promise.all([
      req.sb.from('challenges').select('*').eq('is_active', true).order('position'),
      req.sb.from('challenge_acceptances').select('*').eq('user_id', req.user.id),
      req.sb.from('user_custom_challenges').select('*').eq('user_id', req.user.id).order('created_at')
    ]);
    const accMap = {};
    (acc || []).forEach(a => accMap[a.challenge_id] = a);
    res.render('challenges', {
      title: 'Challenges', challenges: challenges || [], accMap,
      paid, custom: custom || [], msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/:id/accept', async (req, res, next) => {
  try {
    const duration = cleanDuration(req.body.duration_days);
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
      if (isPaid(req)) await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the challenge “' + ch.title + '”', 'challenges', ch.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

// Finish a pre-chosen challenge. Free users earn XP + a personal completion record;
// the community post and profile badge are paid-only.
router.post('/:id/finish', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    const { data: a } = await req.sb.from('challenge_acceptances').select('*').eq('challenge_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (a && a.status === 'active') {
      await req.sb.from('challenge_acceptances').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', a.id);
      const { data: ch } = await req.sb.from('challenges').select('*').eq('id', a.challenge_id).maybeSingle();
      const { data: existing } = await req.sb.from('challenge_completions').select('id').eq('user_id', req.user.id).eq('challenge_id', a.challenge_id).maybeSingle();
      if (!existing) await req.sb.from('challenge_completions').insert({ user_id: req.user.id, challenge_id: a.challenge_id, proof_note: req.body.proof_note || '' });
      if (ch) {
        await awardXP(req.sb, req.user.id, req.profile, ch.xp_reward || 50, 'Completed challenge: ' + ch.title, 'challenges', ch.id);
        if (paid) {
          await notifySocial(req.sb, req.user.id, nameOf(req) + ' completed the challenge “' + ch.title + '” 🎉', 'challenges', ch.id);
          if (ch.badge_id) {
            const { data: hasBadge } = await req.sb.from('user_badges').select('id').eq('user_id', req.user.id).eq('badge_id', ch.badge_id).maybeSingle();
            if (!hasBadge) {
              await req.sb.from('user_badges').insert({ user_id: req.user.id, badge_id: ch.badge_id });
              const { data: bdg } = await req.sb.from('badges').select('name, emoji').eq('id', ch.badge_id).maybeSingle();
              if (bdg) await notifySocial(req.sb, req.user.id, nameOf(req) + ' earned the ' + bdg.emoji + ' “' + bdg.name + '” badge', 'badges', ch.badge_id);
            }
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

// ---------- AI-tailored challenges (paid) ----------
router.post('/generate', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('user_id', req.user.id).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bp) return res.redirect('/challenges?msg=' + encodeURIComponent('Create a launch blueprint first, then I can tailor challenges to it.'));
    let items;
    try { items = await ai.generateChallenges(req.accessToken, bp); }
    catch (err) { return res.redirect('/challenges?msg=' + encodeURIComponent('Could not generate challenges: ' + err.message)); }
    if (!Array.isArray(items) || !items.length) return res.redirect('/challenges?msg=' + encodeURIComponent('No challenges were generated — please try again.'));
    // Replace not-yet-completed AI challenges (pending/abandoned) with the fresh set.
    await req.sb.from('user_custom_challenges').delete().eq('user_id', req.user.id).in('status', ['pending', 'abandoned']);
    const rows = items.slice(0, 10).map(c => ({
      user_id: req.user.id, blueprint_id: bp.id,
      title: String(c.title || 'Challenge').slice(0, 120),
      description: String(c.description || '').slice(0, 400),
      emoji: String(c.emoji || '🏁').slice(0, 8),
      suggested_days: cleanDuration(c.suggested_days),
      xp_reward: Math.max(10, Math.min(200, parseInt(c.xp_reward, 10) || 50))
    }));
    await req.sb.from('user_custom_challenges').insert(rows);
    res.redirect('/challenges?msg=' + encodeURIComponent('Your AI-tailored challenges are ready.'));
  } catch (e) { next(e); }
});

router.post('/custom/:id/accept', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const duration = cleanDuration(req.body.duration_days);
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status !== 'completed') {
      const due = new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10);
      await req.sb.from('user_custom_challenges').update({ status: 'active', duration_days: duration, due_date: due, accepted_at: new Date().toISOString(), completed_at: null }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, 5, 'Accepted challenge: ' + c.title, 'user_custom_challenges', c.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the challenge “' + c.title + '”', 'user_custom_challenges', c.id);
    }
    res.redirect('/challenges');
  } catch (e) { next(e); }
});

router.post('/custom/:id/finish', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status === 'active') {
      await req.sb.from('user_custom_challenges').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, c.xp_reward || 50, 'Completed challenge: ' + c.title, 'user_custom_challenges', c.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' completed the challenge “' + c.title + '” 🎉', 'user_custom_challenges', c.id);
    }
    res.redirect('/challenges');
  } catch (e) { next(e); }
});

router.post('/custom/:id/abandon', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    await req.sb.from('user_custom_challenges').update({ status: 'abandoned' }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/challenges');
  } catch (e) { next(e); }
});

module.exports = router;
