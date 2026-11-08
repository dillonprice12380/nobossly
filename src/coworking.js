// Co-working sessions (migrations/2026-11-08_community.sql): a member posts a
// time to work alongside others, with a video link; others RSVP and get a
// reminder about an hour before. Peer-run: nobody teaches, everyone works on
// their own thing.
//
// The link lives in coworking_links, which only the host and the people who
// RSVP'd can read. Times are stored in UTC; the form sends the member's own
// time zone offset from the browser, and pages show times in New York time
// until the browser rewrites them into the reader's own (public/js/app.js).

const paths = require('./paths');

const LIMITS = { title: 120, about: 1000, link: 300 };
const ZONE = 'America/New_York';
const rowsOf = r => (r && !r.error && Array.isArray(r.data) ? r.data : []);
const missing = err => !!err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|Could not find the table/i.test(err.message || ''));

// The UTC offset (minutes ahead of UTC) of a time zone at a moment.
function zoneOffset(at, zone = ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).reduce((o, p) => (o[p.type] = p.value, o), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * A date and a time typed into the form → a Date. `tzOffset` is what the
 * browser's getTimezoneOffset() said (minutes BEHIND UTC, so New York in
 * winter is 300); without it the time is read as New York time.
 */
function whenOf(date, time, tzOffset) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^\d{2}:\d{2}$/.test(String(time || ''))) return null;
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  if (h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const off = Number.parseInt(tzOffset, 10);
  if (Number.isFinite(off) && Math.abs(off) <= 840) return new Date(wall + off * 60000);
  // New York time: guess with the offset at that wall time, then correct once.
  let t = wall - zoneOffset(new Date(wall)) * 60000;
  t = wall - zoneOffset(new Date(t)) * 60000;
  return new Date(t);
}

// A link people can join with: https only, no spaces, nothing that is not a URL.
function cleanLink(v) {
  const s = String(v || '').trim();
  if (!s) return { link: null };
  if (s.length > LIMITS.link || /\s/.test(s)) return { error: 'That link does not look right.' };
  let u;
  try { u = new URL(s); } catch (_) { return { error: 'That link does not look right.' }; }
  if (u.protocol !== 'https:') return { error: 'Use an https:// link (Zoom, Google Meet, Jitsi, Teams…).' };
  return { link: u.toString() };
}

/**
 * The host form → { row, link } or { error }. `now` bounds the time: at least
 * a few minutes ahead, at most 60 days.
 */
function clean(body, hostId, now = new Date()) {
  const b = body || {};
  const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
  if (title.length < 3) return { error: 'Give the session a name, e.g. "Tuesday evening focus hour".' };
  const starts = whenOf(b.date, b.time, b.tz);
  if (!starts) return { error: 'Pick a day and a time.' };
  if (starts.getTime() < now.getTime() + 5 * 60000) return { error: 'Pick a time in the future.' };
  if (starts.getTime() > now.getTime() + 60 * 86400000) return { error: 'Sessions can be up to 60 days ahead.' };
  const minutes = [30, 45, 60, 90, 120, 180].includes(Number(b.minutes)) ? Number(b.minutes) : 60;
  const capN = Number.parseInt(b.capacity, 10);
  const capacity = Number.isFinite(capN) && capN >= 2 && capN <= 50 ? capN : null;
  const about = String(b.about || '').trim().slice(0, LIMITS.about) || null;
  const path = b.path && paths.get(String(b.path)) && String(b.path) !== 'default' ? String(b.path) : null;
  const l = cleanLink(b.link);
  if (l.error) return { error: l.error };
  if (!l.link) return { error: 'Add the video link people will join with.' };
  return { row: { host_id: hostId, title, about, starts_at: starts.toISOString(), minutes, capacity, path }, link: l.link };
}

const endOf = s => new Date(new Date(s.starts_at).getTime() + (s.minutes || 60) * 60000);

// "Tue, Nov 10 · 7:00 PM ET" — the server's version; the browser rewrites it.
function label(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
  return day + ' · ' + time + ' ET';
}

