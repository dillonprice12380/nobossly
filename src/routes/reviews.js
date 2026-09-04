const router = require('express').Router();
const { awardXP } = require('../xp');
const { notifySocial } = require('../notify');
const { planOf } = require('../middleware/auth');

// The peer-review route to "Get 3 Feedback Sessions".
//
// That quest previously had exactly one route: talk to three people off-site
// and upload a proof note. That still works — a founder with a real network
// should not be pushed through a forum. This adds a second route that runs on
// the platform, where the thing that unblocks you is the thing other people
// need from you: giving a review earns XP, receiving three clears your gate.
//
// One table, two kinds of row (see the migration): a REQUEST has request_id
// null; a REVIEW points at it. A database trigger binds every review's
// submitter_id, title and review_type from its parent request, so none of the
// counting below can be walked around by posting rows directly.

const REVIEW_XP = 60;          // matches the "Give a Peer Review" challenge
const SESSIONS_NEEDED = 3;
const GATE_CHALLENGE = 'Get 3 Feedback Sessions';
const GIVER_CHALLENGE = 'Give a Peer Review';

// A review short enough to write without reading is not feedback. This is the
// cheapest guard that makes "looks good!" fail, and it is the one that decides
// whether this route is worth anything.
const MIN_FEEDBACK = 120;

const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const nameOf = req => (req.profile && (req.profile.display_name || req.profile.username)) || 'A founder';

// The rubric a reviewer answers. Scores are stored as jsonb so the shape can
// grow without a migration; the labels live here so the form and the rendered
// review always agree.
const RUBRIC = [
  { key: 'clarity', label: 'Could you tell what it is and who it is for?' },
  { key: 'problem', label: 'Does it solve a problem you believe is real?' },
  { key: 'edge', label: 'Is there a reason this founder wins at it?' },
  { key: 'would_pay', label: 'Would you, or someone you know, pay for it?' }
];

const scoreOf = v => { const n = parseInt(v, 10); return (n >= 1 && n <= 5) ? n : null; };

// Marks a named challenge complete for a user, idempotently. Used for both
// sides of this feature, so the ladder sees peer-review work exactly as it sees
// a challenge finished the ordinary way.
async function completeChallenge(req, title, note) {
  const { data: ch } = await req.sb.from('challenges').select('id, title, xp_reward').eq('title', title).maybeSingle();
  if (!ch) return null;
  const { data: existing } = await req.sb.from('challenge_completions')
    .select('id').eq('user_id', req.user.id).eq('challenge_id', ch.id).maybeSingle();
  if (existing) return null;
  const { error } = await req.sb.from('challenge_completions')
    .insert({ user_id: req.user.id, challenge_id: ch.id, proof_note: note || '' });
  if (error) return null;          // raced with another request — nothing to do
  await req.sb.from('challenge_acceptances')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('user_id', req.user.id).eq('challenge_id', ch.id).eq('status', 'active')
    .then(() => {}, () => {});
  await awardXP(req.sb, req.user.id, req.profile, ch.xp_reward || 50, 'Completed challenge: ' + ch.title, 'challenges', ch.id);
  return ch;
}

// Display names for the people on screen. Reviewer identity matters here — a
// review from a named member reads differently from an anonymous one.
async function namesFor(req, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return {};
  const { data } = await req.sb.from('profiles').select('id, username, display_name').in('id', want);
  const map = {};
  (data || []).forEach(p => { map[p.id] = p.display_name || p.username || 'A founder'; });
  return map;
}

// ---------- the queue ----------

