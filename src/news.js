// News for each path, read from public.path_news (filled every 30 minutes by
// the path-news edge function: supabase/functions/path-news). This file only
// reads it for pages: what a member should see, and how old a headline is.

const missing = err => !!err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|Could not find the table/i.test(err.message || ''));
const DAYS = 14;

// Headlines for one member: their path's and everyone's, with topics meant for
// other subpaths left out. Returns { items, notReady }.
async function forMember(sb, profile, { limit = 60, path, topic } = {}) {
  const mine = profile && profile.path;
  const paths = path ? [path, 'all'] : (mine ? [mine, 'all'] : ['all']);
  let q = sb.from('path_news').select('id, path, topic, label, subpaths, title, url, publisher, published_at')
    .in('path', [...new Set(paths)]).gte('published_at', new Date(Date.now() - DAYS * 86400000).toISOString())
    .order('published_at', { ascending: false }).limit(Math.min(limit * 2, 300));
  if (topic) q = q.eq('topic', topic);
  const { data, error } = await q;
  if (error) return { items: [], notReady: missing(error) };
  const sub = !path || path === mine ? profile && profile.subpath : null;
  const items = (data || []).filter(n => !sub || !n.subpaths || !n.subpaths.length || n.subpaths.includes(sub)).slice(0, limit);
  return { items, notReady: false };
}

function ago(when, now = Date.now()) {
  const m = Math.max(0, Math.round((now - new Date(when).getTime()) / 60000));
  if (m < 60) return m <= 1 ? 'just now' : m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

module.exports = { forMember, ago, DAYS };
