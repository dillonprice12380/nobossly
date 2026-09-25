const router = require('express').Router();
const { awardXP } = require('../xp');
const ladders = require('../ladders');
const { notifySocial } = require('../notify');
const activity = require('../activity');
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

    const [{ data: defs }, { data: mine }, { data: badges }, { data: custom }, { data: levels }] = await Promise.all([
      req.sb.from('predefined_milestones').select('*').order('position'),
      req.sb.from('user_milestones').select('predefined_milestone_id, earned_at').eq('user_id', req.user.id),
      req.sb.from('badges').select('id, name, emoji, tier'),
      req.sb.from('user_custom_milestones').select('*').eq('user_id', req.user.id).order('created_at'),
      Promise.resolve({ data: ladders.ladderFor(req.profile.path) })
    ]);
    const earned = {};
    (mine || []).forEach(m => earned[m.predefined_milestone_id] = m);
    const badgeMap = {};
    (badges || []).forEach(b => badgeMap[b.id] = b);

    const cats = {};
    const legacy = [];
    const foreign = ladders.foreignGateTitles(req.profile.path, 'milestone');
    const claimable = [];
    (defs || []).forEach(d => {
      if (!d.is_active) { if (earned[d.id]) legacy.push(d); return; }
      if (d.auto_kind) (cats[d.category] = cats[d.category] || []).push(d);
      else if (d.is_claimable) { if (!foreign.has(String(d.title || '').trim().toLowerCase()) || earned[d.id]) claimable.push(d); }
      else if (earned[d.id]) legacy.push(d);
    });
    const earnedCount = (defs || []).filter(d => earned[d.id]).length;

    const gatesLevel = {};
    (levels || []).forEach(l => {
      const qs = Array.isArray(l.gates) ? l.gates : [];
      qs.forEach(q => {
        if (q && q.type === 'milestone' && q.title) {
          gatesLevel[String(q.title).trim().toLowerCase()] = l;
        }
      });
    });

    res.render('milestones', {
      title: 'Milestones', cats, earned, badgeMap, metrics, fresh, legacy, earnedCount,
      claimable, gatesLevel, paid, custom: custom || [], msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/:id/achieve', (req, res) => res.redirect('/trophies'));

router.post('/claim/:id', async (req, res, next) => {
  const back = m => res.redirect('/trophies?msg=' + encodeURIComponent(m));
  try {
    const note = String(req.body.proof_note || '').trim().slice(0, 2000);
    const { data: def, error: claimErr } = await req.sb.rpc('claim_trophy_for', {
      p_milestone_id: req.params.id, p_note: note
    });
    if (claimErr) { console.error('[db] claim_trophy_for failed:', claimErr.message); return res.redirect('/trophies'); }
    if (!def || !def.ok) {
      if (def && def.reason === 'needs_note') {
        return back('Add a bit more detail to “' + def.title + '” — a few honest sentences on what you actually did.');
      }
      if (def && def.reason === 'already') return back('You have already logged “' + def.title + '”.');
      return res.redirect('/trophies');
    }

    await awardXP(req.sb, req.user.id, req.profile, 'milestone_claim', 'Trophy: ' + def.title, 'predefined_milestones', req.params.id);
    await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A member') + ' earned the trophy ' + (def.emoji || '🏆') + ' “' + def.title + '”', 'predefined_milestones', req.params.id);
    await activity.record(req.sb, req.user.id, 'milestone', 'reached “' + def.title + '”', { emoji: def.emoji || '🏆', entityType: 'predefined_milestones', entityId: req.params.id });
    back(def.emoji + ' ' + def.title + ' logged — +' + (def.xp_reward || 50) + ' XP. That is a real one.');
  } catch (e) { next(e); }
});

// Achieve a self-added personal goal. Distinct from trophies, which only the
// engine awards.
router.post('/custom/:id/achieve', async (req, res, next) => {
  try {
    const { data: m } = await req.sb.from('user_custom_milestones').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (m && !m.achieved) {
      await req.sb.from('user_custom_milestones').update({
        achieved: true, date_achieved: new Date().toISOString().slice(0, 10), achieved_at: new Date().toISOString()
      }).eq('id', m.id);
      await awardXP(req.sb, req.user.id, req.profile, 'custom_goal', 'Goal: ' + m.title, 'user_custom_milestones', m.id);
      await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A member') + ' achieved the goal ' + (m.emoji || '🏆') + ' “' + m.title + '”', 'user_custom_milestones', m.id);
      await activity.record(req.sb, req.user.id, 'milestone', 'achieved “' + m.title + '”', { emoji: m.emoji || '🏆', entityType: 'user_custom_milestones', entityId: m.id });
    }
    res.redirect('/trophies');
  } catch (e) { next(e); }
});

module.exports = router;
