// The marketplace: programs and courses from approved providers (accelerators,
// incubators, nonprofits, universities, teachers), and the members who join
// them. Database rules live in migrations/2026-11-03_marketplace.sql; this
// file holds the shared words, the input cleaning and the display helpers.

const richtext = require('./workspace/richtext');
const paths = require('./paths');

const KINDS = { program: 'Program', course: 'Course' };
const KIND_BLURB = {
  program: 'An accelerator, incubator or program run with a cohort, on dates.',
  course: 'Lessons you work through here, at your own pace or with a group.'
};
const FORMATS = { online: 'Online', in_person: 'In person', hybrid: 'Hybrid' };
const JOIN = { apply: 'Apply', enroll: 'Enroll' };
const ORG_KINDS = { accelerator: 'Accelerator', incubator: 'Incubator', nonprofit: 'Nonprofit', university: 'University', educator: 'Teacher or educator', other: 'Other' };
const STATUS = { draft: 'Draft', published: 'Published', closed: 'Closed' };
const MEMBER_STATUS = { applied: 'Applied — waiting to hear', enrolled: 'Enrolled', declined: 'Not accepted', withdrawn: 'Withdrawn', removed: 'Removed' };
const PATHS = paths.MARKETED.map(p => ({ slug: p.slug, label: p.label }));
const PATH_LABEL = Object.fromEntries(PATHS.map(p => [p.slug, p.label]));

const LIMITS = { description: { maxText: 8000, maxHtml: 20000, links: true }, lesson: { maxText: 15000, maxHtml: 40000, links: true } };

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
const url = (v, { httpsOnly } = {}) => {
  const s = str(v, 500);
  return (httpsOnly ? /^https:\/\/\S+$/i : /^https?:\/\/\S+$/i).test(s) ? s : null;
};
const slugify = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

// Dollars as typed ("$1,200", "49.99", "free") to cents, or null for free.
function cents(v) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!s || /^free$/i.test(s)) return null;
  const n = Number(s);
  if (!isFinite(n) || n < 0 || n > 100000) return undefined;   // undefined = not a price
  return Math.round(n * 100) || null;
}

