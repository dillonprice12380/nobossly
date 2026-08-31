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
    const [{ data: challenges }, { data: acc }, { data: custom }, { data: sprint }] = await Promise.all([
      req.sb.from('challenges').select('*').eq('is_active', true).order('position'),
      req.sb.from('challenge_acceptances').select('*').eq('user_id', req.user.id),
      req.sb.from('user_custom_challenges').select('*').eq('user_id', req.user.id).order('created_at'),
      req.sb.from('sprints').select('*').eq('user_id', req.user.id).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    const accMap = {};
    (acc || []).forEach(a => accMap[a.challenge_id] = a);
    const all = challenges || [];
    // Accepted-and-active challenges float to the top, completed sink to the
    // bottom, everything else keeps its curated position in between.
    const rank = c => {
      const a = accMap[c.id];
      if (a && a.status === 'active') return 0;
      if (a && a.status === 'completed') return 2;
      return 1;
    };
    const sorted = arr => arr.slice().sort((x, y) => rank(x) - rank(y) || (x.position || 0) - (y.position || 0));
    res.render('challenges', {
      title: 'Challenges',
      challenges: sorted(all.filter(c => !c.is_cohort)),
      cohorts: sorted(all.filter(c => c.is_cohort)),
      accMap, paid, custom: custom || [], sprint: sprint || null,
      msg: req.query.msg || null,
      streak: { days: req.profile.streak_days || 0, longest: req.profile.longest_streak || 0 }
    });
  } catch (e) { next(e); }
});

// ---------- Quest soundbites ----------
// The accept sound lives on R2, but object keys are easy to get slightly
// wrong (folder name case, spaces, original upload filenames). Resolve it
// server-side ONCE: probe a list of likely keys, cache the first that
// answers, and 302 the browser there. The client just plays
// /challenges/sound/1 and /challenges/sound/2 and never cares about keys.
const R2_BASE = 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/';
const SOUND_KEYS = {
  '1': ['Site%20Sounds/lets-do-this.mp3', 'Site%20Sounds/Let_s_Do_This.mp3', 'lets-do-this.mp3', 'Let_s_Do_This.mp3', 'Site%20sounds/lets-do-this.mp3', 'site-sounds/lets-do-this.mp3', 'Site_Sounds/lets-do-this.mp3'],
  '2': ['Site%20Sounds/lets-do-this-2.mp3', 'Site%20Sounds/Let_s_Do_This__1_.mp3', 'lets-do-this-2.mp3', 'Let_s_Do_This__1_.mp3', 'Site%20sounds/lets-do-this-2.mp3', 'site-sounds/lets-do-this-2.mp3', 'Site_Sounds/lets-do-this-2.mp3']
};
const soundCache = {};
router.get('/sound/:n', async (req, res) => {
  const n = req.params.n === '2' ? '2' : '1';
  try {
    if (!soundCache[n]) {
      for (const key of SOUND_KEYS[n]) {
        try {
          const r = await fetch(R2_BASE + key, { method: 'HEAD' });
          if (r.ok) { soundCache[n] = R2_BASE + key; break; }
        } catch (_) { /* try the next candidate */ }
      }
    }
    if (soundCache[n]) {
      res.set('Cache-Control', 'no-store'); // the redirect target may change after re-uploads
      return res.redirect(302, soundCache[n]);
    }
    res.status(404).end();
  } catch (_) { res.status(404).end(); }
});

