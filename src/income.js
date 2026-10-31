// The income log: one row per payment the side business received, kept by
// every member (free) in revenue_entries. The Budget page writes it; the
// Quit-Date Planner and Tax Set-Aside read it instead of asking for the same
// numbers again.
//
// Nothing here awards XP or a trophy. When the log shows a money rung has been
// reached, the member is pointed at the quest or trophy that records it, and
// claims it the usual way — a proof note, a member's confirmation.

const ladders = require('./ladders');

const round2 = n => Math.round(n * 100) / 100;
const ym = d => String(d || '').slice(0, 7);
const thisMonth = (now = new Date()) => now.toISOString().slice(0, 7);
function addMonths(m, i) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + i, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// Money gates on the ladders that the log can see. `month` is a threshold on a
// single month's income; `total` on everything ever logged.
const MONEY_GATES = [
  { title: 'Make your first sale',              kind: 'quest',  test: s => s.total > 0 },
  { title: 'Earn Your First $100',              kind: 'quest',  test: s => s.total >= 100 },
  { title: 'Hit a $1k month',                   kind: 'quest',  test: s => s.best >= 1000, month: 1000 },
  { title: 'Had my first profitable month',     kind: 'trophy', test: s => s.profitableMonth },
  { title: 'Three $1k months in a row',         kind: 'trophy', test: s => s.run1k >= 3, month: 1000, run: 3 }
];

// Totals per calendar month, for income and for business expenses.
function byMonth(rows, dateKey) {
  const out = {};
  (rows || []).forEach(r => {
    const m = ym(r[dateKey]);
    if (m) out[m] = round2((out[m] || 0) + (Number(r.amount) || 0));
  });
  return out;
}

/**
 * What the log says. `income` rows carry entry_date/amount, `expenses` rows
 * spent_at/amount (the Budget page's own table).
 *
 *  - avgProfit: average monthly profit (income minus business expenses) over
 *    the last three complete months since the first entry — or the current
 *    month alone if nothing has been logged before it.
 *  - growth: measured monthly growth, only with three or more months of
 *    profit to measure across; clamped so one lucky month is not a trend.
 */
function summary(income, expenses, now = new Date()) {
  const inc = byMonth(income, 'entry_date');
  const exp = byMonth(expenses, 'spent_at');
  const months = Object.keys(inc).sort();
  const cur = thisMonth(now);
  const total = round2(months.reduce((a, m) => a + inc[m], 0));
  const profit = m => round2((inc[m] || 0) - (exp[m] || 0));

  let window = [];
  if (months.length) {
    const complete = [];
    for (let m = months[0]; m < cur; m = addMonths(m, 1)) complete.push(m);
    window = complete.length ? complete.slice(-3) : [cur];
  }
  const avgProfit = window.length ? round2(window.reduce((a, m) => a + profit(m), 0) / window.length) : null;
  const avgIncome = window.length ? round2(window.reduce((a, m) => a + (inc[m] || 0), 0) / window.length) : null;

  // Growth across up to the last six complete months, end to end.
  let growth = null;
  if (months.length) {
    const span = [];
    for (let m = months[0]; m < cur; m = addMonths(m, 1)) span.push(m);
    const last = span.slice(-6);
    const a = profit(last[0]), b = profit(last[last.length - 1]);
    if (last.length >= 3 && a > 0 && b > 0) {
      const g = (Math.pow(b / a, 1 / (last.length - 1)) - 1) * 100;
      growth = Math.round(Math.max(-20, Math.min(30, g)) * 10) / 10;
    }
  }

  // Longest run of consecutive $1k months, and whether any month cleared its costs.
  let run1k = 0, run = 0;
  for (let m = months[0]; months.length && m <= cur; m = addMonths(m, 1)) {
    run = (inc[m] || 0) >= 1000 ? run + 1 : 0;
    run1k = Math.max(run1k, run);
  }
  const profitableMonth = months.some(m => inc[m] > 0 && inc[m] > (exp[m] || 0));
  const best = months.reduce((a, m) => Math.max(a, inc[m]), 0);

  return {
    months: months.length, first: months[0] || null, total, best, run1k, profitableMonth,
    thisMonth: inc[cur] || 0, lastMonth: inc[addMonths(cur, -1)] || 0,
    window: window.length ? { from: window[0], to: window[window.length - 1], count: window.length } : null,
    avgProfit, avgIncome, growth, byMonth: inc, profitOf: profit
  };
}

