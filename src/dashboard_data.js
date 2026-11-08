// The two cards at the top of the dashboard (views/dashboard/sections):
//
//  * money: this month's income from the income log, the recurring part of it,
//    last month for comparison, what to put aside for tax, and whether Stripe
//    is feeding the log.
//  * upcoming: everything with a date in the next seven days, from the
//    member's own boards, tasks, checklist renewals and challenges — plus
//    anything already overdue, so it is not forgotten.
//
// Read with the member's own client; RLS keeps it to their rows. A table that
// is missing (a migration not run yet) reads as empty rather than failing the
// dashboard.

const income = require('./income');
const registry = require('./engines/registry');

const DAY = 86400000;
const iso = d => d.toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(Date.parse(day + 'T00:00:00Z') + n * DAY));
const round2 = n => Math.round(n * 100) / 100;

async function moneyGlance(req, now = new Date()) {
  const [{ income: rows, expenses }, rate, stripe] = await Promise.all([
    income.load(req),
    income.setAsideRate(req).catch(() => null),
    req.sb.from('payment_connections').select('status, last_synced_at').eq('user_id', req.user.id).eq('provider', 'stripe').maybeSingle()
      .then(r => (r.error ? null : r.data), () => null)
  ]);
  const sum = income.summary(rows, expenses, now);
  const cur = income.thisMonth(now);
  const mine = rows.filter(r => String(r.entry_date || '').slice(0, 7) === cur);
  const recurring = round2(mine.filter(r => r.is_recurring).reduce((a, r) => a + (Number(r.amount) || 0), 0));
  return {
    month: cur,
    thisMonth: sum.thisMonth, lastMonth: sum.lastMonth, payments: mine.length, recurring,
    rate: rate === null ? null : rate,
    setAside: rate === null ? null : round2(sum.thisMonth * rate / 100),
    empty: !rows.length,
    stripe: stripe ? { status: stripe.status, last_synced_at: stripe.last_synced_at } : null
  };
}

// A query result → rows, treating a missing table or column as nothing there.
const rowsOf = r => (r && !r.error && Array.isArray(r.data) ? r.data : []);

/**
 * Dated things in the next `days` days, overdue ones first. `pinned` are the
 * dashboard's active challenges (they carry due_date already).
 * Returns { items: [{ when, kind, title, href, overdue, today }], more, total }.
 */
async function upcoming(sb, userId, { pinned = [], now = new Date(), days = 7, max = 8 } = {}) {
  const today = iso(now);
  const until = addDays(today, days);
  const back = addDays(today, -30);             // overdue older than a month is clutter
  const boards = registry.all().boards;
  const doneStages = {};
  boards.forEach(b => { doneStages[b.key] = new Set(b.stages.filter(s => s.done).map(s => s.key)); });

  const safe = p => Promise.resolve(p).catch(() => null);
  const [cards, tasks, renewals] = await Promise.all([
    safe(sb.from('pipeline_items').select('id, board, stage, title, due_on').eq('user_id', userId)
      .gte('due_on', back).lte('due_on', until).order('due_on', { ascending: true }).limit(200)),
    safe(sb.from('tasks').select('id, title, due_date, status').eq('user_id', userId).neq('status', 'done')
      .gte('due_date', back).lte('due_date', until).order('due_date', { ascending: true }).limit(200)),
    safe(sb.from('checklist_progress').select('checklist, item, due_on, done_at').eq('user_id', userId)
      .gte('due_on', back).lte('due_on', addDays(today, Math.max(days, 14))).limit(200))
  ]);

  const out = [];
  const add = (when, kind, title, href) => {
    const d = String(when || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < back) return;
    out.push({ when: d, kind, title: String(title || '').slice(0, 140), href, overdue: d < today, today: d === today });
  };

  rowsOf(cards).forEach(c => {
    const def = registry.board(c.board);
    if (!def || (doneStages[c.board] && doneStages[c.board].has(c.stage))) return;
    if (String(c.due_on).slice(0, 10) > until) return;
    add(c.due_on, (def.emoji ? def.emoji + ' ' : '') + def.label, c.title, '/workspace/boards/' + def.key + '/' + c.id);
  });
  rowsOf(tasks).forEach(t => {
    if (t.status === 'done' || String(t.due_date).slice(0, 10) > until) return;
    add(t.due_date, '✅ Task', t.title, '/tasks');
  });
  // Renewals get a fortnight's notice: a licence takes longer than a week to renew.
  rowsOf(renewals).forEach(r => {
    const def = registry.checklist(r.checklist);
    if (!def) return;
    const item = def.items.find(i => i.key === r.item);
    if (!item || !item.expires) return;
    add(r.due_on, '🔁 Renewal', item.label + ' · ' + def.label, '/workspace/checklists/' + def.key);
  });
  (pinned || []).forEach(a => {
    if (!a.due_date || String(a.due_date).slice(0, 10) > until) return;
    add(a.due_date, '🏁 Challenge ends', (a.challenge && a.challenge.title) || 'Challenge', '/quests');
  });

  out.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : a.kind.localeCompare(b.kind)));
  return { items: out.slice(0, max), more: Math.max(0, out.length - max), total: out.length, until };
}

// "Today", "Tomorrow", "Wed 12", or "3 days late".
function whenLabel(day, now = new Date()) {
  const today = iso(now);
  const diff = Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 0) return -diff === 1 ? '1 day late' : -diff + ' days late';
  const d = new Date(day + 'T12:00:00Z');
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' + d.getUTCDate();
}

module.exports = { moneyGlance, upcoming, whenLabel };
