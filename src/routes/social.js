const router = require('express').Router();
const { requireAuth, requirePaid } = require('../middleware/auth');

const slugify = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || ('group-' + Date.now());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notify(req, targetUser, message, entityType, entityId) {
  return req.sb.rpc('push_notification', {
    target_user: targetUser, ntype: 'social', nmessage: message,
    nentity_type: entityType || null, nentity_id: entityId || null
  }).then(() => {}, () => {});
}

// ---------------- Reports ----------------
const REPORT_TYPES = { forum_thread: 'forum post', forum_reply: 'forum comment', user: 'member', message: 'message' };

router.get('/report', requireAuth, (req, res) => {
  const type = req.query.type, id = req.query.id;
  if (!REPORT_TYPES[type] || !UUID_RE.test(id || '')) return res.redirect(req.get('referer') || '/community');
  res.render('report', { title: 'Report ' + REPORT_TYPES[type], type, id, label: REPORT_TYPES[type], back: req.query.back || req.get('referer') || '/community', done: false });
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
    res.redirect(req.body.back || req.get('referer') || '/members');
  } catch (e) { next(e); }
});

router.post('/unblock/:userId', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('user_blocks').delete().eq('blocker_id', req.user.id).eq('blocked_id', req.params.userId);
    res.redirect(req.body.back || req.get('referer') || '/members');
  } catch (e) { next(e); }
});

// ---------------- Follows ----------------
router.post('/follow/:userId', requireAuth, async (req, res, next) => {
  try {
    if (req.params.userId !== req.user.id) {
      const { error } = await req.sb.from('follows').upsert({ follower_id: req.user.id, following_id: req.params.userId }, { onConflict: 'follower_id,following_id' });
      if (!error) await notify(req, req.params.userId, (req.profile.display_name || req.profile.username || 'A founder') + ' started following you', 'profiles', req.user.id);
    }
    res.redirect(req.body.back || req.get('referer') || '/members');
  } catch (e) { next(e); }
});

router.post('/unfollow/:userId', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', req.params.userId);
    res.redirect(req.body.back || req.get('referer') || '/members');
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
        if (!error) await notify(req, req.params.userId, (req.profile.display_name || req.profile.username || 'A founder') + ' sent you a friend request', 'profiles', req.user.id);
      } else if (existing.status === 'declined' && existing.requester_id === req.user.id) {
        await req.sb.from('friendships').update({ status: 'pending', responded_at: null }).eq('id', existing.id);
      }
    }
    res.redirect(req.body.back || req.get('referer') || '/members');
  } catch (e) { next(e); }
});

router.post('/friends/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const { data: f } = await req.sb.from('friendships').select('*').eq('id', req.params.id).eq('addressee_id', req.user.id).maybeSingle();
    if (f) {
      await req.sb.from('friendships').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('id', f.id);
      await notify(req, f.requester_id, (req.profile.display_name || req.profile.username || 'A founder') + ' accepted your friend request', 'profiles', req.user.id);
    }
    res.redirect(req.body.back || req.get('referer') || '/members');
  } catch (e) { next(e); }
});

router.post('/friends/:id/decline', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('friendships').update({ status: 'declined', responded_at: new Date().toISOString() }).eq('id', req.params.id).eq('addressee_id', req.user.id);
    res.redirect(req.body.back || req.get('referer') || '/members');
  } catch (e) { next(e); }
});

router.post('/friends/:id/remove', requireAuth, async (req, res, next) => {
  try {
    await req.sb.from('friendships').delete().eq('id', req.params.id).or(`requester_id.eq.${req.user.id},addressee_id.eq.${req.user.id}`);
    res.redirect(req.body.back || req.get('referer') || '/members');
  } catch (e) { next(e); }
});