// The money gates on this member's own ladder, each with the rung it sits on.
function gatesOnPath(path) {
  const out = [];
  (ladders.ladderFor(path || 'default') || []).forEach(r => (r.gates || []).forEach(g => {
    const def = MONEY_GATES.find(d => d.title === g.title);
    if (def) out.push(Object.assign({ level: r.level, rung: r.title }, def));
  }));
  return out;
}

/**
 * Money gates the log says are reached but the member has not recorded yet.
 * `done` is the set of quest and trophy titles they already hold.
 */
function claimPrompts(path, sum, done) {
  return gatesOnPath(path)
    .filter(g => g.test(sum) && !done.has(g.title))
    .map(g => ({
      title: g.title, kind: g.kind, level: g.level, rung: g.rung,
      href: g.kind === 'quest' ? '/quests' : '/trophies',
      how: g.kind === 'quest'
        ? 'complete it on your quest board with a short proof note'
        : 'claim it on your trophies page with a proof link'
    }));
}

/**
 * The next money rung above the member's level, and when the log's pace
 * reaches it. Only month thresholds are forecast; a total or a profitable
 * month is either logged or it is not.
 */
function nextMoneyRung(path, level, sum, now = new Date()) {
  const ahead = gatesOnPath(path).filter(g => g.level > (level || 1) && g.month && !g.test(sum));
  const g = ahead.sort((a, b) => a.level - b.level)[0];
  if (!g) return null;
  const start = sum.avgIncome || 0;
  const rate = (sum.growth || 0) / 100;
  let eta = null;
  if (start >= g.month) eta = 0;
  else if (start > 0 && rate > 0) eta = Math.ceil(Math.log(g.month / start) / Math.log(1 + rate));
  if (eta !== null && g.run) eta += g.run - 1;
  return {
    title: g.title, level: g.level, rung: g.rung, threshold: g.month,
    eta: eta !== null && eta <= 120 ? { months: eta, month: addMonths(thisMonth(now), eta) } : null
  };
}

// Everything the pages need, read with the member's own client (RLS keeps it to
// their rows). Twenty-four months is enough for every number shown.
async function load(req) {
  const since = addMonths(thisMonth(), -24) + '-01';
  const [{ data: income }, { data: expenses }] = await Promise.all([
    req.sb.from('revenue_entries').select('id, amount, entry_date, source, description')
      .eq('user_id', req.user.id).eq('entry_type', 'revenue').gte('entry_date', since)
      .order('entry_date', { ascending: false }).limit(1000),
    req.sb.from('expenses').select('amount, category, spent_at')
      .eq('user_id', req.user.id).gte('spent_at', since).limit(2000)
  ]);
  return { income: income || [], expenses: expenses || [] };
}

// Quest and trophy titles the member already holds, so a prompt never asks for
// something they have.
async function doneTitles(req) {
  const [{ data: quests }, { data: trophies }] = await Promise.all([
    req.sb.from('challenge_completions').select('challenge:challenges(title)').eq('user_id', req.user.id),
    req.sb.from('user_milestones').select('custom_title, def:predefined_milestones(title)').eq('user_id', req.user.id)
  ]);
  const out = new Set();
  (quests || []).forEach(q => q.challenge && out.add(q.challenge.title));
  (trophies || []).forEach(t => out.add((t.def && t.def.title) || t.custom_title));
  return out;
}

module.exports = { MONEY_GATES, byMonth, summary, gatesOnPath, claimPrompts, nextMoneyRung, load, doneTitles, addMonths, thisMonth };
