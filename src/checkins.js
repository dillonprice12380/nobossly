// Weekly check-in threads in groups (migrations/2026-11-02_group_checkins.sql).
//
// Mondays and Fridays from 09:00 New York time, the server asks the database
// to post the week's check-in in every group that wants it. The database
// function is idempotent (one per group per day), so the timer can fire as
// often as it likes; it only matters that it fires at least once after 09:00.

const ZONE = 'America/New_York';
const HOUR = 9;
const KINDS = { Mon: 'monday', Fri: 'friday' };
const TEXT = { monday: 'What are you working on this week?', friday: 'What went well this week?' };

// Which check-in is due at this moment, if any: { kind, day } with day as
// YYYY-MM-DD in New York, or null.
function due(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
  const kind = KINDS[parts.weekday];
  if (!kind || Number(parts.hour) < HOUR) return null;
  return { kind, day: `${parts.year}-${parts.month}-${parts.day}` };
}

// Post it if due. `sc` is a service-role client; errors are reported, never thrown.
async function run(sc, now = new Date(), log = console) {
  const d = due(now);
  if (!d || !sc) return null;
  const { data, error } = await sc.rpc('post_weekly_checkins', { p_kind: d.kind, p_day: d.day });
  if (error) {
    // Before the migration is applied the function does not exist: stay quiet.
    if (!/post_weekly_checkins|PGRST202|does not exist/i.test((error.code || '') + ' ' + (error.message || ''))) log.error('[checkins]', error.code || '', error.message || error);
    return null;
  }
  if (data) log.log('[checkins] posted ' + d.kind + ' check-in in ' + data + ' group(s)');
  return data;
}

// The newest check-in from the last week, shown pinned at the top of a group.
function pinned(posts, now = new Date()) {
  const weekAgo = now.getTime() - 7 * 86400000;
  return (posts || []).filter(p => p.kind === 'checkin' && new Date(p.created_at).getTime() >= weekAgo)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

// Top-level posts (newest first) with their replies (oldest first).
function threads(posts) {
  const replies = {};
  const top = [];
  (posts || []).forEach(p => { if (p.parent_id) (replies[p.parent_id] = replies[p.parent_id] || []).push(p); else top.push(p); });
  Object.values(replies).forEach(list => list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));
  top.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { top, replies };
}

module.exports = { ZONE, HOUR, TEXT, due, run, pinned, threads };
