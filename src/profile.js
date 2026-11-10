// Member profiles (views/profile.ejs, views/profile_edit.ejs,
// migrations/2026-11-10_profile_showcase.sql): the business showcase, what a
// member chooses to show, how complete their profile is, their community
// activity, and photo checks.

const LINK_KINDS = [
  { key: 'website', label: 'Website', emoji: '🌐' },
  { key: 'shop', label: 'Shop', emoji: '🛍️' },
  { key: 'instagram', label: 'Instagram', emoji: '📸' },
  { key: 'tiktok', label: 'TikTok', emoji: '🎵' },
  { key: 'youtube', label: 'YouTube', emoji: '▶️' },
  { key: 'linkedin', label: 'LinkedIn', emoji: '💼' },
  { key: 'x', label: 'X', emoji: '𝕏' },
  { key: 'facebook', label: 'Facebook', emoji: '📘' },
  { key: 'other', label: 'Link', emoji: '🔗' }
];
const KIND = Object.fromEntries(LINK_KINDS.map(k => [k.key, k]));
const MAX = 6;

// What a member can hide from others. Missing means shown.
const PRIVACY = [
  { key: 'location', label: 'Where I am' },
  { key: 'links', label: 'My links' },
  { key: 'business', label: 'My business and what I offer' },
  { key: 'results', label: 'Results I have shared' },
  { key: 'posts', label: 'My posts' },
  { key: 'activity', label: 'My community activity (answers, co-working, groups)' },
  { key: 'follows', label: 'Who follows me and who I follow' }
];
const shows = (p, key) => !(p && p.privacy && p.privacy[key] === false);

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function cleanUrl(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || s.length > 200) return null;
  return u.toString();
}
// Form rows (arrays of fields) → a clean list.
const listOf = v => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
function cleanOffers(titles, prices) {
  const t = listOf(titles), p = listOf(prices), out = [];
  t.forEach((x, i) => {
    const title = clip(x, 60);
    if (title && out.length < MAX) out.push(Object.assign({ title }, clip(p[i], 30) ? { price: clip(p[i], 30) } : {}));
  });
  return out;
}
function cleanLinks(kinds, urls) {
  const k = listOf(kinds), u = listOf(urls), out = [], bad = [];
  u.forEach((x, i) => {
    if (!String(x || '').trim()) return;
    const url = cleanUrl(x);
    if (!url) { bad.push(String(x).slice(0, 60)); return; }
    if (out.length < MAX && !out.some(l => l.url === url)) out.push({ kind: KIND[k[i]] ? k[i] : 'other', url });
  });
  return { links: out, bad };
}
function cleanPrivacy(body) {
  const shown = new Set(listOf(body && body.show));
  const out = {};
  PRIVACY.forEach(p => { if (!shown.has(p.key)) out[p.key] = false; });
  return out;
}

// How complete a profile is: the things that help the right people find you.
function completeness(p) {
  const has = v => Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
  const items = [
    { key: 'photo', label: 'Add a photo', done: has(p.avatar_url) },
    { key: 'headline', label: 'Write a headline', done: has(p.headline) },
    { key: 'working_on', label: 'Say what you are working on', done: has(p.working_on) },
    { key: 'bio', label: 'Write a few lines about yourself', done: has(p.bio) },
    { key: 'help', label: 'Say what you can help with', done: has(p.help_offer) || has(p.help_need) },
    { key: 'business', label: 'Name your business or list what you offer', done: has(p.business_name) || has(p.offers) },
    { key: 'links', label: 'Add a link', done: has(p.website_url) || has(p.links) }
  ];
  const done = items.filter(i => i.done).length;
  return { items, done, total: items.length, pct: Math.round(100 * done / items.length), missing: items.filter(i => !i.done) };
}