router.get('/', async (req, res, next) => {
  try {
    // Claim the gate here rather than at the moment the third review lands:
    // that write belongs to the founder who asked, and only their own client
    // can make it under RLS. A visit is enough, and the engine is self-healing
    // if they never come back to this page — the challenge is also claimable
    // from the dashboard sweep.
    let claimed = null;
    try { claimed = await claimFeedbackGate(req); } catch (_) { /* never block the page */ }

    const [{ data: open }, { data: mine }, { data: given }] = await Promise.all([
      // Other people's requests, oldest first: a queue that serves the longest
      // wait first is one people trust enough to post into.
      req.sb.from('peer_reviews').select('*')
        .is('request_id', null).neq('submitter_id', req.user.id)
        .in('status', ['pending', 'in_review']).order('created_at').limit(50),
      req.sb.from('peer_reviews').select('*')
        .is('request_id', null).eq('submitter_id', req.user.id)
        .order('created_at', { ascending: false }),
      req.sb.from('peer_reviews').select('*')
        .not('request_id', 'is', null).eq('reviewer_id', req.user.id)
        .order('created_at', { ascending: false }).limit(20)
    ]);

    const openList = open || [];
    const mineList = mine || [];

    // How many reviews each request already has, and which ones this founder
    // has already answered — both needed to render the queue honestly rather
    // than offering work that is already done.
    const ids = openList.concat(mineList).map(r => r.id);
    let counts = {}, reviewed = new Set();
    if (ids.length) {
      const { data: rv } = await req.sb.from('peer_reviews')
        .select('request_id, reviewer_id').in('request_id', ids).eq('status', 'completed');
      (rv || []).forEach(r => {
        counts[r.request_id] = (counts[r.request_id] || 0) + 1;
        if (r.reviewer_id === req.user.id) reviewed.add(r.request_id);
      });
    }

    const received = mineList.reduce((n, r) => n + (counts[r.id] || 0), 0);
    const names = await namesFor(req, openList.map(r => r.submitter_id));

    res.render('reviews', {
      title: 'Peer review',
      open: openList.map(r => ({ ...r, reviews: counts[r.id] || 0, reviewedByMe: reviewed.has(r.id), who: names[r.submitter_id] || 'A founder' })),
      mine: mineList.map(r => ({ ...r, reviews: counts[r.id] || 0 })),
      given: given || [],
      received, needed: SESSIONS_NEEDED,
      minFeedback: MIN_FEEDBACK,
      claimed,
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// ---------- asking for review ----------

router.post('/new', async (req, res, next) => {
  try {
    const b = req.body || {};
    const title = s(b.title, 140);
    const description = s(b.description, 4000);
    if (!title || description.length < 40) {
      return res.redirect('/reviews?msg=' + encodeURIComponent('Give your request a name and enough detail to review — a couple of sentences at minimum.'));
    }
    const TYPES = ['idea', 'blueprint', 'landing_page', 'pitch_deck', 'copy', 'pricing', 'general'];
    const type = TYPES.includes(b.review_type) ? b.review_type : 'idea';
    const url = s(b.url_or_content, 500);
    const { data: created, error } = await req.sb.from('peer_reviews').insert({
      submitter_id: req.user.id, review_type: type, title, description,
      url_or_content: /^https?:\/\//i.test(url) ? url : null,
      status: 'pending'
    }).select('id').maybeSingle();
    if (error || !created) throw (error || new Error('could not post your request'));
    res.redirect('/reviews/' + created.id);
  } catch (e) { next(e); }
});

router.post('/:id/withdraw', async (req, res, next) => {
  try {
    await req.sb.from('peer_reviews').update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('submitter_id', req.user.id).is('request_id', null);
    res.redirect('/reviews');
  } catch (e) { next(e); }
});

// ---------- one request ----------

router.get('/:id', async (req, res, next) => {
  try {
    const { data: reqRow } = await req.sb.from('peer_reviews').select('*')
      .eq('id', req.params.id).is('request_id', null).maybeSingle();
    if (!reqRow) return res.redirect('/reviews');
    const { data: reviews } = await req.sb.from('peer_reviews').select('*')
      .eq('request_id', reqRow.id).eq('status', 'completed').order('created_at');
    const list = reviews || [];
    const names = await namesFor(req, list.map(r => r.reviewer_id).concat([reqRow.submitter_id]));
    const isMine = reqRow.submitter_id === req.user.id;
    res.render('review_detail', {
      title: reqRow.title,
      request: reqRow, reviews: list, names,
      isMine,
      alreadyReviewed: list.some(r => r.reviewer_id === req.user.id),
      canReview: !isMine && ['pending', 'in_review'].includes(reqRow.status),
      rubric: RUBRIC, minFeedback: MIN_FEEDBACK,
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// ---------- giving a review ----------

router.post('/:id/review', async (req, res, next) => {
  try {
    const back = '/reviews/' + req.params.id;
    const { data: reqRow } = await req.sb.from('peer_reviews').select('*')
      .eq('id', req.params.id).is('request_id', null).maybeSingle();
    if (!reqRow) return res.redirect('/reviews');
    // Both of these are enforced in the database too; checking here is only so
    // the founder gets a sentence instead of a stack trace.
    if (reqRow.submitter_id === req.user.id) {
      return res.redirect(back + '?msg=' + encodeURIComponent('You cannot review your own request.'));
    }
    if (!['pending', 'in_review'].includes(reqRow.status)) {
      return res.redirect(back + '?msg=' + encodeURIComponent('This request is closed.'));
    }

    const b = req.body || {};
    const feedback = s(b.feedback, 4000);
    if (feedback.length < MIN_FEEDBACK) {
      return res.redirect(back + '?msg=' + encodeURIComponent(
        'A review needs at least ' + MIN_FEEDBACK + ' characters — say what you would change and why. Yours was ' + feedback.length + '.'));
    }
    const rating = scoreOf(b.rating);
    if (!rating) return res.redirect(back + '?msg=' + encodeURIComponent('Give it an overall rating from 1 to 5.'));

    const scores = {};
    for (const r of RUBRIC) {
      const v = scoreOf(b['rubric_' + r.key]);
      if (!v) return res.redirect(back + '?msg=' + encodeURIComponent('Answer every rubric question before submitting.'));
      scores[r.key] = v;
    }

    // submitter_id, title and review_type are set by the trigger from the
    // parent request; sending them here would be ignored.
    const { error } = await req.sb.from('peer_reviews').insert({
      request_id: reqRow.id, submitter_id: reqRow.submitter_id, reviewer_id: req.user.id,
      review_type: reqRow.review_type, title: reqRow.title,
      feedback, rating, rubric_scores: scores, xp_awarded: REVIEW_XP, status: 'completed'
    });
    if (error) {
      // The unique index is the only thing this realistically hits.
      return res.redirect(back + '?msg=' + encodeURIComponent('You have already reviewed this one.'));
    }

    await awardXP(req.sb, req.user.id, req.profile, REVIEW_XP, 'Gave a peer review: ' + reqRow.title, 'peer_reviews', reqRow.id);
    await completeChallenge(req, GIVER_CHALLENGE, 'Reviewed a peer’s ' + reqRow.review_type + ' on NoBossly.');

    // Tell the founder somebody answered. This is the notification that makes
    // the queue feel alive rather than a form that swallows things.
    await req.sb.rpc('push_notification', {
      target_user: reqRow.submitter_id, ntype: 'community',
      nmessage: '💬 ' + nameOf(req) + ' reviewed “' + reqRow.title + '”',
      nentity_type: 'peer_reviews', nentity_id: reqRow.id
    }).then(() => {}, () => {});

    // Count the founder's completed reviews across ALL their requests, and
    // clear the gate at three.
    const { count } = await req.sb.from('peer_reviews')
      .select('id', { count: 'exact', head: true })
      .eq('submitter_id', reqRow.submitter_id).eq('status', 'completed').not('request_id', 'is', null);
    const total = count || 0;

    await req.sb.from('peer_reviews')
      .update({ status: total >= SESSIONS_NEEDED ? 'completed' : 'in_review', updated_at: new Date().toISOString() })
      .eq('id', reqRow.id).then(() => {}, () => {});

    if (total >= SESSIONS_NEEDED) {
      // The gate belongs to the founder who ASKED, not the reviewer, so it
      // cannot be completed through req.sb with the reviewer's own client here.
      // It is claimed on their next visit instead — see claimFeedbackGate.
      await req.sb.rpc('push_notification', {
        target_user: reqRow.submitter_id, ntype: 'challenges',
        nmessage: '🎯 Three peers have now reviewed your work — open Peer review to claim “' + GATE_CHALLENGE + '”.',
        nentity_type: 'peer_reviews', nentity_id: reqRow.id
      }).then(() => {}, () => {});
    }

    if (planOf(req.profile) === 'paid') {
      await notifySocial(req.sb, req.user.id, nameOf(req) + ' gave a peer review 💬', 'peer_reviews', reqRow.id).then(() => {}, () => {});
    }
    res.redirect(back + '?msg=' + encodeURIComponent('Review posted — +' + REVIEW_XP + ' XP. That is the half of this that makes the queue work.'));
  } catch (e) { next(e); }
});

// Claims "Get 3 Feedback Sessions" for the signed-in founder once three peers
// have reviewed their work. It runs on their own client, so RLS applies exactly
// as it would to any other challenge completion.
async function claimFeedbackGate(req) {
  const { count } = await req.sb.from('peer_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('submitter_id', req.user.id).eq('status', 'completed').not('request_id', 'is', null);
  if ((count || 0) < SESSIONS_NEEDED) return null;
  return completeChallenge(req, GATE_CHALLENGE,
    (count || 0) + ' peer reviews received on NoBossly.');
}

module.exports = router;
module.exports.claimFeedbackGate = claimFeedbackGate;
module.exports.RUBRIC = RUBRIC;
module.exports.MIN_FEEDBACK = MIN_FEEDBACK;
module.exports.SESSIONS_NEEDED = SESSIONS_NEEDED;
