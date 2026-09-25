// Affiliate recommendations. NoBossly is free; pointing a member at the right
// tool at the moment a quest asks for it is how it earns without a paywall.
//
// The slots live in affiliate_offers (see migrations/2026-09-25_affiliate_slots.sql).
// Only live ones — a partner link pasted in /admin/affiliates and switched on —
// are readable outside the admin screen, so until a link is added nothing
// renders anywhere. Live offers are cached in memory and refreshed every few
// minutes; a page render never waits on the database for them.
//
// Every outbound link goes through /go/:key so the click is counted and the
// partner can be swapped without touching any page.

const { anonClient } = require('./supabase');

const TTL = 5 * 60 * 1000;
let live = [];
let loadedAt = 0;
let loading = null;

function refresh() {
  if (loading) return loading;
  loading = anonClient().from('affiliate_offers')
    .select('key, category, label, blurb, cta_label, partner_name, match_titles, match_paths, match_keywords, sort')
    .order('sort')
    .then(({ data, error }) => {
      if (!error) { live = data || []; loadedAt = Date.now(); }
    }, () => {})
    .finally(() => { loading = null; });
  return loading;
}

function current() {
  if (Date.now() - loadedAt > TTL) refresh();
  return live;
}

// Called after an admin saves a slot, so the change shows without the wait.
function invalidate() { loadedAt = 0; return refresh(); }

const norm = s => String(s || '').trim().toLowerCase();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Picks for a quest or trophy, by its title.
function forTitle(title, limit = 2) {
  const t = norm(title);
  if (!t) return [];
  return current().filter(o => (o.match_titles || []).includes(t)).slice(0, limit);
}

// Picks for a public path landing page.
function forPath(slug, limit = 4) {
  return current().filter(o => (o.match_paths || []).includes(slug)).slice(0, limit);
}

// Picks for a guide: each keyword is matched at a word start in the title, and
// the offers with the most hits win.
function forText(text, limit = 3) {
  const t = norm(text);
  if (!t) return [];
  return current()
    .map(o => ({ o, hits: (o.match_keywords || []).filter(k => new RegExp('\\b' + escapeRe(norm(k))).test(t)).length }))
    .filter(x => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.o.sort - b.o.sort)
    .slice(0, limit)
    .map(x => x.o);
}

// Every live offer, grouped by category, for the toolkit page.
function grouped() {
  const out = {};
  current().forEach(o => (out[o.category] = out[o.category] || []).push(o));
  return out;
}

// Exposed to every view as `affiliates`, so a template can ask for picks inline.
function attach(req, res, next) {
  res.locals.affiliates = { forTitle, forPath, forText, any: () => current().length > 0 };
  next();
}

refresh();

module.exports = { attach, forTitle, forPath, forText, grouped, invalidate, current };
