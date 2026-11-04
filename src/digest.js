// The weekly news digest: on Monday morning (New York time), every member who
// has the weekly digest on gets one email with the week's headlines for their
// path (public.path_news, filled every 30 minutes by the path-news job).
//
// It runs on a 30-minute timer in server.js, like the group check-ins, and is
// idempotent: nobody gets a second digest within six days (email_log). If the
// server is down on Monday morning, the digest goes out on Tuesday instead.
// Members with fewer than MIN_ITEMS headlines that week are skipped rather
// than sent a thin email.

const mailer = require('./mailer');
const paths = require('./paths');

const ZONE = 'America/New_York';
const HOUR = 9;            // send from 09:00 New York time
const MIN_ITEMS = 2;
const MAX_ITEMS = 8;
const PER_TOPIC = 2;
const TYPE = 'weekly_brief';   // the email_log type kept from the old weekly brief

// Monday from 09:00, or any time Tuesday (a catch-up after downtime).
function due(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(x => [x.type, x.value]));
  return (p.weekday === 'Mon' && Number(p.hour) >= HOUR) || p.weekday === 'Tue';
}

// This week's headlines for one member: their path's and everyone's, minus
// topics meant for other subpaths, at most two per topic, newest first.
function pick(rows, member) {
  const mine = member.path || null;
  const sub = member.subpath || null;
  const ok = rows.filter(r => (r.path === 'all' || (mine && r.path === mine))
    && (!sub || !r.subpaths || !r.subpaths.length || r.subpaths.includes(sub)));
  ok.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  const perTopic = {};
  const out = [];
  for (const r of ok) {
    if (out.length >= MAX_ITEMS) break;
    perTopic[r.topic] = (perTopic[r.topic] || 0) + 1;
    if (perTopic[r.topic] > PER_TOPIC) continue;
    if (out.some(x => x.url === r.url)) continue;
    out.push(r);
  }
  return out;
}

const pathLabel = slug => (slug && paths.get(slug) && paths.get(slug).label) || null;

// One pass. sc: a service-role client. Returns what it did, for the log.
async function run(sc, now = new Date(), opts = {}) {
  if (!opts.force && !due(now)) return { skipped: 'not due' };
  if (!mailer.enabled()) return { skipped: 'RESEND_API_KEY unset' };
  const week = new Date(now.getTime() - 7 * 86400000).toISOString();
  const sixDays = new Date(now.getTime() - 6 * 86400000).toISOString();

  const [{ data: news, error }, { data: members }, { data: sent }] = await Promise.all([
    sc.from('path_news').select('path, topic, label, subpaths, title, url, publisher, published_at').gte('published_at', week).limit(2000),
    sc.from('profiles').select('id, username, display_name, path, subpath, weekly_digest_enabled, account_status').limit(10000),
    sc.from('email_log').select('user_id').eq('email_type', TYPE).gte('created_at', sixDays).limit(10000)
  ]);
  if (error) return { skipped: 'news not ready' };
  const done = new Set((sent || []).map(s => s.user_id));
  const out = { sent: 0, thin: 0, already: 0, noEmail: 0 };
  for (const m of members || []) {
    if (m.weekly_digest_enabled === false || (m.account_status || 'active') !== 'active') continue;
    if (done.has(m.id)) { out.already++; continue; }
    const items = pick(news || [], m);
    if (items.length < MIN_ITEMS) { out.thin++; continue; }
    const email = await (opts.emailOf || mailer.emailOf)(sc, m.id);
    if (!email) { out.noEmail++; continue; }
    const ok = await (opts.send || mailer.send)(TYPE, email, m.display_name || m.username, {
      sb: sc, userId: m.id, template: { items, pathLabel: pathLabel(m.path) }
    });
    if (ok) out.sent++;
    if (out.sent >= (opts.max || 500)) break;
  }
  return out;
}

module.exports = { run, due, pick, MIN_ITEMS, MAX_ITEMS, TYPE };