// ---------------- Groups ----------------
router.get('/groups', requireAuth, async (req, res, next) => {
  try {
    const { data: groups } = await req.sb.from('groups').select('*').order('created_at', { ascending: false }).limit(100);
    const ids = (groups || []).map(g => g.id);
    let counts = {}, mine = new Set();
    if (ids.length) {
      const { data: members } = await req.sb.from('group_members').select('group_id, user_id').in('group_id', ids);
      (members || []).forEach(m => { counts[m.group_id] = (counts[m.group_id] || 0) + 1; if (m.user_id === req.user.id) mine.add(m.group_id); });
    }
    res.render('groups/index', { title: 'Groups', groups: groups || [], counts, mine, canCreate: res.locals.plan === 'paid' });
  } catch (e) { next(e); }
});

router.post('/groups', requireAuth, requirePaid, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim().slice(0, 80);
    if (!name) return res.redirect('/groups');
    const slug = slugify(name) + '-' + Math.random().toString(36).slice(2, 6);
    const { data: g, error } = await req.sb.from('groups').insert({ name, slug, description: (req.body.description || '').slice(0, 600), owner_id: req.user.id }).select().maybeSingle();
    if (error) throw error;
    await req.sb.from('group_members').insert({ group_id: g.id, user_id: req.user.id, role: 'owner' });
    res.redirect('/groups/' + g.slug);
  } catch (e) { next(e); }
});

router.get('/groups/:slug', requireAuth, async (req, res, next) => {
  try {
    const { data: group } = await req.sb.from('groups').select('*').eq('slug', req.params.slug).maybeSingle();
    if (!group) return res.status(404).render('error', { title: 'Not found', message: 'Group not found.' });
    const [{ data: members }, { data: posts }] = await Promise.all([
      req.sb.from('group_members').select('user_id, role, joined_at').eq('group_id', group.id).order('joined_at'),
      req.sb.from('group_posts').select('*').eq('group_id', group.id).order('created_at', { ascending: false }).limit(100)
    ]);
    const userIds = [...new Set([...(members || []).map(m => m.user_id), ...(posts || []).map(p => p.user_id)])];
    const { data: profiles } = userIds.length ? await req.sb.from('profiles').select('id, username, display_name, current_level').in('id', userIds) : { data: [] };
    const pmap = {}; (profiles || []).forEach(p => pmap[p.id] = p);
    const isMember = (members || []).some(m => m.user_id === req.user.id);
    const isOwner = group.owner_id === req.user.id;
    res.render('groups/show', { title: group.name, group, members: members || [], posts: posts || [], pmap, isMember, isOwner });
  } catch (e) { next(e); }
});

router.post('/groups/:slug/join', requireAuth, async (req, res, next) => {
  try {
    const { data: group } = await req.sb.from('groups').select('id, slug').eq('slug', req.params.slug).maybeSingle();
    if (group) await req.sb.from('group_members').upsert({ group_id: group.id, user_id: req.user.id }, { onConflict: 'group_id,user_id' });
    res.redirect('/groups/' + req.params.slug);
  } catch (e) { next(e); }
});

router.post('/groups/:slug/leave', requireAuth, async (req, res, next) => {
  try {
    const { data: group } = await req.sb.from('groups').select('id, owner_id').eq('slug', req.params.slug).maybeSingle();
    if (group && group.owner_id !== req.user.id) await req.sb.from('group_members').delete().eq('group_id', group.id).eq('user_id', req.user.id);
    res.redirect('/groups');
  } catch (e) { next(e); }
});

router.post('/groups/:slug/post', requireAuth, async (req, res, next) => {
  try {
    const body = (req.body.body || '').trim().slice(0, 3000);
    const { data: group } = await req.sb.from('groups').select('id').eq('slug', req.params.slug).maybeSingle();
    if (group && body) await req.sb.from('group_posts').insert({ group_id: group.id, user_id: req.user.id, body });
    res.redirect('/groups/' + req.params.slug);
  } catch (e) { next(e); }
});

router.post('/groups/:slug/delete', requireAuth, async (req, res, next) => {
  try {
    const { data: group } = await req.sb.from('groups').select('id, owner_id').eq('slug', req.params.slug).maybeSingle();
    if (group && (group.owner_id === req.user.id || (req.profile && req.profile.is_admin))) {
      await req.sb.from('groups').delete().eq('id', group.id);
    }
    res.redirect('/groups');
  } catch (e) { next(e); }
});

module.exports = router;
