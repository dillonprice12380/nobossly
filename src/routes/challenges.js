const router = require('express').Router();
const { awardXP } = require('../xp');
const ladders = require('../ladders');
const { notifySocial } = require('../notify');
const activity = require('../activity');
const { planOf } = require('../middleware/auth');
const { getElectives } = require('../tailor');

const { quiet } = require('../db');
const isPaid = req => planOf(req.profile) === 'paid';
const nameOf = req => (req.profile.display_name || req.profile.username || 'A member');
const cleanDuration = v => [30, 60, 90].includes(parseInt(v, 10)) ? parseInt(v, 10) : 30;

router.get('/', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    const level = req.profile.current_level || 1;

    const [{ data: challenges }, { data: acc }, { data: custom }, { data: sprint }] = await Promise.all([
      req.sb.from('challenges').select('*').eq('is_active', true).order('position'),
      req.sb.from('challenge_acceptances').select('*').eq('user_id', req.user.id),
      req.sb.from('user_custom_challenges').select('*').eq('user_id', req.user.id).order('created_at'),
      req.sb.from('sprints').select('*').eq('user_id', req.user.id).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    const accMap = {};
    (acc || []).forEach(a => accMap[a.challenge_id] = a);

    // Core challenges are for everyone, but only the ones that fit this
    // founder's current level — plus anything they've already accepted or
    // completed, which stays visible regardless of the band it came from.
    const inBand = c => c.min_level <= level && level <= c.max_level;
    // A gate written for another path is not this member's quest. Anything they
    // already accepted stays visible either way — a board that removes work
    // someone is part-way through is worse than one showing a stray card.
    const foreign = ladders.foreignGateTitles(req.profile.path, 'challenge');
    const mine = c => !foreign.has(String(c.title || '').trim().toLowerCase());
    const all = (challenges || []).filter(c => (c.is_cohort || accMap[c.id] || inBand(c)) && (accMap[c.id] || mine(c)));

    // Accepted-and-active challenges float to the top, completed sink to the
    // bottom, everything else keeps its curated position in between.
    const rank = c => {
      const a = accMap[c.id];
      if (a && a.status === 'active') return 0;
      if (a && a.status === 'completed') return 2;
      return 1;
    };
    const sorted = arr => arr.slice().sort((x, y) => rank(x) - rank(y) || (x.position || 0) - (y.position || 0));

    // Electives, matched to path/subpath and business tags — no AI, just the
    // curated pool in tailored_challenges.
    let electives = [], unclassified = false;
    try { ({ electives, unclassified } = await getElectives(req.sb, { ...req.profile, id: req.user.id }, level)); }
    catch (e) { console.error('electives', e); }

    res.render('challenges', {
      title: 'Challenges',
      challenges: sorted(all.filter(c => !c.is_cohort)),
      cohorts: sorted(all.filter(c => c.is_cohort)),
      accMap, paid, custom: custom || [], sprint: sprint || null,
      electives, unclassified, level,
      msg: req.query.msg || null,
      streak: { days: req.profile.streak_days || 0, longest: req.profile.longest_streak || 0 }
    });
  } catch (e) { next(e); }
});

// ---------- Quest soundbites ----------
const SOUND_KEYS = {
  complete: 'challenge-complete', levelup: 'level-up'
};

const soundCache = {};
router.get('/sound/:name?', async (req, res) => {
  try {
    const key = SOUND_KEYS[req.params.name || 'complete'];
    if (!key) return res.status(404).end();
    let hit = soundCache[key];
    if (!hit || Date.now() - hit.at > 60000) {
      const { data } = await req.sb.from('site_assets').select('mime, data_b64').eq('key', key).maybeSingle();
      if (data) {
        hit = soundCache[key] = { at: Date.now(), mime: data.mime || 'audio/mpeg', buf: Buffer.from(data.data_b64, 'base64') };
      } else {
        return res.status(404).end();
      }
    }
    res.set('Content-Type', hit.mime);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(hit.buf);
  } catch (_) { res.status(404).end(); }
});

