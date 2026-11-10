// The path pages: each public /paths/<slug> page (views/path_landing.ejs), the
// /paths comparison (views/paths_index.ejs), and the member's "choose your
// path" screen (views/choose_path.ejs). Everything here is built from the
// same path and dashboard config members get, so a page can never promise
// something the product does not do.

const paths = require('./paths');
const dashboards = require('./path_dashboards');
const { SITE } = require('./home');

// "a freelancer", "an online store".
const article = label => (/^[aeiou]/i.test(String(label || '')) ? 'an' : 'a');
const withArticle = label => article(label) + ' ' + String(label || '').toLowerCase();

// How a page names a path in a sentence: "your freelancer dashboard", "start
// free as a freelancer". Labels like "Still figuring it out" do not fit those
// sentences, so they have their own words.
const NOUNS = { creator: 'creator', software: 'app', exploring: 'exploring' };
const CTAS = { exploring: 'Start free, still figuring it out', software: 'Start free as an app builder' };
function wordsFor(def) {
  if (!def) return { noun: '', cta: 'Start free' };
  const noun = NOUNS[def.slug] || def.label.toLowerCase();
  const cta = CTAS[def.slug] || 'Start free as ' + withArticle(def.label);
  return { noun, cta };
}

// ------------------------------------------------------------ What a path is
// One path, as the pages show it: what it is for, what its dashboard puts up
// front, and the kinds of work it covers.
function summaryOf(slug) {
  const def = paths.get(slug);
  if (!def) return null;
  const v = dashboards.previewFor(slug) || { numbers: [], boards: [], tools: [] };
  return {
    slug: def.slug, label: def.label, emoji: def.emoji, blurb: def.blurb || '',
    numbers: v.numbers || [], boards: v.boards || [], tools: v.tools || [],
    kinds: (paths.subpathsOf(slug) || []).map(s => s.label).filter(l => !/^something else/i.test(l))
  };
}

// Every marketed path side by side, for the /paths comparison.
const compare = () => paths.MARKETED.map(p => summaryOf(p.slug)).filter(Boolean);

// Every path a member can pick (marketed or not), for "choose your path".
const choices = () => paths.PATHS.map(p => summaryOf(p.slug)).filter(Boolean);

// ------------------------------------------------------------ The community
// What a path's page says about the people on it, from path_community()
// (migrations/2026-11-10_path_pages.sql). Counts and public question titles
// only. A small number is not shown as a number: "2 members" reads as empty
// rather than early.
const SHOW_COUNT_FROM = 10;
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function shape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = v => Math.max(0, parseInt(v, 10) || 0);
  const members = n(raw.members);
  return {
    members, showCount: members >= SHOW_COUNT_FROM,
    questions: n(raw.questions), replied: n(raw.replied),
    recent: (Array.isArray(raw.recent) ? raw.recent : []).slice(0, 3)
      .filter(q => q && q.id && q.title)
      .map(q => ({ id: String(q.id), title: String(q.title).slice(0, 140), replies: n(q.replies), answered: !!q.answered })),
    sessions: n(raw.sessions),
    nextSessionAt: raw.next_session_at ? new Date(raw.next_session_at) : null
  };
}

/** A path's community, cached for five minutes. Null when it cannot be read. */
async function community(sb, slug, now = Date.now()) {
  if (!paths.isPath(slug)) return null;
  const hit = cache.get(slug);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let value = null;
  try {
    const r = await sb.rpc('path_community', { p_path: slug });
    value = r && !r.error ? shape(r.data) : null;
  } catch (_) { value = null; }
  cache.set(slug, { at: now, value });
  return value;
}
const clearCache = () => cache.clear();

// --------------------------------------------------------------- Switching
// Switching path keeps everything a member has logged. The setup answers
// belong to a path, so the old path's are put aside in saved_paths and come
// back if the member switches back. Without the saved_paths column (before
// the migration) the old behaviour stands: the answers start again.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function switchPatch(profile, chosen) {
  const from = profile && profile.path;
  if (!from || from === chosen) return {};
  const hasAnswers = !!profile && Object.prototype.hasOwnProperty.call(profile, 'path_answers');
  const hasSaved = !!profile && Object.prototype.hasOwnProperty.call(profile, 'saved_paths');
  if (!hasSaved) return Object.assign({ subpath: null }, hasAnswers ? { path_answers: {} } : {});
  const saved = Object.assign({}, isObj(profile.saved_paths) ? profile.saved_paths : {});
  const answers = isObj(profile.path_answers) ? profile.path_answers : {};
  if (profile.subpath || Object.keys(answers).length) saved[from] = { subpath: profile.subpath || null, answers };
  const back = isObj(saved[chosen]) ? saved[chosen] : null;
  delete saved[chosen];
  const subs = (paths.subpathsOf(chosen) || []).map(s => s.slug);
  const patch = {
    subpath: back && subs.includes(back.subpath) ? back.subpath : null,
    saved_paths: saved
  };
  if (hasAnswers) patch.path_answers = back && isObj(back.answers) ? back.answers : {};
  return patch;
}

// ------------------------------------------------------------ Search tags
function structuredData(def) {
  const url = SITE + '/paths/' + def.slug;
  return [{
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'NoBossly', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Paths', item: SITE + '/paths' },
      { '@type': 'ListItem', position: 3, name: def.label, item: url }
    ]
  }];
}
const ogImage = slug => SITE + '/img/paths/' + slug + '.jpg';

// What each page renders with, so the routes and the tests build the same thing.
function indexLocals() {
  const list = compare();
  return {
    title: 'Paths: pick what you are building',
    metaDescription: 'NoBossly sets up a different dashboard for each kind of business: a channel, a client base, a shop, a product. Compare what each path tracks and pick yours.',
    canonicalUrl: SITE + '/paths',
    paths: paths.MARKETED, compare: list,
    structuredData: [{ '@context': 'https://schema.org', '@type': 'ItemList', name: 'NoBossly paths',
      itemListElement: list.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.label, url: SITE + '/paths/' + p.slug })) }]
  };
}
function landingLocals(def, people = null) {
  return {
    title: def.label + ' — your path on NoBossly',
    metaDescription: def.marketing.subhead.slice(0, 300),
    canonicalUrl: SITE + '/paths/' + def.slug,
    ogImage: ogImage(def.slug),
    def, summary: summaryOf(def.slug), people, wordsFor,
    structuredData: structuredData(def),
    others: paths.MARKETED.filter(p => p.slug !== def.slug)
  };
}

module.exports = { indexLocals, landingLocals, article, withArticle, wordsFor, summaryOf, compare, choices, community, clearCache, shape, SHOW_COUNT_FROM, switchPatch, structuredData, ogImage };
