// The social feed: what members post, mixed with the results they share.
//
// Posts, comments and reactions live in posts / post_comments /
// post_reactions, which already had their row policies (anyone reads, you
// write your own) and count-keeping triggers; nothing used them until now.
// Results — wins on the wall, challenges completed — come from
// activity_events and sit in the same timeline.
//
// Blocks hide people in both directions, the same rule messages use.

const activity = require('./activity');

const TYPES = {
  insight:  { label: 'Update',   emoji: '💬' },
  question: { label: 'Question', emoji: '❓' },
  resource: { label: 'Resource', emoji: '🔗' },
  win:      { label: 'Result',   emoji: '🏁' }
};
const MAX_POST = 500;      // posts.content check
const MAX_COMMENT = 280;   // post_comments.content check
const COMMENTS_SHOWN = 3;

async function blockSets(sb, me) {
  const [{ data: mine }, { data: theirs }] = await Promise.all([
    sb.from('user_blocks').select('blocked_id').eq('blocker_id', me),
    sb.from('user_blocks').select('blocker_id').eq('blocked_id', me)
  ]);
  return {
    iBlocked: new Set((mine || []).map(b => b.blocked_id)),
    blockedMe: new Set((theirs || []).map(b => b.blocker_id))
  };
}
const hiddenBy = b => id => b.iBlocked.has(id) || b.blockedMe.has(id);

async function profilesById(sb, ids) {
  if (!ids.length) return {};
  // '*' rather than a column list: headline arrives with a migration
  // (2026-11-01_phase1_public_side.sql), and naming a column that is not there
  // yet would fail the whole lookup and empty the feed.
  const { data } = await sb.from('profiles').select('*').in('id', [...new Set(ids)]);
  const by = {};
  (data || []).forEach(p => {
    if (p.account_status === 'deactivated') return;
    by[p.id] = { id: p.id, username: p.username, display_name: p.display_name, avatar_url: p.avatar_url, path: p.path, headline: p.headline || null };
  });
  return by;
}

// Comments for a set of posts, oldest first, with their authors attached.
async function commentsFor(sb, postIds, hidden) {
  if (!postIds.length) return {};
  const { data } = await sb.from('post_comments')
    .select('id, post_id, user_id, content, created_at')
    .in('post_id', postIds).order('created_at', { ascending: true }).limit(500);
  const rows = (data || []).filter(c => !hidden(c.user_id));
  const people = await profilesById(sb, rows.map(c => c.user_id));
  const out = {};
  rows.forEach(c => { if (people[c.user_id]) (out[c.post_id] = out[c.post_id] || []).push({ ...c, who: people[c.user_id] }); });
  return out;
}

async function decorate(sb, me, posts, hidden, { allComments = false } = {}) {
  const ids = posts.map(p => p.id);
  const [people, { data: mine }, comments] = await Promise.all([
    profilesById(sb, posts.map(p => p.user_id)),
    ids.length ? sb.from('post_reactions').select('post_id').eq('user_id', me).in('post_id', ids) : Promise.resolve({ data: [] }),
    commentsFor(sb, ids, hidden)
  ]);
  const liked = new Set((mine || []).map(r => r.post_id));
  return posts.filter(p => people[p.user_id]).map(p => {
    const all = comments[p.id] || [];
    return {
      ...p, who: people[p.user_id], type: TYPES[p.post_type] || TYPES.insight,
      likedByMe: liked.has(p.id), mine: p.user_id === me,
      comments: allComments ? all : all.slice(-COMMENTS_SHOWN), moreComments: allComments ? 0 : Math.max(0, all.length - COMMENTS_SHOWN)
    };
  });
}

/**
 * The timeline. `scope` is 'everyone' (all members' posts and shared results)
 * or 'following' (people you follow, plus yourself).
 */
// scope: 'everyone', 'following', or 'path' (members on the same path as
// `path`, the viewer's own).
async function timeline(sb, me, { scope = 'everyone', limit = 40, path = null } = {}) {
  const blocks = await blockSets(sb, me);
  const hidden = hiddenBy(blocks);
  const { data: follows } = await sb.from('follows').select('following_id').eq('follower_id', me);
  const followingIds = (follows || []).map(f => f.following_id);

  let q = sb.from('posts').select('id, user_id, post_type, content, link_url, link_title, like_count, comment_count, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  let onPath = null;
  if (scope === 'path') {
    const { data: ps } = path ? await sb.from('profiles').select('id').eq('path', path).eq('account_status', 'active').limit(1000) : { data: [] };
    onPath = new Set((ps || []).map(p => p.id).concat(me));
    q = q.in('user_id', [...onPath]);
  }
  if (scope === 'following') q = q.in('user_id', followingIds.concat(me));
  const { data: rawPosts } = await q;
  const posts = await decorate(sb, me, (rawPosts || []).filter(p => !hidden(p.user_id)), hidden);

  // Shared results. activity_events' row policy already limits what anyone
  // can see (own, followed, public profiles, never across a block).
  let events = [];
  if (scope === 'following') {
    events = (await activity.feedFor(sb, me, { limit: 30 })).events;
  } else {
    const { data } = await sb.from('activity_events')
      .select('id, user_id, kind, title, emoji, entity_type, entity_id, created_at')
      .in('kind', ['win', 'challenge']).order('created_at', { ascending: false }).limit(30);
    const people = await profilesById(sb, (data || []).map(e => e.user_id));
    events = (data || []).filter(e => people[e.user_id]).map(e => ({ ...e, who: people[e.user_id] }));
  }
  events = events.filter(e => !hidden(e.user_id) && ['win', 'challenge'].includes(e.kind) && (!onPath || onPath.has(e.user_id)));

  const items = posts.map(p => ({ item: 'post', at: p.created_at, post: p }))
    .concat(events.map(e => ({ item: 'event', at: e.created_at, event: e })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
  return { items, following: followingIds.length };
}

// One post with every comment, or null if it is gone or hidden by a block.
async function one(sb, me, id) {
  const { data: p } = await sb.from('posts')
    .select('id, user_id, post_type, content, link_url, link_title, like_count, comment_count, created_at')
    .eq('id', id).maybeSingle();
  if (!p) return null;
  const hidden = hiddenBy(await blockSets(sb, me));
  if (hidden(p.user_id)) return null;
  return (await decorate(sb, me, [p], hidden, { allComments: true }))[0] || null;
}

// A member's own posts, for their profile.
async function byMember(sb, me, userId, limit = 10) {
  const hidden = hiddenBy(await blockSets(sb, me));
  if (hidden(userId)) return [];
  const { data } = await sb.from('posts')
    .select('id, user_id, post_type, content, link_url, link_title, like_count, comment_count, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  return decorate(sb, me, data || [], hidden);
}

module.exports = { TYPES, MAX_POST, MAX_COMMENT, blockSets, timeline, one, byMember };
