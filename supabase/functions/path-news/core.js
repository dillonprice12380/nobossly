// The path-news job's logic, kept free of Deno and network calls so it can be
// tested in Node (test/news.js). index.ts does the fetching and storing.

export const MAX_AGE_HOURS = 48;       // older headlines are not stored
export const ALERT_WITHIN_HOURS = 12;  // only fresh news becomes a notification
export const PER_TOPIC = 6;            // at most this many new headlines per topic per run
export const ALERT_GAP_HOURS = 20;     // at most one news notification per member in this window

const plain = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const decode = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const tag = (xml, name) => (new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml) || [])[1] || '';

// The Google News RSS search for a topic, limited to the last day.
export function searchUrl(q) {
  const p = new URLSearchParams({ q: `${q} when:1d`, hl: 'en-US', gl: 'US', ceid: 'US:en' });
  return 'https://news.google.com/rss/search?' + p.toString();
}

// Headlines from a Google News answer: { url, title, publisher, seen }.
export function parseNewsRss(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const url = plain(decode(tag(item, 'link')));
    const seen = new Date(plain(decode(tag(item, 'pubDate'))));
    const publisher = plain(decode((/<source\b[^>]*>([\s\S]*?)<\/source>/i.exec(item) || [])[1] || '')).slice(0, 80);
    let title = plain(decode(tag(item, 'title')));
    // Google News appends " - Publisher" to every headline.
    if (publisher && title.endsWith(' - ' + publisher)) title = title.slice(0, -(publisher.length + 3)).trim();
    if (!/^https:\/\/\S+$/i.test(url) || isNaN(seen.getTime()) || !title) continue;
    out.push({ url: url.slice(0, 1000), title: title.slice(0, 300), publisher, seen });
  }
  return out;
}

// Whether a Google News answer is a feed at all (a block page is not).
export const isFeed = (status, text) => status >= 200 && status < 300 && /<rss\b|<feed\b/i.test(String(text || '').slice(0, 2000));

// Same story, different outlets: compare headlines without case and punctuation.
export const headlineKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 12).join(' ');

const STOP = new Set('the a an and or of to in on for with from by at as is are was be its it this that new says will can after into about over how why what your you'.split(' '));
// The words that carry a headline: lower case, a crude singular, no filler.
const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .map((w) => w.replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length > 2 && !STOP.has(w)));

// Two headlines about the same story: most of the shorter one's words are in
// the other ("Instagram is testing long-form videos for creators" and
// "Instagram tests long form videos, creators react").
export function sameStory(a, b) {
  const x = words(a), y = words(b);
  if (x.size < 3 || y.size < 3) return headlineKey(a) === headlineKey(b);
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.6;
}

export function relevant(a, topic, now = new Date()) {
  const age = now.getTime() - a.seen.getTime();
  if (age > MAX_AGE_HOURS * 3600000 || age < -3600000) return false;
  return !topic.must || new RegExp(topic.must, 'i').test(a.title);
}

// Rows to store from one run: per path, newest first, no repeated links or
// repeated stories, a few per topic. reads: [{ path, topic, articles }].
export function collect(reads, now = new Date()) {
  const rows = [];
  const seen = new Map();   // path -> { urls, titles } already kept
  for (const { path, topic, articles } of reads) {
    const s = seen.get(path) || { urls: new Set(), titles: [] };
    seen.set(path, s);
    let n = 0;
    for (const a of [...articles].sort((x, y) => y.seen - x.seen)) {
      if (n >= PER_TOPIC) break;
      if (!relevant(a, topic, now)) continue;
      if (s.urls.has(a.url) || s.titles.some((t) => sameStory(t, a.title))) continue;
      s.urls.add(a.url); s.titles.push(a.title);
      rows.push({
        path, topic: topic.key, label: topic.label, subpaths: topic.subpaths || null,
        title: a.title, url: a.url, publisher: a.publisher || null, published_at: a.seen.toISOString()
      });
      n++;
    }
  }
  return rows;
}

// Which new headline, if any, each path should be alerted about this run: the
// newest fresh one. Topics only for some subpaths go to those members only.
export function pickAlerts(newRows, now = new Date()) {
  const best = new Map();
  for (const r of newRows) {
    if (now.getTime() - new Date(r.published_at).getTime() > ALERT_WITHIN_HOURS * 3600000) continue;
    const cur = best.get(r.path);
    if (!cur || new Date(r.published_at) > new Date(cur.published_at)) best.set(r.path, r);
  }
  return [...best.values()];
}

// Members a headline is for: on its path ('all' = everyone), news alerts on,
// on one of its subpaths when it has some (or no subpath picked yet), and not
// alerted about news recently. recent: Set of user ids alerted in the gap.
export function audience(row, members, recent) {
  return members.filter((m) =>
    m.news_alerts !== false && (m.account_status || 'active') === 'active' && !recent.has(m.id) &&
    (row.path === 'all' || m.path === row.path) &&
    (!row.subpaths || !m.subpath || row.subpaths.includes(m.subpath)));
}

export const alertMessage = (row) => ('📰 ' + row.label + ': ' + row.title).slice(0, 200);