async function withPeople(sb, sessions, me) {
  if (!sessions.length) return [];
  const ids = sessions.map(s => s.id);
  const rsvps = rowsOf(await sb.from('coworking_rsvps').select('session_id, user_id').in('session_id', ids).then(r => r, () => null));
  const userIds = [...new Set(sessions.map(s => s.host_id).concat(rsvps.map(r => r.user_id)))];
  const profiles = userIds.length ? rowsOf(await sb.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds).then(r => r, () => null)) : [];
  const pm = Object.fromEntries(profiles.map(p => [p.id, p]));
  return sessions.map(s => {
    const going = rsvps.filter(r => r.session_id === s.id).map(r => pm[r.user_id]).filter(Boolean);
    return Object.assign({}, s, {
      host: pm[s.host_id] || null, going, count: going.length,
      mine: !!me && s.host_id === me, attending: !!me && rsvps.some(r => r.session_id === s.id && r.user_id === me),
      full: !!s.capacity && going.length >= s.capacity,
      when: label(s.starts_at), ends_at: endOf(s).toISOString(),
      pathLabel: s.path ? (paths.get(s.path) || {}).label || '' : ''
    });
  });
}

/**
 * Sessions that have not ended yet, soonest first. { path } narrows to
 * sessions for that path or for everyone.
 */
async function upcoming(sb, { me = null, limit = 30, now = new Date(), path = null } = {}) {
  // Anything that started up to four hours ago may still be running.
  let q = sb.from('coworking_sessions').select('*').is('cancelled_at', null)
    .gte('starts_at', new Date(now.getTime() - 4 * 3600000).toISOString())
    .order('starts_at', { ascending: true }).limit(limit + 10);
  if (path) q = q.or('path.is.null,path.eq.' + path);
  const r = await q;
  if (r.error) { if (missing(r.error)) return []; throw r.error; }
  const live = rowsOf(r).filter(s => endOf(s) > now).slice(0, limit);
  return withPeople(sb, live, me);
}

// One session, with who is going and the link if this member may see it.
async function one(sb, id, me, now = new Date()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const r = await sb.from('coworking_sessions').select('*').eq('id', id).maybeSingle();
  if (r.error || !r.data) return null;
  const [s] = await withPeople(sb, [r.data], me);
  const l = await sb.from('coworking_links').select('link').eq('session_id', id).maybeSingle().then(x => x, () => null);
  s.link = l && l.data ? l.data.link : null;
  s.over = endOf(s) <= now;
  s.live = !s.over && new Date(s.starts_at) <= now;
  return s;
}

// A calendar file for one session.
function ics(s, link, origin) {
  const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = v => String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const url = (origin || 'https://nobossly.com') + '/community/coworking/' + s.id;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NoBossly//Co-working//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:coworking-' + s.id + '@nobossly',
    'DTSTAMP:' + stamp(new Date()),
    'DTSTART:' + stamp(s.starts_at),
    'DTEND:' + stamp(endOf(s)),
    'SUMMARY:' + esc('Co-working: ' + s.title),
    'DESCRIPTION:' + esc((s.about ? s.about + '\n\n' : '') + (link ? 'Join: ' + link + '\n' : '') + url),
    'URL:' + url,
    link ? 'LOCATION:' + esc(link) : null,
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n') + '\r\n';
}

/**
 * Reminders, from the server with the service role: everyone going to a
 * session that starts within the next 65 minutes and has not been reminded.
 * Returns { sessions, reminded }.
 */
async function remind(sc, now = new Date()) {
  const soon = new Date(now.getTime() + 65 * 60000).toISOString();
  const r = await sc.from('coworking_sessions').select('id, title, starts_at').is('cancelled_at', null)
    .gt('starts_at', now.toISOString()).lte('starts_at', soon).limit(100);
  if (r.error) return { skipped: missing(r.error) ? 'not set up' : r.error.message };
  let reminded = 0;
  for (const s of rowsOf(r)) {
    const due = rowsOf(await sc.from('coworking_rsvps').select('user_id').eq('session_id', s.id).is('reminded_at', null));
    if (!due.length) continue;
    const mins = Math.max(1, Math.round((new Date(s.starts_at) - now) / 60000));
    const { error } = await sc.from('notifications').insert(due.map(d => ({
      user_id: d.user_id, type: 'community', entity_type: 'coworking_sessions', entity_id: s.id, is_read: false,
      message: 'Co-working "' + String(s.title).slice(0, 60) + '" starts in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '. The link is on the session page.'
    })));
    if (error) { console.error('[coworking reminders]', error.message); continue; }
    await sc.from('coworking_rsvps').update({ reminded_at: now.toISOString() }).eq('session_id', s.id).in('user_id', due.map(d => d.user_id));
    reminded += due.length;
  }
  return { sessions: rowsOf(r).length, reminded };
}

module.exports = { ZONE, LIMITS, zoneOffset, whenOf, cleanLink, clean, label, upcoming, one, ics, remind, missing };
