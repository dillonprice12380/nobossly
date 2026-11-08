const router = require('express').Router();
const pi = require('../personal_info_filter');
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');
const activity = require('../activity');

const { quiet } = require('../db');
const nameOf = req => (req.profile.display_name || req.profile.username || 'A member');
const cleanDuration = v => [30, 60, 90].includes(parseInt(v, 10)) ? parseInt(v, 10) : 30;

// Challenges are community events now: the weekly cohorts members join
// together. The curated quest library and the electives were retired
// (2026-11-08) because NoBossly is a workspace and a community, not a program
// that tells people what to do next; anything a member already has open stays
// here until they finish or leave it.
router.get('/', async (req, res, next) => {
  try {
    const [{ data: challenges }, { data: acc }, { data: custom }] = await Promise.all([
      req.sb.from('challenges').select('*').order('position'),
      req.sb.from('challenge_acceptances').select('*').eq('user_id', req.user.id),
      req.sb.from('user_custom_challenges').select('*').eq('user_id', req.user.id).order('created_at')
    ]);
    const accMap = {};
    (acc || []).forEach(a => accMap[a.challenge_id] = a);
    const byId = {};
    (challenges || []).forEach(c => byId[c.id] = c);

    // Cohorts: an ended one is only worth showing to someone who took part.
    // Everyone else sees what is live or coming up next.
    const now = Date.now();
    const ended = c => c.ends_at && new Date(c.ends_at).getTime() < now;
    const cohorts = (challenges || []).filter(c => c.is_cohort && c.is_active && (!ended(c) || accMap[c.id]))
      .sort((x, y) => String(x.starts_at || '').localeCompare(String(y.starts_at || '')));
    const { data: waits } = await req.sb.from('cohort_waitlist').select('cohort_id').eq('user_id', req.user.id);
    const waiting = new Set((waits || []).map(w => w.cohort_id));

    // What this member has open, whichever kind it is.
    const open = (acc || []).filter(a => a.status === 'active' && byId[a.challenge_id])
      .map(a => ({ kind: byId[a.challenge_id].is_cohort ? 'cohort' : 'core', ch: byId[a.challenge_id], due: a.due_date }))
      .concat((custom || []).filter(c => c.status === 'active').map(c => ({ kind: 'custom', ch: c, due: c.due_date })))
      .sort((x, y) => String(x.due || '9999').localeCompare(String(y.due || '9999')));
    const finished = (acc || []).filter(a => a.status === 'completed' && byId[a.challenge_id]).map(a => byId[a.challenge_id])
      .concat((custom || []).filter(c => c.status === 'completed'));

    res.render('challenges', {
      title: 'Challenges', cohorts, waiting, accMap, open, finished,
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

const RETIRED = '/quests?msg=' + encodeURIComponent('That challenge has been retired. The weekly community challenges are below.');

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
    if (ch && !ch.is_cohort) return res.redirect(RETIRED);
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
      await awardXP(req.sb, req.user.id, req.profile, 'quest_accepted', 'Joined challenge: ' + ch.title, 'challenges', ch.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' joined the challenge “' + ch.title + '”', 'challenges', ch.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/quests');
  } catch (e) { next(e); }
});

// "Remind me": a notification when an upcoming cohort starts, without joining yet.
router.post('/cohort/:id/remind', async (req, res, next) => {
  try {
    const { error } = await req.sb.rpc(req.body.off ? 'cohort_waitlist_leave' : 'cohort_waitlist_join', { p_cohort: req.params.id });
    if (error) console.error('[db] cohort waitlist failed:', error.message);
    res.redirect('/quests?msg=' + encodeURIComponent(req.body.off ? 'Reminder cancelled.' : 'Done — we will let you know when the cohort starts.'));
  } catch (e) { next(e); }
});

router.post('/:id/finish', async (req, res, next) => {
  try {
    const back = req.body.from === 'dashboard' ? '/dashboard' : '/quests';
    const proof = String(req.body.proof_note || '').trim();
    // A proof note can become a public win story (below), so it is filtered too.
    const found = pi.check(proof);
    if (found) return pi.refuse(req, res, back, found, 'quest_proof');
    const { data: done, error: doneErr } = await req.sb.rpc('complete_quest_for', {
      p_challenge_id: req.params.id, p_proof: proof
    });
    if (doneErr) console.error('[db] complete_quest_for failed:', doneErr.message);
    if (done && done.reason === 'needs_proof') {
      return res.redirect('/quests?msg=' + encodeURIComponent('To finish “' + done.title + '”, add a short note on what you set out to do and what got done.'));
    }
    if (done && done.ok) {
      const ch = { id: req.params.id, title: done.title, emoji: done.emoji,
                   badge_id: done.badge_id, requires_proof: done.requires_proof };
      if (ch.requires_proof && proof) {
        await req.sb.from('wins').insert({
          user_id: req.user.id, title: '🏆 Challenge done: ' + ch.title,
          category: 'challenge', story: proof.slice(0, 1000)
        }).then(...quiet('wins.insert'));
      }
      await awardXP(req.sb, req.user.id, req.profile, 'quest_completed', 'Completed challenge: ' + ch.title, 'challenges', ch.id);
      // Every completion is now visible on the feed — seeing what people you
      // follow are working on is the point of the community, not a paid perk.
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' finished the challenge “' + ch.title + '” 🎉', 'challenges', ch.id);
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

// ---------- Electives (retired 2026-11-08) ----------
// Taking on a new elective, or re-opening one, is no longer offered. Members
// can still finish or leave the ones they have open.
router.post('/tailored/:id/accept', (req, res) => res.redirect(RETIRED));
router.post('/custom/:id/accept', (req, res) => res.redirect(RETIRED));

router.post('/custom/:id/finish', async (req, res, next) => {
  try {
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status === 'active') {
      await req.sb.from('user_custom_challenges').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, 'custom_quest_completed', 'Completed challenge: ' + c.title, 'user_custom_challenges', c.id);
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' finished the challenge “' + c.title + '” 🎉', 'user_custom_challenges', c.id);
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