// Links to show: the website field first, then the rest.
function linksOf(p) {
  const out = [];
  if (p.website_url) { const u = cleanUrl(p.website_url); if (u) out.push({ kind: 'website', url: u }); }
  (Array.isArray(p.links) ? p.links : []).forEach(l => { const u = cleanUrl(l && l.url); if (u && !out.some(x => x.url === u)) out.push({ kind: KIND[l.kind] ? l.kind : 'other', url: u }); });
  return out.slice(0, MAX + 1).map(l => Object.assign({}, l, KIND[l.kind], { kind: l.kind, short: l.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').slice(0, 40) }));
}

// ------------------------------------------------------------------ Photos
const AVATAR_MAX = 2 * 1024 * 1024;   // the avatars bucket's own limit
// The file's first bytes decide what it is, not the name or the browser's word.
function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  if (/^GIF8[79]a$/.test(buf.slice(0, 6).toString('ascii'))) return { ext: 'gif', type: 'image/gif' };
  return null;
}
// Only a photo from our own avatars bucket is shown, never an outside address.
function ownAvatar(url, supabaseUrl = process.env.SUPABASE_URL || '') {
  const s = String(url || '');
  if (!s || !supabaseUrl) return null;
  const prefix = supabaseUrl.replace(/\/$/, '') + '/storage/v1/object/public/avatars/';
  return s.startsWith(prefix) && /^[A-Za-z0-9/_.-]+$/.test(s.slice(prefix.length)) ? s : null;
}

// --------------------------------------------------------------- Activity
const rowsOf = r => (r && !r.error && Array.isArray(r.data) ? r.data : []);
const countOf = r => (r && !r.error ? r.count || 0 : 0);
const safe = p => Promise.resolve(p).catch(() => null);

/**
 * What a member has done in the community. Every read goes through the
 * viewer's client, so RLS decides what is visible; a missing table is zero.
 */
async function activityOf(sb, userId, now = new Date()) {
  const [replies, asked, hosted, upcoming, groups, thanks, wins] = await Promise.all([
    safe(sb.from('forum_replies').select('id, thread_id, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(500)),
    safe(sb.from('forum_threads').select('id', { count: 'exact', head: true }).eq('user_id', userId)),
    safe(sb.from('coworking_sessions').select('id', { count: 'exact', head: true }).eq('host_id', userId).is('cancelled_at', null).lt('starts_at', now.toISOString())),
    safe(sb.from('coworking_sessions').select('id, title, starts_at').eq('host_id', userId).is('cancelled_at', null).gte('starts_at', now.toISOString()).order('starts_at').limit(3)),
    safe(sb.from('group_members').select('group:groups(name, slug, visibility)').eq('user_id', userId).limit(12)),
    safe(sb.from('help_thanks').select('id', { count: 'exact', head: true }).eq('helper_id', userId).eq('is_public', true)),
    safe(sb.from('wins').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('approved', true))
  ]);
  const replyRows = rowsOf(replies);
  let helped = [];
  if (replyRows.length) {
    const ids = replyRows.map(r => r.id);
    const r = await safe(sb.from('forum_threads').select('id, title, accepted_reply_id').in('accepted_reply_id', ids.slice(0, 300)).limit(50));
    helped = rowsOf(r);
  }
  const groupList = rowsOf(groups).map(g => g.group).filter(g => g && g.visibility === 'public');
  return {
    answers: replyRows.length, helped: helped.length, helpedThreads: helped.slice(0, 3),
    asked: countOf(asked), hosted: countOf(hosted), upcoming: rowsOf(upcoming),
    groups: groupList, thanks: countOf(thanks), results: countOf(wins),
    any: !!(replyRows.length || countOf(asked) || countOf(hosted) || rowsOf(upcoming).length || groupList.length || countOf(thanks) || countOf(wins))
  };
}

module.exports = { LINK_KINDS, KIND, PRIVACY, MAX, shows, cleanUrl, cleanOffers, cleanLinks, cleanPrivacy, completeness, linksOf, AVATAR_MAX, imageType, ownAvatar, activityOf };