// ---------- Level verification (privacy-first) ----------
router.get('/verify', async (req, res, next) => {
  try {
    const { data: vr } = await req.sb.from('verification_requests').select('*')
      .eq('user_id', req.user.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!vr) return res.redirect('/quests?msg=' + encodeURIComponent('No verification is pending — keep climbing!'));
    res.render('verify_level', { title: 'Verify Level ' + vr.level, vr, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/verify', async (req, res, next) => {
  try {
    const b = req.body;
    const kind = ['public_link', 'redacted_screenshot', 'call', 'note_only'].includes(b.evidence_kind) ? b.evidence_kind : 'note_only';
    const note = String(b.evidence_note || '').trim().slice(0, 2000);
    if (note.length < 30) {
      return res.redirect('/quests/verify?msg=' + encodeURIComponent('Add a bit more detail — a few sentences on what you did and how it went.'));
    }
    const url = String(b.evidence_url || '').trim().slice(0, 500) || null;
    const { error } = await req.sb.from('verification_requests')
      .update({ evidence_kind: kind, evidence_note: note, evidence_url: url })
      .eq('user_id', req.user.id).eq('status', 'pending');
    if (error) throw error;
    res.redirect('/quests?msg=' + encodeURIComponent('Evidence submitted — your verification is in review. Unlocks open on approval.'));
  } catch (e) { next(e); }
});

// Cohort leaderboard
router.get('/:id/leaderboard', async (req, res, next) => {
  try {
    const { data: ch } = await req.sb.from('challenges').select('*').eq('id', req.params.id).maybeSingle();
    if (!ch) return res.redirect('/quests');
    const { data: rows, error } = await req.sb.rpc('cohort_leaderboard', { p_challenge: ch.id });
    if (error) throw error;
    res.render('cohort_leaderboard', { title: ch.title + ' — Leaderboard', ch, rows: rows || [], myId: req.user.id });
  } catch (e) { next(e); }
});

router.post('/:id/accept', async (req, res, next) => {
  try {
    let duration = cleanDuration(req.body.duration_days);
    const { data: ch } = await req.sb.from('challenges').select('id, title, is_cohort, starts_at, ends_at').eq('id', req.params.id).maybeSingle();
    if (ch) {
      let due = new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10);
      if (ch.is_cohort) {
        if (ch.ends_at && new Date(ch.ends_at).getTime() < Date.now()) {
          return res.redirect('/quests?msg=' + encodeURIComponent('That cohort has already ended — keep an eye out for the next one.'));
        }
        const end = ch.ends_at ? new Date(ch.ends_at) : new Date(Date.now() + 30 * 86400000);
        duration = Math.max(1, Math.ceil((end.getTime() - Date.now()) / 86400000));
        due = end.toISOString().slice(0, 10);
      }
      const { data: existing } = await req.sb.from('challenge_acceptances').select('id, status').eq('user_id', req.user.id).eq('challenge_id', ch.id).maybeSingle();
      if (existing) {
        if (existing.status === 'completed') return res.redirect('/quests');
        await req.sb.from('challenge_acceptances').update({ status: 'active', duration_days: duration, due_date: due, accepted_at: new Date().toISOString(), completed_at: null }).eq('id', existing.id);
      } else {
        await req.sb.from('challenge_acceptances').insert({ user_id: req.user.id, challenge_id: ch.id, duration_days: duration, due_date: due });
      }
      await awardXP(req.sb, req.user.id, req.profile, 'quest_accepted', 'Accepted quest: ' + ch.title, 'challenges', ch.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the quest “' + ch.title + '”', 'challenges', ch.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/quests');
  } catch (e) { next(e); }
});

router.post('/:id/finish', async (req, res, next) => {
  try {
    const back = req.body.from === 'dashboard' ? '/dashboard' : '/quests';
    const proof = String(req.body.proof_note || '').trim();
    const { data: done, error: doneErr } = await req.sb.rpc('complete_quest_for', {
      p_challenge_id: req.params.id, p_proof: proof
    });
    if (doneErr) console.error('[db] complete_quest_for failed:', doneErr.message);
    if (done && done.reason === 'needs_proof') {
      return res.redirect('/quests?msg=' + encodeURIComponent('“' + done.title + '” is a quest — add a short proof note (who, what, result) to complete it. A few honest sentences is all it takes.'));
    }
    if (done && done.ok) {
      const ch = { id: req.params.id, title: done.title, emoji: done.emoji,
                   badge_id: done.badge_id, requires_proof: done.requires_proof };
      if (ch.requires_proof && proof) {
        await req.sb.from('wins').insert({
          user_id: req.user.id, title: '🏆 Quest complete: ' + ch.title,
          category: 'challenge', story: proof.slice(0, 1000)
        }).then(...quiet('wins.insert'));
      }
      await awardXP(req.sb, req.user.id, req.profile, 'quest_completed', 'Completed quest: ' + ch.title, 'challenges', ch.id);
      // Every completion is now visible on the feed — seeing what people you
      // follow are working on is the point of the community, not a paid perk.
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' completed the quest “' + ch.title + '” 🎉', 'challenges', ch.id);
      await activity.record(req.sb, req.user.id, 'challenge', 'completed “' + ch.title + '”', { emoji: ch.emoji || '🏁', entityType: 'challenges', entityId: ch.id });
      if (ch.badge_id) {
        const { data: hasBadge } = await req.sb.from('user_badges').select('id').eq('user_id', req.user.id).eq('badge_id', ch.badge_id).maybeSingle();
        if (!hasBadge) {
          await req.sb.from('user_badges').insert({ user_id: req.user.id, badge_id: ch.badge_id });
          const { data: bdg } = await req.sb.from('badges').select('name, emoji').eq('id', ch.badge_id).maybeSingle();
          if (bdg) await notifySocial(req.sb, req.user.id, nameOf(req) + ' earned the ' + bdg.emoji + ' “' + bdg.name + '” badge', 'badges', ch.badge_id);
        }
      }
    }
    res.redirect(back);
  } catch (e) { next(e); }
});

router.post('/:id/abandon', async (req, res, next) => {
  try {
    await req.sb.from('challenge_acceptances').update({ status: 'abandoned' }).eq('challenge_id', req.params.id).eq('user_id', req.user.id);
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/quests');
  } catch (e) { next(e); }
});

// ---------- Tailored electives ----------
router.post('/tailored/:id/accept', async (req, res, next) => {
  try {
    const { data: t } = await req.sb.from('tailored_challenges').select('*').eq('id', req.params.id).eq('is_active', true).maybeSingle();
    if (!t) return res.redirect('/quests');
    const { data: existing } = await req.sb.from('user_custom_challenges').select('id, status').eq('user_id', req.user.id).eq('tailored_id', t.id).maybeSingle();
    if (existing) return res.redirect('/quests');
    const duration = cleanDuration(req.body.duration_days || t.suggested_days);
    await req.sb.from('user_custom_challenges').insert({
      user_id: req.user.id, tailored_id: t.id,
      title: t.title, description: t.description, emoji: t.emoji,
      xp_reward: t.xp_reward, suggested_days: t.suggested_days,
      status: 'active', duration_days: duration,
      due_date: new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10),
      accepted_at: new Date().toISOString()
    });
    await awardXP(req.sb, req.user.id, req.profile, 'quest_accepted', 'Accepted quest: ' + t.title, 'tailored_challenges', t.id);
    await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the quest “' + t.title + '”', 'tailored_challenges', t.id);
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/quests');
  } catch (e) { next(e); }
});

// Accept/finish/abandon a personal challenge (an accepted elective).
router.post('/custom/:id/accept', async (req, res, next) => {
  try {
    const duration = cleanDuration(req.body.duration_days);
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status !== 'completed') {
      const due = new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10);
      await req.sb.from('user_custom_challenges').update({ status: 'active', duration_days: duration, due_date: due, accepted_at: new Date().toISOString(), completed_at: null }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, 'quest_accepted', 'Accepted quest: ' + c.title, 'user_custom_challenges', c.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the quest “' + c.title + '”', 'user_custom_challenges', c.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/quests');
  } catch (e) { next(e); }
});

router.post('/custom/:id/finish', async (req, res, next) => {
  try {
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status === 'active') {
      await req.sb.from('user_custom_challenges').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, 'custom_quest_completed', 'Completed quest: ' + c.title, 'user_custom_challenges', c.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' completed the quest “' + c.title + '” 🎉', 'user_custom_challenges', c.id);
      await activity.record(req.sb, req.user.id, 'challenge', 'completed “' + c.title + '”', { emoji: c.emoji || '🏁', entityType: 'user_custom_challenges', entityId: c.id });
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/quests');
  } catch (e) { next(e); }
});

router.post('/custom/:id/abandon', async (req, res, next) => {
  try {
    await req.sb.from('user_custom_challenges').update({ status: 'abandoned' }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/quests');
  } catch (e) { next(e); }
});

module.exports = router;
