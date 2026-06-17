const router = require('express').Router();

// Member directory
router.get('/', async (req, res, next) => {
  try {
    const { data: members } = await req.sb.from('profiles')
      .select('username, display_name, profile_is_public, current_level, xp_total, created_at, avatar_url')
      .eq('account_status', 'active')
      .order('xp_total', { ascending: false })
      .limit(200);
    const { data: levels } = await req.sb.from('founder_levels').select('level, title, emoji');
    res.render('members', { title: 'Members', members: members || [], levels: levels || [] });
  } catch (e) { next(e); }
});

// Edit own profile
router.get('/me/edit', (req, res) => {
  res.render('profile_edit', { title: 'Edit profile', p: req.profile, saved: req.query.saved });
});

router.post('/me/edit', async (req, res, next) => {
  try {
    const b = req.body;
    await req.sb.from('profiles').update({
      display_name: (b.display_name || '').slice(0, 60) || req.profile.username,
      bio: (b.bio || '').slice(0, 600),
      location: (b.location || '').slice(0, 80),
      website_url: (b.website_url || '').slice(0, 200),
      occupation: (b.occupation || '').slice(0, 80),
      founder_stage: b.founder_stage || null,
      notification_emails_enabled: b.notification_emails_enabled === 'on'
    }).eq('id', req.user.id);
    res.redirect('/members/me/edit?saved=1');
  } catch (e) { next(e); }
});

router.get('/:username', async (req, res, next) => {
  try {
    const { data: p } = await req.sb.from('profiles')
      .select('id, username, display_name, bio, location, website_url, occupation, founder_stage, xp_total, current_level, streak_days, tasks_completed, created_at, profile_is_public, account_status')
      .eq('username', req.params.username).maybeSingle();
    if (!p || (p.account_status !== 'active' && p.id !== req.user.id)) return res.status(404).render('error', { title: 'Not found', message: 'Member not found.' });
    const [{ data: ub }, { data: um }, { data: levels }] = await Promise.all([
      req.sb.from('user_badges').select('badge_id, earned_at').eq('user_id', p.id),
      req.sb.from('user_milestones').select('predefined_milestone_id, earned_at').eq('user_id', p.id).order('earned_at', { ascending: false }),
      req.sb.from('founder_levels').select('level, title, emoji')
    ]);
    const badgeIds = (ub || []).map(b => b.badge_id);
    const milestoneIds = (um || []).map(m => m.predefined_milestone_id);
    const [{ data: badges }, { data: milestones }] = await Promise.all([
      badgeIds.length ? req.sb.from('badges').select('id, name, emoji, tier, description').in('id', badgeIds) : { data: [] },
      milestoneIds.length ? req.sb.from('predefined_milestones').select('id, title, emoji').in('id', milestoneIds) : { data: [] }
    ]);
    const lvl = (levels || []).find(l => l.level === (p.current_level || 1)) || { title: 'Dreamer', emoji: '🌱' };
    const isMe = p.id === req.user.id;
    const isPrivate = p.profile_is_public === false && !isMe;
    // social context
    const [{ data: followRows }, { count: followerCount }, { count: followingCount }, { data: friendship }, { data: blockRow }, { data: blockedMeRow }, { count: friendCount }] = await Promise.all([
      req.sb.from('follows').select('follower_id').eq('follower_id', req.user.id).eq('following_id', p.id),
      req.sb.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', p.id),
      req.sb.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', p.id),
      req.sb.from('friendships').select('*').or(`and(requester_id.eq.${req.user.id},addressee_id.eq.${p.id}),and(requester_id.eq.${p.id},addressee_id.eq.${req.user.id})`).maybeSingle(),
      req.sb.from('user_blocks').select('blocked_id').eq('blocker_id', req.user.id).eq('blocked_id', p.id),
      req.sb.from('user_blocks').select('blocker_id').eq('blocker_id', p.id).eq('blocked_id', req.user.id),
      req.sb.from('friendships').select('id', { count: 'exact', head: true }).eq('status', 'accepted').or(`requester_id.eq.${p.id},addressee_id.eq.${p.id}`)
    ]);
    const social = {
      isFollowing: !!(followRows && followRows.length),
      followers: followerCount || 0,
      following: followingCount || 0,
      friends: friendCount || 0,
      friendship: friendship || null,
      iBlocked: !!(blockRow && blockRow.length),
      blockedMe: !!(blockedMeRow && blockedMeRow.length)
    };
    res.render('profile', { title: isPrivate ? p.username : (p.display_name || p.username), p, badges: badges || [], milestones: milestones || [], lvl, isMe, isPrivate, social });
  } catch (e) { next(e); }
});

module.exports = router;
