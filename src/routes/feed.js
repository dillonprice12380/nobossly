// What the people you follow have been doing.
//
// Following already existed — follows table, follow/unfollow routes, counts on
// the member directory — but it did nothing you could look at. notify_social()
// fanned achievements out as notifications, which you clear and then cannot
// find again, and the one achievement most worth seeing (reaching a rung) was
// never fanned out at all.
//
// This is free, and stays free. The community is the retention engine and free
// members posting wins ARE the product for paying ones; putting a wall in front
// of it would cost more than it earned.
const router = require('express').Router();
const activity = require('../activity');
const ladders = require('../ladders');
const paths = require('../paths');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { events, following } = await activity.feedFor(req.sb, req.user.id, { limit: 60 });

    // An empty feed gets people to follow, not an empty page — never the
    // member themselves, and never someone they already follow.
    let suggestions = [];
    if (!following || !events.length) {
      const { data: mine } = await req.sb.from('follows').select('following_id').eq('follower_id', req.user.id);
      const skip = new Set([req.user.id].concat((mine || []).map(f => f.following_id)));
      const { data } = await req.sb.from('profiles')
        .select('id, username, display_name, avatar_url, current_level, path')
        .eq('account_status', 'active').eq('profile_is_public', true)
        .order('xp_total', { ascending: false })
        .limit(6 + skip.size);
      suggestions = (data || []).filter(p => !skip.has(p.id)).slice(0, 6);
    }

    res.render('feed', {
      title: 'Your feed',
      events, following, suggestions,
      // Each member's rung title has to be read from THEIR ladder, not the
      // viewer's — nine paths means Level 4 is "Regular" for a creator and
      // "Quoting" for a plumber, and rendering the viewer's word over someone
      // else's achievement is the exact bug this helper exists to prevent.
      rungTitle: (path, level) => {
        const r = (ladders.ladderFor(path) || []).find(x => x.level === level);
        return r ? r.title : '';
      },
      pathLabel: (slug) => { const p = paths.get(slug); return p ? p.label : ''; }
    });
  } catch (e) { next(e); }
});

module.exports = router;
