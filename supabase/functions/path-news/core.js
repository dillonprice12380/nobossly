// The path-news job's logic, kept free of Deno and network calls so it can be
// tested in Node (test/news.js). index.ts reads the feeds and stores results.

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

// Headlines from an RSS or Atom feed: { url, title, publisher, seen, feed }.
// Google News style titles ("Headline - Publisher") lose the publisher part.
export function parseFeed(xml, feed = '', name = '') {
  const out = [];
  const text = String(xml || '');
  const atom = !/<item\b/i.test(text) && /<entry\b/i.test(text);
  for (const m of text.matchAll(atom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    let url = plain(decode(tag(item, 'link')));
    if (!url || atom) {
      const links = [...item.matchAll(/<link\b([^>]*)\/?>/gi)].map((l) => l[1]);
      const alt = links.find((l) => /rel=["']alternate["']/i.test(l)) || links.find((l) => !/rel=/i.test(l)) || links[0] || '';
      url = decode((/href=["']([^"']+)["']/i.exec(alt) || [])[1] || url);
    }
    const when = tag(item, 'pubDate') || tag(item, 'published') || tag(item, 'updated') || tag(item, 'dc:date');
    const seen = new Date(plain(decode(when)));
    const source = plain(decode((/<source\b[^>]*>([\s\S]*?)<\/source>/i.exec(item) || [])[1] || ''));
    const publisher = (source || name).slice(0, 80);
    let title = plain(decode(tag(item, 'title')));
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    url = plain(url);
    if (!/^https:\/\/\S+$/i.test(url) || isNaN(seen.getTime()) || !title) continue;
    out.push({ url: url.slice(0, 1000), title: title.slice(0, 300), publisher, seen, feed });
  }
  return out;
}
export const parseNewsRss = (xml) => parseFeed(xml);

// The headlines a topic draws from: everything its feeds and anyFrom feeds
// returned this run. byFeed: { feedKey: articles }.
export function articlesFor(topic, byFeed) {
  const keys = [...new Set([...(topic.feeds || []), ...(topic.anyFrom || [])])];
  return keys.flatMap((k) => byFeed[k] || []);
}

// Whether an answer is a feed at all (a block page is not).
export const isFeed = (status, text) => status >= 200 && status < 300 && /<rss\b|<feed\b|<rdf:RDF\b/i.test(String(text || '').slice(0, 3000));

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

// A headline belongs to a topic when it is recent and either comes from one
// of the topic's single-subject feeds (anyFrom) or comes from one of its
// feeds and matches its pattern.
export function relevant(a, topic, now = new Date()) {
  const age = now.getTime() - a.seen.getTime();
  if (age > MAX_AGE_HOURS * 3600000 || age < -3600000) return false;
  if (a.feed && (topic.anyFrom || []).includes(a.feed)) return true;
  if (a.feed && !(topic.feeds || []).includes(a.feed)) return false;
  return !!topic.must && new RegExp(topic.must, 'i').test(a.title);
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
