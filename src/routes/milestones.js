const router = require('express').Router();
const ai = require('../ai');
const { awardXP } = require('../xp');
const ladders = require('../ladders');
const { notifySocial } = require('../notify');
const activity = require('../activity');
const { planOf } = require('../middleware/auth');
const { sweepMilestones } = require('../milestones_engine');
const { gate, gateCredits } = require('../upgrade');
const credits = require('../credits');

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

    // Active trophies group by category; retired definitions (no measurable
    // criterion any more) still display if this founder earned them back then.
    const cats = {};
    const legacy = [];
    const foreign = ladders.foreignGateTitles(req.profile.path, 'milestone');
    // Real-world milestones: the things no metric can see — you registered the
    // business, you opened the bank account, you hit $1k MRR. Self-attested with
    // a written proof note, and deliberately kept apart from the auto trophies
    // so the difference between "the game watched you do this" and "you told us
    // you did this" stays visible.
    const claimable = [];
    (defs || []).forEach(d => {
      if (!d.is_active) { if (earned[d.id]) legacy.push(d); return; }
      if (d.auto_kind) (cats[d.category] = cats[d.category] || []).push(d);
      // A gate written for another path is not this member's to claim. Anything
      // already earned still shows — nobody loses a trophy to a path change.
      else if (d.is_claimable) { if (!foreign.has(String(d.title || '').trim().toLowerCase()) || earned[d.id]) claimable.push(d); }
      else if (earned[d.id]) legacy.push(d);
    });
    const earnedCount = (defs || []).filter(d => earned[d.id]).length;

    // Which rung each real-world milestone unlocks, so the founder can see why
    // it matters rather than just what it is worth.
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

// Manual claiming of AUTO trophies is retired. Old cached pages may still POST
// here — just bounce back to the trophy case, where the sweep tells the truth.
router.post('/:id/achieve', (req, res) => res.redirect('/trophies'));

// Claim a real-world milestone. These carry the ladder's top five rungs and
// cannot be measured from inside the app, so they are self-attested — but a
// written account is required, the same standard the proof-gated challenges
// hold, and it is stored against the claim.
router.post('/claim/:id', async (req, res, next) => {
  const back = m => res.redirect('/trophies?msg=' + encodeURIComponent(m));
  try {
    // The written account is the standard these are held to, and it used to be
    // enforced here — beside an INSERT the member could have made without it,
    // into the table level_reached() reads to decide a rung. The claim is a
    // request now: claim_trophy_for re-checks that the trophy is claimable, that
    // the note clears the bar, and that it has not already been logged, and
    // decides `pinned` from the plan rather than from anything sent up.
    const note = String(req.body.proof_note || '').trim().slice(0, 2000);
    const { data: def, error: claimErr } = await req.sb.rpc('claim_trophy_for', {
      p_milestone_id: req.params.id, p_note: note
    });
    if (claimErr) { console.error('[db] claim_trophy_for failed:', claimErr.message); return res.redirect('/trophies'); }
    if (!def || !def.ok) {
      if (def && def.reason === 'needs_note') {
        return back('Add a bit more detail to \u201c' + def.title + '\u201d \u2014 a few honest sentences on what you actually did.');
      }
      if (def && def.reason === 'already') return back('You have already logged \u201c' + def.title + '\u201d.');
      return res.redirect('/trophies');
    }

    await awardXP(req.sb, req.user.id, req.profile, 'milestone_claim', 'Trophy: ' + def.title, 'predefined_milestones', req.params.id);
    await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A member') + ' earned the trophy ' + (def.emoji || '\ud83c\udfc6') + ' \u201c' + def.title + '\u201d', 'predefined_milestones', req.params.id);
    await activity.record(req.sb, req.user.id, 'milestone', 'reached \u201c' + def.title + '\u201d', { emoji: def.emoji || '\ud83c\udfc6', entityType: 'predefined_milestones', entityId: req.params.id });
    back(def.emoji + ' ' + def.title + ' logged \u2014 +' + (def.xp_reward || 50) + ' XP. That is a real one.');
  } catch (e) { next(e); }
});

// Generate an AI-tailored set of personal goals from the founder's active blueprint (paid only).
router.post('/generate', async (req, res, next) => {
  try {
    if (!isPaid(req)) return gate(res, 'ai_milestones');
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('user_id', req.user.id).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bp) return res.redirect('/trophies?msg=' + encodeURIComponent('Create a launch blueprint first, then I can tailor goals to it.'));
    let items;
    try { items = await credits.run(req.sb, 'milestones', () => ai.generateMilestones(req.accessToken, bp)); }
    catch (err) {
      if (err.outOfCredits) return gateCredits(res, err.credits, '/trophies');
      return res.redirect('/trophies?msg=' + encodeURIComponent('Could not generate goals: ' + err.message));
    }
    if (!Array.isArray(items) || !items.length) return res.redirect('/trophies?msg=' + encodeURIComponent('No goals were generated \u2014 please try again.'));
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
    res.redirect('/trophies?msg=' + encodeURIComponent('Your AI-tailored goals are ready.'));
  } catch (e) { next(e); }
});

// Achieve an AI-tailored personal goal (paid). These are the founder's own
// self-tracked goals — distinct from trophies, which only the engine awards.
router.post('/custom/:id/achieve', async (req, res, next) => {
  try {
    if (!isPaid(req)) return gate(res, 'ai_milestones');
    const { data: m } = await req.sb.from('user_custom_milestones').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (m && !m.achieved) {
      await req.sb.from('user_custom_milestones').update({
        achieved: true, date_achieved: new Date().toISOString().slice(0, 10), achieved_at: new Date().toISOString()
      }).eq('id', m.id);
      await awardXP(req.sb, req.user.id, req.profile, 'custom_goal', 'Goal: ' + m.title, 'user_custom_milestones', m.id);
      await notifySocial(req.sb, req.user.id, (req.profile.display_name || req.profile.username || 'A member') + ' achieved the goal ' + (m.emoji || '\ud83c\udfc6') + ' \u201c' + m.title + '\u201d', 'user_custom_milestones', m.id);
      await activity.record(req.sb, req.user.id, 'milestone', 'achieved \u201c' + m.title + '\u201d', { emoji: m.emoji || '\ud83c\udfc6', entityType: 'user_custom_milestones', entityId: m.id });
    }
    res.redirect('/trophies');
  } catch (e) { next(e); }
});

module.exports = router;
