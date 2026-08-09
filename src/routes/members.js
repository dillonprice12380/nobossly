const router = require('express').Router();

// Helper: backfill any profiles that have no username yet (bare OAuth sign-ups).
// Uses the service role key so it bypasses RLS entirely. Fast no-op once every
// profile has been seeded; only calls auth.admin.listUsers when bare rows exist.
async function backfillBareProfiles() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const { serviceClient } = require('../supabase');
    const sc = serviceClient();
    const { data: bare } = await sc.from('profiles').select('id').is('username', null).limit(20);
    if (!bare || bare.length === 0) return;

    const { data: authData } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const authMap = {};
    for (const u of (authData && authData.users) || []) authMap[u.id] = u;

    for (const b of bare) {
      const u = authMap[b.id];
      if (!u) continue;
      const meta = u.user_metadata || {};
      const fullName = meta.full_name || meta.name || meta.display_name || '';
      const emailBase = ((u.email || 'founder').split('@')[0]
        .replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 20)) || 'founder';
      let finalUsername = null;
      for (let attempt = 0; attempt < 3 && !finalUsername; attempt++) {
        const tryName = attempt === 0
          ? emailBase
          : (emailBase.slice(0, 18) + '_' + u.id.slice(0, 3 + attempt));
        const { data: clash } = await sc.from('profiles')
          .select('id').eq('username', tryName).neq('id', u.id).maybeSingle();
        if (!clash) finalUsername = tryName;
      }
      if (!finalUsername) finalUsername = emailBase.slice(0, 12) + '_' + u.id.slice(0, 8);
      await sc.from('profiles').update({
        username: finalUsername,
        display_name: fullName || finalUsername,
        needs_username: true,
        account_status: 'active'
      }).eq('id', u.id).is('username', null);
    }
  } catch (_) { /* non-fatal: service role not configured or transient error */ }
}

// Member directory
router.get('/', async (req, res, next) => {
  try {
    // Auto-fix any bare OAuth profiles before rendering the list so they show up
    // immediately without requiring a manual admin action.
    await backfillBareProfiles();

    const { data: members } = await req.sb.from('profiles')
      .select('username, display_name, profile_is_public, current_level, xp_total, created_at, avatar_url')
      .eq('account_status', 'active')
      .not('username', 'is', null)
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
    const [{ data: ub }, { data: um }, { data: levels }, { data: customM }] = await Promise.all([
      req.sb.from('user_badges').select('badge_id, earned_at').eq('user_id', p.id),
      req.sb.from('user_milestones').select('predefined_milestone_id, earned_at').eq('user_id', p.id).eq('pinned', true).order('earned_at', { ascending: false }),
      req.sb.from('founder_levels').select('level, title, emoji'),
      req.sb.from('user_custom_milestones').select('title, emoji, achieved_at').eq('user_id', p.id).eq('achieved', true).order('achieved_at', { ascending: false })
    ]);
    const badgeIds = (ub || []).map(b => b.badge_id);
    const milestoneIds = (um || []).map(m => m.predefined_milestone_id);
    const [{ data: badges }, { data: preMilestones }] = await Promise.all([
      badgeIds.length ? req.sb.from('badges').select('id, name, emoji, tier, description').in('id', badgeIds) : { data: [] },
      milestoneIds.length ? req.sb.from('predefined_milestones').select('id, title, emoji').in('id', milestoneIds) : { data: [] }
    ]);
    const milestones = [...(preMilestones || []), ...((customM || []).map(c => ({ emoji: c.emoji, title: c.title })))];
    const lvl = (levels || []).find(l => l.level === (p.current_level || 1)) || { title: 'Dreamer', emoji: '\uD83C\uDF31' };
    const isMe = p.id === req.user.id;
    const isPrivate = p.profile_is_public === false && !isMe;
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
