const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { safeBack, relativePath } = require('../safe_back');

const { quiet } = require('../db');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notify(req, targetUser, message, entityType, entityId) {
  return req.sb.rpc('push_notification', {
    target_user: targetUser, ntype: 'social', nmessage: message,
    nentity_type: entityType || null, nentity_id: entityId || null
  }).then(...quiet('push_notification:social'));
}

// ---------------- Reports ----------------
const REPORT_TYPES = { forum_thread: 'forum post', forum_reply: 'forum comment', user: 'member', message: 'message', group_post: 'group post' };

router.get('/report', requireAuth, (req, res) => {
  const type = req.query.type, id = req.query.id;
  if (!REPORT_TYPES[type] || !UUID_RE.test(id || '')) return res.redirect(safeBack(req, '/community'));
  res.render('report', { title: 'Report ' + REPORT_TYPES[type], type, id, label: REPORT_TYPES[type], back: relativePath(req.query.back) || safeBack(req, '/community'), done: false });
});

router.post('/report', requireAuth, async (req, res, next) => {
  try {
    const { type, id, reason, details, back } = req.body;
    if (REPORT_TYPES[type] && UUID_RE.test(id || '')) {
      await req.sb.from('reports').insert({
        reporter_id: req.user.id, target_type: type, target_id: id,
        reason: (reason || 'other').slice(0, 60), details: (details || '').slice(0, 2000)
      });
    }
    res.render('report', { title: 'Report submitted', type: null, id: null, label: null, back: back || '/community', done: true });
  } catch (e) { next(e); }
});

// ---------------- Blocks ----------------
router.post('/block/:userId', requireAuth, async (req, res, next) => {
  try {
    if (req.params.userId !== req.user.id) {
      await req.sb.from('user_blocks').upsert({ blocker_id: req.user.id, blocked_id: req.params.userId }, { onConflict: 'blocker_id,blocked_id' });
      await req.sb.from('friendships').delete().or(`and(requester_id.eq.${req.user.id},addressee_id.eq.${req.params.userId}),and(requester_id.eq.${req.params.userId},addressee_id.eq.${req.user.id})`);
      await req.sb.from('follows').delete().or(`and(follower_id.eq.${req.user.id},following_id.eq.${req.params.userId}),and(follower_id.eq.${req.params.userId},following_id.eq.${req.user.id})`);
    }
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

router.post('/unblock/:userId', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('user_blocks').delete().eq('blocker_id', req.user.id).eq('blocked_id', req.params.userId);
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

// ---------------- Follows ----------------
router.post('/follow/:userId', requireAuth, async (req, res, next) => {
  try {
    if (req.params.userId !== req.user.id) {
      const { error } = await req.sb.from('follows').upsert({ follower_id: req.user.id, following_id: req.params.userId }, { onConflict: 'follower_id,following_id' });
      if (!error) await notify(req, req.params.userId, (req.profile.display_name || req.profile.username || 'A member') + ' started following you', 'profiles', req.user.id);
    }
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

router.post('/unfollow/:userId', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', req.params.userId);
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

// ---------------- Friends ----------------
router.post('/friends/request/:userId', requireAuth, async (req, res, next) => {
  try {
    if (req.params.userId !== req.user.id) {
      const { data: existing } = await req.sb.from('friendships').select('*')
        .or(`and(requester_id.eq.${req.user.id},addressee_id.eq.${req.params.userId}),and(requester_id.eq.${req.params.userId},addressee_id.eq.${req.user.id})`).maybeSingle();
      if (!existing) {
        const { error } = await req.sb.from('friendships').insert({ requester_id: req.user.id, addressee_id: req.params.userId });
        if (!error) await notify(req, req.params.userId, (req.profile.display_name || req.profile.username || 'A member') + ' sent you a friend request', 'profiles', req.user.id);
      } else if (existing.status === 'declined' && existing.requester_id === req.user.id) {
        await req.sb.from('friendships').update({ status: 'pending', responded_at: null }).eq('id', existing.id);
      }
    }
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

router.post('/friends/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const { data: f } = await req.sb.from('friendships').select('*').eq('id', req.params.id).eq('addressee_id', req.user.id).maybeSingle();
    if (f) {
      await req.sb.from('friendships').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('id', f.id);
      await notify(req, f.requester_id, (req.profile.display_name || req.profile.username || 'A member') + ' accepted your friend request', 'profiles', req.user.id);
    }
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

router.post('/friends/:id/decline', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('friendships').update({ status: 'declined', responded_at: new Date().toISOString() }).eq('id', req.params.id).eq('addressee_id', req.user.id);
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

router.post('/friends/:id/remove', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('friendships').delete().eq('id', req.params.id).or(`requester_id.eq.${req.user.id},addressee_id.eq.${req.user.id}`);
    res.redirect(safeBack(req, '/members'));
  } catch (e) { next(e); }
});

// Groups and cohorts moved to src/routes/groups.js (Phase 3).

module.exports = router;
