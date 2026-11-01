// Metric logs: one named number per period — followers this month, billable
// income this month, jobs booked this week — and the trend it makes.
//
// A period is stored as its first day: the 1st of the month, or the Monday of
// the (ISO) week. Logging the same period twice replaces the number rather
// than adding a second row (unique on user, metric, period).

const registry = require('./registry');
const dates = require('./dates');
const fmt = require('./format');
const { EngineError, NotFound, must } = require('./errors');

const VALUE_MAX = 1000000000;   // metric_entries.value check

function metricOrThrow(key) {
  const def = registry.metric(key);
  if (!def) throw new NotFound('There is no metric called "' + key + '".');
  return def;
}

/**
 * The period a date or form value belongs to, as its first day.
 * Accepts 'YYYY-MM-DD', 'YYYY-MM' (<input type="month">), 'YYYY-Www'
 * (<input type="week">) or a Date; blank means the current period.
 */
function periodOf(def, input, now = new Date()) {
  const s = input instanceof Date ? dates.iso(input) : String(input === undefined || input === null ? '' : input).trim();
  let day;
  if (!s) day = dates.today(now);
  else if (dates.parseDate(s)) day = s;
  else if (dates.parseMonth(s)) day = s + '-01';
  else if (dates.weekStart(s)) day = dates.weekStart(s);
  else throw new EngineError('That period does not look like a date.');
  return def.period === 'week' ? dates.mondayOf(day) : day.slice(0, 7) + '-01';
}

// The period n steps before (negative) or after a period start.
const step = (def, period, n) => (def.period === 'week' ? dates.addDays(period, 7 * n) : dates.addMonths(period.slice(0, 7), n) + '-01');

// "Nov 2026" / "Week of 3 Nov 2026", and the short form under a chart bar.
function periodLabel(def, period, short) {
  if (def.period === 'month') return fmt.monthLabel(period, short);
  if (short) { const d = fmt.date(period).split(' '); return d[0] + ' ' + d[1]; }
  return 'Week of ' + fmt.date(period);
}

// What a form field for this period wants as its value.
const periodInput = (def, period) => (def.period === 'month' ? period.slice(0, 7) : dates.isoWeek(period));

function toValue(def, v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[$,\s%]/g, '').replace(/^−/, '-');
  if (!s) throw new EngineError('Enter a number for ' + def.label.toLowerCase() + '.');
  if (!/^-?\d*\.?\d+$/.test(s)) throw new EngineError(def.label + ' must be a number.');
  const n = Number(s);
  if (Math.abs(n) > VALUE_MAX) throw new EngineError(def.label + ' is too large.');
  return Math.round(n * 10000) / 10000;
}

async function log(sb, userId, key, periodInputValue, value, note, now = new Date()) {
  const def = metricOrThrow(key);
  const period = periodOf(def, periodInputValue, now);
  const v = toValue(def, value);
  const n = String(note || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null;
  const saved = must(await sb.from('metric_entries').upsert({
    user_id: userId, metric: def.key, period, value: v, note: n
  }, { onConflict: 'user_id,metric,period' }).select('id, metric, period, value, note, created_at').maybeSingle());
  return saved || { metric: def.key, period, value: v, note: n };
}

/**
 * The last n periods up to and including the current one, oldest first, with
 * null for a period nothing was logged in — a gap is a gap, not a zero.
 */
async function series(sb, userId, key, n = 12, now = new Date()) {
  const def = metricOrThrow(key);
  n = Math.max(1, Math.min(104, Number(n) || 12));
  const current = periodOf(def, '', now);
  const first = step(def, current, -(n - 1));
  const rows = must(await sb.from('metric_entries').select('id, period, value, note')
    .eq('user_id', userId).eq('metric', def.key).gte('period', first).lte('period', current)
    .order('period', { ascending: true })) || [];
  const by = {};
  rows.forEach(r => { by[String(r.period).slice(0, 10)] = r; });
  const out = [];
  for (let i = 0, p = first; i < n; i++, p = step(def, p, 1)) {
    const r = by[p];
    out.push({ period: p, label: periodLabel(def, p, true), value: r ? Number(r.value) : null, id: r ? r.id : null, note: r ? r.note : null });
  }
  return out;
}

// Every entry, newest first, for the history table.
async function entries(sb, userId, key, limit = 120) {
  const def = metricOrThrow(key);
  const rows = must(await sb.from('metric_entries').select('id, period, value, note, created_at')
    .eq('user_id', userId).eq('metric', def.key).order('period', { ascending: false }).limit(limit)) || [];
  return rows.map(r => Object.assign({}, r, { period: String(r.period).slice(0, 10), value: Number(r.value), label: periodLabel(def, String(r.period).slice(0, 10)) }));
}

/**
 * The headline numbers from a series: the latest logged value, the one before
 * it, the change between them, and the best period. `def` (optional) says
 * whether lower is better (costs, churn) — that decides "best" and "good".
 */
function summary(s, def) {
  const higher = !def || def.higherIsBetter !== false;
  const logged = (s || []).filter(p => p.value !== null && p.value !== undefined);
  const latest = logged.length ? logged[logged.length - 1] : null;
  const previous = logged.length > 1 ? logged[logged.length - 2] : null;
  let change = null, changePct = null;
  if (latest && previous) {
    change = Math.round((latest.value - previous.value) * 10000) / 10000;
    changePct = previous.value !== 0 ? Math.round((change / Math.abs(previous.value)) * 1000) / 10 : null;
  }
  const best = logged.reduce((b, p) => (!b || (higher ? p.value > b.value : p.value < b.value) ? p : b), null);
  return {
    latest: latest ? { period: latest.period, value: latest.value } : null,
    previous: previous ? { period: previous.period, value: previous.value } : null,
    change, changePct,
    best: best ? { period: best.period, value: best.value } : null,
    direction: change === null ? null : change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    good: change === null || change === 0 ? null : (change > 0) === higher,
    logged: logged.length
  };
}

// Everything the metric_card partial shows, formatted.
async function card(sb, userId, key, n = 8, now = new Date()) {
  const def = metricOrThrow(key);
  const s = await series(sb, userId, key, n, now);
  return present(def, s);
}

function present(def, s) {
  const sum = summary(s, def);
  const max = Math.max(0, ...s.map(p => Math.abs(p.value || 0)));
  return {
    def, series: s, summary: sum,
    bars: s.map(p => ({ label: p.label, value: p.value, pct: p.value === null || !max ? 0 : Math.max(4, Math.round(Math.abs(p.value) / max * 100)) })),
    display: {
      latest: sum.latest ? fmt.byUnit(def.unit, sum.latest.value) : '—',
      latestPeriod: sum.latest ? periodLabel(def, sum.latest.period) : '',
      change: sum.change === null ? '' : fmt.change(def.unit, sum.change),
      changePct: sum.changePct === null ? '' : (sum.changePct > 0 ? '+' : '') + fmt.number(sum.changePct) + '%',
      best: sum.best ? fmt.byUnit(def.unit, sum.best.value) : ''
    }
  };
}

async function remove(sb, userId, key, id) {
  const def = metricOrThrow(key);
  must(await sb.from('metric_entries').delete().eq('user_id', userId).eq('metric', def.key).eq('id', id));
  return true;
}

module.exports = { periodOf, periodLabel, periodInput, step, log, series, entries, summary, card, present, remove };
