// The follower feed's writer.
//
// notify_social() already fans achievements out to the people who follow you,
// but only as notifications: they arrive in the bell, get marked read, and are
// gone. There was nowhere to go and look at what the people you follow have
// been doing — which is the whole point of following someone.
//
// So every achievement now writes two things: the notification, which is a
// nudge, and an activity_events row, which is a place. They are deliberately
// separate — a feed you can scroll a month later should not be emptied by
// someone clearing their notifications.
//
// One rule: only real achievements. A feed that also carries "posted in the
// forum" and "logged in" trains people to ignore it, and then reaching Level 5
// scrolls past unread. Nothing goes in here that did not require something to
// happen in the world.

// Never throws and never blocks the thing that triggered it. Failing to record
// that someone reached a rung must not be able to fail the rung.
async function record(sb, userId, kind, title, opts) {
  const o = opts || {};
  try {
    await sb.from('activity_events').insert({
      user_id: userId,
      kind,
      title: String(title || '').slice(0, 300),
      emoji: o.emoji ? String(o.emoji).slice(0, 8) : null,
      level: typeof o.level === 'number' ? o.level : null,
      entity_type: o.entityType || null,
      entity_id: o.entityId || null
    });
  } catch (e) {
    console.error('activity', kind, e && e.message);
  }
}

// What the people you follow have been doing. Ordered by when it happened, not
// by who it was, so the feed reads as a timeline rather than a directory.
//
// RLS decides visibility (own rows, people you follow, public profiles, never
// across a block), so this query does not re-implement it — it only narrows to
// the set worth showing.
async function feedFor(sb, userId, opts) {
  const o = opts || {};
  const limit = Math.min(100, Math.max(5, o.limit || 40));
  try {
    const { data: following } = await sb.from('follows')
      .select('following_id').eq('follower_id', userId);
    const ids = (following || []).map(f => f.following_id);
    if (!ids.length) return { events: [], following: 0 };

    const { data: rows } = await sb.from('activity_events')
      .select('id, user_id, kind, title, emoji, level, entity_type, entity_id, created_at')
      .in('user_id', ids)
      .order('created_at', { ascending: false })
      .limit(limit);

    const events = rows || [];
    if (!events.length) return { events: [], following: ids.length };

    // One lookup for the authors rather than a join, so a profile that has since
    // been deactivated simply drops out instead of breaking the page.
    const authorIds = [...new Set(events.map(e => e.user_id))];
    const { data: people } = await sb.from('profiles')
      .select('id, username, display_name, avatar_url, current_level, path')
      .in('id', authorIds);
    const by = {};
    (people || []).forEach(p => { by[p.id] = p; });

    return {
      following: ids.length,
      events: events.map(e => ({ ...e, who: by[e.user_id] || null })).filter(e => e.who)
    };
  } catch (e) {
    console.error('activity feed', e && e.message);
    return { events: [], following: 0 };
  }
}

// A single member's own achievements, for their profile page.
async function forUser(sb, userId, limit) {
  try {
    const { data } = await sb.from('activity_events')
      .select('id, kind, title, emoji, level, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(50, Math.max(3, limit || 10)));
    return data || [];
  } catch (_) { return []; }
}

module.exports = { record, feedFor, forUser };