// "Free", "$450", "$49 / month".
function priceLabel(l) {
  if (!l || !l.price_cents) return l && l.price_note ? 'Free · ' + l.price_note : 'Free';
  const d = l.price_cents / 100;
  const amount = '$' + (Number.isInteger(d) ? d.toLocaleString('en-US') : d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return amount + (l.price_note ? ' · ' + l.price_note : '');
}

// Just the amount: "Free", "$450".
const priceAmount = l => priceLabel({ price_cents: l && l.price_cents });

const dateLabel = d => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

// A listing as typed into the editor → a row, or { error }.
function cleanListing(b, { kind } = {}) {
  const out = {
    title: str(b.title, 120),
    summary: str(b.summary, 280),
    description: richtext.clean(b.description, LIMITS.description) || null,
    paths: list(b.paths).filter(p => PATH_LABEL[p]).slice(0, 12),
    format: FORMATS[b.format] ? b.format : 'online',
    location: str(b.location, 120) || null,
    price_note: str(b.price_note, 120) || null,
    external_url: url(b.external_url),
    join_mode: JOIN[b.join_mode] ? b.join_mode : 'apply',
    questions: list(b.questions).map(q => str(q, 300)).filter(Boolean).slice(0, 5),
    capacity: /^\d+$/.test(str(b.capacity, 6)) && +b.capacity >= 1 && +b.capacity <= 10000 ? +b.capacity : null,
    starts_on: isDate(b.starts_on) ? b.starts_on : null,
    ends_on: isDate(b.ends_on) ? b.ends_on : null,
    apply_by: isDate(b.apply_by) ? b.apply_by : null
  };
  if (kind && !KINDS[kind]) return { error: 'Choose a program or a course.' };
  if (out.title.length < 3) return { error: 'Give it a title of at least 3 characters.' };
  if (out.summary.length < 10) return { error: 'Add a one-line summary (at least 10 characters).' };
  const price = cents(b.price);
  if (price === undefined) return { error: 'Enter the price as a number of dollars, or leave it blank for free.' };
  out.price_cents = price;
  if (out.price_cents && !out.external_url) return { error: 'A paid listing needs a link to where people pay or sign up.' };
  if (str(b.external_url, 500) && !out.external_url) return { error: 'The link must start with http:// or https://.' };
  if (out.starts_on && out.ends_on && out.ends_on < out.starts_on) return { error: 'The end date is before the start date.' };
  if (out.format !== 'online' && !out.location) return { error: 'Say where it takes place.' };
  return { row: out };
}

// A lesson as typed → a row, or { error }.
function cleanLesson(b, toolKeys) {
  const out = {
    title: str(b.title, 160),
    body: richtext.clean(b.body, LIMITS.lesson) || null,
    video_url: url(b.video_url, { httpsOnly: true }),
    minutes: /^\d+$/.test(str(b.minutes, 4)) && +b.minutes >= 1 && +b.minutes <= 600 ? +b.minutes : null,
    tool_key: toolKeys && toolKeys.includes(b.tool_key) ? b.tool_key : null
  };
  if (!out.title) return { error: 'Give the lesson a title.' };
  if (str(b.video_url, 500) && !out.video_url) return { error: 'The video link must start with https://.' };
  return { row: out };
}

// A video link → an embeddable player URL (YouTube, Vimeo, Loom), or null to
// show a plain link instead. Only these three hosts are ever embedded.
function embedOf(link) {
  let u;
  try { u = new URL(String(link || '')); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');
  const id = s => (/^[A-Za-z0-9_-]{6,64}$/.test(s || '') ? s : null);
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = id(u.searchParams.get('v')) || id((u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/) || [])[1]);
    return v ? 'https://www.youtube-nocookie.com/embed/' + v : null;
  }
  if (host === 'youtu.be') { const v = id(u.pathname.slice(1)); return v ? 'https://www.youtube-nocookie.com/embed/' + v : null; }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const v = (u.pathname.match(/(\d{5,12})/) || [])[1];
    return v ? 'https://player.vimeo.com/video/' + v : null;
  }
  if (host === 'loom.com') { const v = id((u.pathname.match(/^\/(?:share|embed)\/([^/?]+)/) || [])[1]); return v ? 'https://www.loom.com/embed/' + v : null; }
  return null;
}

// Filter the browse list by the query string.
function filter(items, q) {
  const kind = KINDS[q.kind] ? q.kind : '';
  const path = PATH_LABEL[q.path] ? q.path : '';
  const price = q.price === 'free' || q.price === 'paid' ? q.price : '';
  const format = FORMATS[q.format] ? q.format : '';
  const words = str(q.q, 80).toLowerCase().split(/\s+/).filter(Boolean);
  const provider = /^[a-z0-9-]{2,60}$/.test(q.provider || '') ? q.provider : '';
  const shown = items.filter(l =>
    (!kind || l.kind === kind) &&
    (!path || !(l.paths || []).length || (l.paths || []).includes(path)) &&
    (!price || (price === 'free') === !l.price_cents) &&
    (!format || l.format === format) &&
    (!provider || l.org_slug === provider) &&
    words.every(w => (l.title + ' ' + l.summary + ' ' + l.org_name).toLowerCase().includes(w)));
  return { shown, chosen: { kind, path, price, format, q: str(q.q, 80), provider } };
}

module.exports = {
  KINDS, KIND_BLURB, FORMATS, JOIN, ORG_KINDS, STATUS, MEMBER_STATUS, PATHS, PATH_LABEL, LIMITS,
  cents, priceLabel, priceAmount, dateLabel, cleanListing, cleanLesson, embedOf, filter, slugify, str, url, isDate
};