// ---------- Level verification (privacy-first) ----------
// Financial documents are never required. Evidence can be the founder's own
// specifics, a public-footprint link (live site, testimonial, review), a
// REDACTED screenshot, or a call. Whatever is attached is visible to admin
// only, never public, and can be deleted after review.
router.get('/verify', async (req, res, next) => {
  try {
    const { data: vr } = await req.sb.from('verification_requests').select('*')
      .eq('user_id', req.user.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!vr) return res.redirect('/challenges?msg=' + encodeURIComponent('No verification is pending \u2014 keep climbing!'));
    res.render('verify_level', { title: 'Verify Level ' + vr.level, vr, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/verify', async (req, res, next) => {
  try {
    const b = req.body;
    const kind = ['public_link', 'redacted_screenshot', 'call', 'note_only'].includes(b.evidence_kind) ? b.evidence_kind : 'note_only';
    const note = String(b.evidence_note || '').trim().slice(0, 2000);
    if (note.length < 30) {
      return res.redirect('/challenges/verify?msg=' + encodeURIComponent('Add a bit more detail \u2014 a few sentences on what you did and how it went.'));
    }
    const url = String(b.evidence_url || '').trim().slice(0, 500) || null;
    const { error } = await req.sb.from('verification_requests')
      .update({ evidence_kind: kind, evidence_note: note, evidence_url: url })
      .eq('user_id', req.user.id).eq('status', 'pending');
    if (error) throw error;
    res.redirect('/challenges?msg=' + encodeURIComponent('Evidence submitted \u2014 your verification is in review. Unlocks open on approval.'));
  } catch (e) { next(e); }
});

// Cohort leaderboard — XP earned inside the cohort window, via SECURITY DEFINER RPC.
router.get('/:id/leaderboard', async (req, res, next) => {
  try {
    const { data: ch } = await req.sb.from('challenges').select('*').eq('id', req.params.id).maybeSingle();
    if (!ch) return res.redirect('/challenges');
    const { data: rows, error } = await req.sb.rpc('cohort_leaderboard', { p_challenge: ch.id });
    if (error) throw error;
    res.render('cohort_leaderboard', { title: ch.title + ' \u2014 Leaderboard', ch, rows: rows || [], myId: req.user.id });
  } catch (e) { next(e); }
});

router.post('/:id/accept', async (req, res, next) => {
  try {
    let duration = cleanDuration(req.body.duration_days);
    const { data: ch } = await req.sb.from('challenges').select('id, title, is_cohort, starts_at, ends_at').eq('id', req.params.id).maybeSingle();
    if (ch) {
      let due = new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10);
      // Cohorts share a fixed window: everyone's deadline is the cohort end date.
      if (ch.is_cohort) {
        if (ch.ends_at && new Date(ch.ends_at).getTime() < Date.now()) {
          return res.redirect('/challenges?msg=' + encodeURIComponent('That cohort has already ended \u2014 keep an eye out for the next one.'));
        }
        const end = ch.ends_at ? new Date(ch.ends_at) : new Date(Date.now() + 30 * 86400000);
        duration = Math.max(1, Math.ceil((end.getTime() - Date.now()) / 86400000));
        due = end.toISOString().slice(0, 10);
      }
      const { data: existing } = await req.sb.from('challenge_acceptances').select('id, status').eq('user_id', req.user.id).eq('challenge_id', ch.id).maybeSingle();
      if (existing) {
        if (existing.status === 'completed') return res.redirect('/challenges');
        await req.sb.from('challenge_acceptances').update({ status: 'active', duration_days: duration, due_date: due, accepted_at: new Date().toISOString(), completed_at: null }).eq('id', existing.id);
      } else {
        await req.sb.from('challenge_acceptances').insert({ user_id: req.user.id, challenge_id: ch.id, duration_days: duration, due_date: due });
      }
      await awardXP(req.sb, req.user.id, req.profile, 5, 'Accepted challenge: ' + ch.title, 'challenges', ch.id);
      if (isPaid(req)) await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the challenge \u201c' + ch.title + '\u201d', 'challenges', ch.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

// Finish a pre-chosen challenge. Quest challenges (requires_proof) demand a
// short proof note \u2014 specifics deter casual gaming of the Ladder \u2014 and the
// completion auto-posts to the Wins wall for admin review + witnesses.
// Suspiciously fast big-quest completions are flagged for review, not blocked.
router.post('/:id/finish', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    const back = req.body.from === 'dashboard' ? '/dashboard' : '/challenges';
    const [{ data: a }, { data: ch }] = await Promise.all([
      req.sb.from('challenge_acceptances').select('*').eq('challenge_id', req.params.id).eq('user_id', req.user.id).maybeSingle(),
      req.sb.from('challenges').select('*').eq('id', req.params.id).maybeSingle()
    ]);
    if (a && a.status === 'active' && ch) {
      const proof = String(req.body.proof_note || '').trim();
      if (ch.requires_proof && proof.length < 25) {
        return res.redirect('/challenges?msg=' + encodeURIComponent('\u201c' + ch.title + '\u201d is a quest \u2014 add a short proof note (who, what, result) to complete it. A few honest sentences is all it takes.'));
      }
      const acceptedMs = a.accepted_at ? new Date(a.accepted_at).getTime() : 0;
      const flagged = !!(ch.requires_proof && (ch.xp_reward || 0) >= 150 && acceptedMs && (Date.now() - acceptedMs) < 86400000);
      await req.sb.from('challenge_acceptances').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', a.id);
      const { data: existing } = await req.sb.from('challenge_completions').select('id').eq('user_id', req.user.id).eq('challenge_id', a.challenge_id).maybeSingle();
      if (!existing) await req.sb.from('challenge_completions').insert({ user_id: req.user.id, challenge_id: a.challenge_id, proof_note: proof, flagged });
      // Witnessed progress: quest completions go to the Wins wall (admin-reviewed).
      if (ch.requires_proof && proof) {
        await req.sb.from('wins').insert({
          user_id: req.user.id, title: '\ud83c\udfc6 Quest complete: ' + ch.title,
          category: 'challenge', story: proof.slice(0, 1000)
        }).then(() => {}, () => {});
      }
      await awardXP(req.sb, req.user.id, req.profile, ch.xp_reward || 50, 'Completed challenge: ' + ch.title, 'challenges', ch.id);
      if (paid) {
        await notifySocial(req.sb, req.user.id, nameOf(req) + ' completed the challenge \u201c' + ch.title + '\u201d \ud83c\udf89', 'challenges', ch.id);
        if (ch.badge_id) {
          const { data: hasBadge } = await req.sb.from('user_badges').select('id').eq('user_id', req.user.id).eq('badge_id', ch.badge_id).maybeSingle();
          if (!hasBadge) {
            await req.sb.from('user_badges').insert({ user_id: req.user.id, badge_id: ch.badge_id });
            const { data: bdg } = await req.sb.from('badges').select('name, emoji').eq('id', ch.badge_id).maybeSingle();
            if (bdg) await notifySocial(req.sb, req.user.id, nameOf(req) + ' earned the ' + bdg.emoji + ' \u201c' + bdg.name + '\u201d badge', 'badges', ch.badge_id);
          }
        }
      }
    }
    res.redirect(back);
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
    if (!Array.isArray(items) || !items.length) return res.redirect('/challenges?msg=' + encodeURIComponent('No challenges were generated \u2014 please try again.'));
    // Replace not-yet-completed AI challenges (pending/abandoned) with the fresh set.
    await req.sb.from('user_custom_challenges').delete().eq('user_id', req.user.id).in('status', ['pending', 'abandoned']);
    const rows = items.slice(0, 10).map(c => ({
      user_id: req.user.id, blueprint_id: bp.id,
      title: String(c.title || 'Challenge').slice(0, 120),
      description: String(c.description || '').slice(0, 400),
      emoji: String(c.emoji || '\ud83c\udfc1').slice(0, 8),
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
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the challenge \u201c' + c.title + '\u201d', 'user_custom_challenges', c.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

router.post('/custom/:id/finish', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status === 'active') {
      await req.sb.from('user_custom_challenges').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, c.xp_reward || 50, 'Completed challenge: ' + c.title, 'user_custom_challenges', c.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' completed the challenge \u201c' + c.title + '\u201d \ud83c\udf89', 'user_custom_challenges', c.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

router.post('/custom/:id/abandon', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    await req.sb.from('user_custom_challenges').update({ status: 'abandoned' }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

module.exports = router;
