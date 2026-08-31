const router = require('express').Router();
const ai = require('../ai');
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');
const { planOf } = require('../middleware/auth');
const { ensureClassified, getElectives } = require('../tailor');
const { gate } = require('../upgrade');

const isPaid = req => planOf(req.profile) === 'paid';
const nameOf = req => (req.profile.display_name || req.profile.username || 'A founder');
const cleanDuration = v => [30, 60, 90].includes(parseInt(v, 10)) ? parseInt(v, 10) : 30;

router.get('/', async (req, res, next) => {
  try {
    const paid = isPaid(req);
    const level = req.profile.current_level || 1;

    // Make sure this founder is classified (type/industry/segment/value prop)
    // so electives can be matched. One AI call ever — then cached on the
    // profile until their blueprint changes.
    const profile = await ensureClassified(req.sb, req.accessToken, req.user.id, req.profile);

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
    const all = (challenges || []).filter(c => c.is_cohort || accMap[c.id] || inBand(c));

    // Accepted-and-active challenges float to the top, completed sink to the
    // bottom, everything else keeps its curated position in between.
    const rank = c => {
      const a = accMap[c.id];
      if (a && a.status === 'active') return 0;
      if (a && a.status === 'completed') return 2;
      return 1;
    };
    const sorted = arr => arr.slice().sort((x, y) => rank(x) - rank(y) || (x.position || 0) - (y.position || 0));

    // Electives, matched to their business classification. AI top-up inside
    // is paid-only; pool matches are for everyone.
    let electives = [], unclassified = false;
    try { ({ electives, unclassified } = await getElectives(req.sb, { ...profile, id: req.user.id }, level, { paid, accessToken: req.accessToken })); }
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
// The game sounds are stored in the database (site_assets, base64) and served
// from our own domain — no external object storage, no filename matching.
// Admins upload or replace them at /admin/sounds. Cached in memory for 60s so
// a re-upload takes effect without a restart; browsers hold them for 5m.
// Bare /challenges/sound stays the accept clip for older cached client JS.
const SOUND_KEYS = { accept: 'quest-accept', complete: 'challenge-complete', levelup: 'level-up' };
const soundCache = {};
router.get('/sound/:name?', async (req, res) => {
  try {
    const key = SOUND_KEYS[req.params.name || 'accept'];
    if (!key) return res.status(404).end();
    let hit = soundCache[key];
    if (!hit || Date.now() - hit.at > 60000) {
      const { data } = await req.sb.from('site_assets').select('mime, data_b64').eq('key', key).maybeSingle();
      if (!data) return res.status(404).end();
      hit = soundCache[key] = { at: Date.now(), mime: data.mime || 'audio/mpeg', buf: Buffer.from(data.data_b64, 'base64') };
    }
    res.set('Content-Type', hit.mime);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(hit.buf);
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

// ---------- Tailored electives ----------
// Accepting an elective copies it into user_custom_challenges, which already
// has the full accept/finish/abandon/dashboard-pinning plumbing. tailored_id
// remembers where it came from so the same elective is never offered twice.
router.post('/tailored/:id/accept', async (req, res, next) => {
  try {
    const { data: t } = await req.sb.from('tailored_challenges').select('*').eq('id', req.params.id).eq('is_active', true).maybeSingle();
    if (!t) return res.redirect('/challenges');
    const { data: existing } = await req.sb.from('user_custom_challenges').select('id, status').eq('user_id', req.user.id).eq('tailored_id', t.id).maybeSingle();
    if (existing) return res.redirect('/challenges');
    const duration = cleanDuration(req.body.duration_days || t.suggested_days);
    await req.sb.from('user_custom_challenges').insert({
      user_id: req.user.id, tailored_id: t.id,
      title: t.title, description: t.description, emoji: t.emoji,
      xp_reward: t.xp_reward, suggested_days: t.suggested_days,
      status: 'active', duration_days: duration,
      due_date: new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10),
      accepted_at: new Date().toISOString()
    });
    await awardXP(req.sb, req.user.id, req.profile, 5, 'Accepted challenge: ' + t.title, 'tailored_challenges', t.id);
    if (isPaid(req)) await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the challenge \u201c' + t.title + '\u201d', 'tailored_challenges', t.id);
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

// ---------- AI-tailored challenge sets (paid) ----------
router.post('/generate', async (req, res, next) => {
  try {
    if (!isPaid(req)) return gate(res, 'ai_challenges');
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('user_id', req.user.id).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bp) return res.redirect('/challenges?msg=' + encodeURIComponent('Create a launch blueprint first, then I can tailor challenges to it.'));
    let items;
    try { items = await ai.generateChallenges(req.accessToken, bp); }
    catch (err) { return res.redirect('/challenges?msg=' + encodeURIComponent('Could not generate challenges: ' + err.message)); }
    if (!Array.isArray(items) || !items.length) return res.redirect('/challenges?msg=' + encodeURIComponent('No challenges were generated \u2014 please try again.'));
    // Replace not-yet-completed AI challenges (pending/abandoned) with the fresh set.
    await req.sb.from('user_custom_challenges').delete().eq('user_id', req.user.id).in('status', ['pending', 'abandoned']).is('tailored_id', null);
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

// Accept/finish/abandon a personal challenge (AI set or accepted elective).
// No paywall here: whoever holds a challenge can play it out — the paywall
// sits on generation, not on finishing what you started.
router.post('/custom/:id/accept', async (req, res, next) => {
  try {
    const duration = cleanDuration(req.body.duration_days);
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status !== 'completed') {
      const due = new Date(Date.now() + duration * 86400000).toISOString().slice(0, 10);
      await req.sb.from('user_custom_challenges').update({ status: 'active', duration_days: duration, due_date: due, accepted_at: new Date().toISOString(), completed_at: null }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, 5, 'Accepted challenge: ' + c.title, 'user_custom_challenges', c.id);
      if (isPaid(req)) await notifySocial(req.sb, req.user.id, nameOf(req) + ' took on the challenge \u201c' + c.title + '\u201d', 'user_custom_challenges', c.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

router.post('/custom/:id/finish', async (req, res, next) => {
  try {
    const { data: c } = await req.sb.from('user_custom_challenges').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (c && c.status === 'active') {
      await req.sb.from('user_custom_challenges').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', c.id);
      await awardXP(req.sb, req.user.id, req.profile, c.xp_reward || 50, 'Completed challenge: ' + c.title, 'user_custom_challenges', c.id);
      if (isPaid(req)) await notifySocial(req.sb, req.user.id, nameOf(req) + ' completed the challenge \u201c' + c.title + '\u201d \ud83c\udf89', 'user_custom_challenges', c.id);
    }
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

router.post('/custom/:id/abandon', async (req, res, next) => {
  try {
    await req.sb.from('user_custom_challenges').update({ status: 'abandoned' }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect(req.body.from === 'dashboard' ? '/dashboard' : '/challenges');
  } catch (e) { next(e); }
});

module.exports = router;
