// Community helpers (src/routes/community.js, src/routes/coworking.js): the
// community home, "people on your path", and small lookups the Q&A, feed and
// members pages share.
//
// Reads use whatever client the page has: the member's own (RLS) or, for a
// signed-out visitor, the anon client. Anything a visitor may not read comes
// back empty and its section stays away.

const paths = require('./paths');

const pathLabel = slug => { const p = paths.get(slug); return p && slug ? p.label : ''; };
const pathEmoji = slug => { const p = paths.get(slug); return p && slug ? p.emoji : ''; };
const rowsOf = r => (r && !r.error && Array.isArray(r.data) ? r.data : []);
const safe = p => Promise.resolve(p).catch(() => null);

// forum_threads rows carry accepted_reply_id once migrations/2026-11-08_community.sql
// has run; from then on the database keeps counts and tells followers.
const dbKeepsThreads = t => !!t && Object.prototype.hasOwnProperty.call(t, 'accepted_reply_id');

// Active members on a path, by id.
async function peopleOnPath(sb, path, limit = 500) {
  if (!path) return [];
  const r = await safe(sb.from('profiles').select('id').eq('path', path).eq('account_status', 'active').limit(limit));
  return rowsOf(r).map(p => p.id);
}

// id → { display_name, username, path } for a list of ids.
async function profilesOf(sb, ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return {};
  const r = await safe(sb.from('profiles').select('id, display_name, username, path, avatar_url').in('id', list.slice(0, 200)));
  const out = {};
  rowsOf(r).forEach(p => { out[p.id] = p; });
  return out;
}

// The week's community challenge: the cohort running now, or the next one.
async function weeklyChallenge(sb, now = new Date()) {
  const r = await safe(sb.from('challenges').select('id, title, emoji, description, starts_at, ends_at, slug')
    .eq('is_cohort', true).eq('is_active', true).gte('ends_at', now.toISOString()).order('starts_at', { ascending: true }).limit(2));
  const rows = rowsOf(r);
  const running = rows.find(c => !c.starts_at || new Date(c.starts_at) <= now);
  return running ? Object.assign({ running: true }, running) : (rows[0] ? Object.assign({ running: false }, rows[0]) : null);
}

/**
 * Everything the community home shows. `me` is the signed-in member's
 * profile, or null. Returns plain data; a section with nothing is empty.
 */
async function home(sb, me, { coworking = null, now = new Date() } = {}) {
  const signedIn = !!(me && me.id);
  const [questions, unansweredR, posts, wins, groups, challenge, onPath, sessions] = await Promise.all([
    safe(sb.from('forum_threads').select('id, title, reply_count, created_at, user_id, last_reply_at').order('last_reply_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(5)),
    safe(sb.from('forum_threads').select('id, title, created_at, user_id').eq('reply_count', 0).order('created_at', { ascending: false }).limit(4)),
    signedIn ? safe(sb.from('posts').select('id, user_id, post_type, content, created_at, like_count, comment_count').order('created_at', { ascending: false }).limit(4)) : null,
    safe(sb.from('wins').select('id, title, amount_usd, user_id, approved_at').eq('approved', true).order('approved_at', { ascending: false }).limit(3)),
    safe(sb.from('groups').select('id, name, slug, description, visibility').eq('visibility', 'public').order('created_at', { ascending: false }).limit(4)),
    weeklyChallenge(sb, now),
    signedIn && me.path ? safe(sb.from('profiles').select('id, username, display_name, headline, path, avatar_url, profile_is_public')
      .eq('path', me.path).eq('account_status', 'active').neq('id', me.id).not('username', 'is', null)
      .order('last_active_at', { ascending: false, nullsFirst: false }).limit(6)) : null,
    signedIn && coworking ? coworking.upcoming(sb, { me: me.id, limit: 3, now }).catch(() => []) : []
  ]);
  const q = rowsOf(questions), un = rowsOf(unansweredR), p = rowsOf(posts), w = rowsOf(wins);
  const people = await profilesOf(sb, q.concat(un).concat(p).concat(w).map(x => x.user_id));
  return {
    signedIn,
    questions: q, unanswered: un, posts: p, wins: w, groups: rowsOf(groups),
    challenge, sessions: sessions || [],
    onPath: rowsOf(onPath).filter(m => m.profile_is_public !== false),
    myPath: me && me.path ? { slug: me.path, label: pathLabel(me.path), emoji: pathEmoji(me.path) } : null,
    people
  };
}

// "3h ago", "yesterday", "Nov 2".
function ago(iso, now = new Date()) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 24 * 60) return Math.round(m / 60) + 'h ago';
  if (m < 48 * 60) return 'yesterday';
  if (m < 7 * 24 * 60) return Math.round(m / 1440) + ' days ago';
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

module.exports = { ago, pathLabel, pathEmoji, dbKeepsThreads, peopleOnPath, profilesOf, weeklyChallenge, home };
