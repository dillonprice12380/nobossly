// The Money page's numbers (views/budget.ejs, views/budget_history.ejs):
//
//  * overview: this month in, out and profit, against last month, and twelve
//    months of income against expenses for the chart.
//  * history: every payment and expense in one list, filtered by month or
//    year, by type, and by words in the source, category or note.
//  * export: a year's entries as CSV, and the same year summed by month and
//    category, for an accountant or a tax form.
//  * recurring expenses: a monthly cost is logged for the member each month on
//    the day they chose (migrations/2026-11-08_recurring_expenses.sql).
//
// Reads and writes use the member's own client; RLS keeps it to their rows.

const income = require('./income');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const ym = d => String(d || '').slice(0, 7);
const rowsOf = r => (r && !r.error && Array.isArray(r.data) ? r.data : []);
const missing = err => !!err && (err.code === '42P01' || err.code === 'PGRST205' || err.code === '42703' || /does not exist|Could not find the (table|column)/i.test(err.message || ''));
const monthName = (m, style = 'short') => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: style, timeZone: 'UTC' });
const fmt = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

/**
 * incomeRows: { entry_date, amount }; expenseRows: { spent_at, amount }.
 * Returns { month, thisMonth: { in, out, profit }, lastMonth: {…}, series: [12 months, oldest first], max }.
 */
function overview(incomeRows, expenseRows, now = new Date()) {
  const cur = income.thisMonth(now);
  const inc = income.byMonth(incomeRows, 'entry_date');
  const exp = income.byMonth(expenseRows, 'spent_at');
  const at = m => ({ in: inc[m] || 0, out: exp[m] || 0, profit: round2((inc[m] || 0) - (exp[m] || 0)) });
  const series = [];
  for (let i = 11; i >= 0; i--) {
    const m = income.addMonths(cur, -i);
    series.push(Object.assign({ month: m, label: monthName(m), year: m.slice(0, 4) }, at(m)));
  }
  const max = Math.max(0, ...series.map(s => Math.max(s.in, s.out)));
  const year = series.filter(s => s.year === cur.slice(0, 4));
  return {
    month: cur, monthLabel: monthName(cur, 'long'),
    thisMonth: at(cur), lastMonth: at(income.addMonths(cur, -1)),
    yearToDate: { in: round2(year.reduce((a, s) => a + s.in, 0)), out: round2(year.reduce((a, s) => a + s.out, 0)), profit: round2(year.reduce((a, s) => a + s.profit, 0)) },
    series, max, empty: !series.some(s => s.in || s.out)
  };
}

/**
 * The chart, worked out on the server so it needs no script: bars for income
 * and expenses per month, scaled to the tallest, with a few gridlines.
 */
function chart(series, max, { width = 720, height = 200, pad = 28 } = {}) {
  const top = niceMax(max);
  const plotH = height - pad - 6;
  const slot = (width - 44) / series.length;
  const barW = Math.max(4, Math.min(18, slot / 2 - 4));
  const y = v => 6 + plotH - (top ? v / top * plotH : 0);
  const bars = series.map((s, i) => {
    const x = 44 + i * slot + slot / 2;
    return {
      label: s.label, month: s.month, in: s.in, out: s.out, profit: s.profit,
      inX: round2(x - barW - 1), outX: round2(x + 1), w: round2(barW),
      inY: round2(y(s.in)), inH: round2(Math.max(s.in ? 1.5 : 0, 6 + plotH - y(s.in))),
      outY: round2(y(s.out)), outH: round2(Math.max(s.out ? 1.5 : 0, 6 + plotH - y(s.out))),
      labelX: round2(x)
    };
  });
  const grid = top ? [0, 0.5, 1].map(f => ({ y: round2(y(top * f)), label: fmt(top * f) })) : [];
  return { width, height, bars, grid, baseY: round2(6 + plotH), labelY: height - 8 };
}
function niceMax(v) {
  if (!(v > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// ------------------------------------------------------------------ History

/**
 * Filters from a query string → { month, year, type, q, from, to }. A month
 * wins over a year; with neither, the last twelve months.
 */
function filtersOf(query, now = new Date()) {
  const q = Object.assign({}, query || {});
  // The page's single "When" menu sends period=YYYY or period=YYYY-MM.
  if (q.period && !q.month && !q.year) { if (/^\d{4}-\d{2}$/.test(q.period)) q.month = q.period; else q.year = q.period; }
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.month || '')) ? String(q.month) : null;
  const year = !month && /^20\d{2}$/.test(String(q.year || '')) ? String(q.year) : null;
  const type = ['in', 'out'].includes(q.type) ? q.type : 'all';
  const text = String(q.q || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  let from, to;
  if (month) { from = month + '-01'; to = income.addMonths(month, 1) + '-01'; }
  else if (year) { from = year + '-01-01'; to = (Number(year) + 1) + '-01-01'; }
  else { from = income.addMonths(income.thisMonth(now), -11) + '-01'; to = income.addMonths(income.thisMonth(now), 1) + '-01'; }
  return { month, year, type, q: text, from, to };
}

const likeOf = q => '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';

/**
 * Payments and expenses between f.from and f.to, newest first, as one list:
 * { kind: 'in'|'out', id, date, amount, label, note, recurring, fromStripe }.
 * Plus totals for what is listed.
 */
async function history(sb, userId, f, max = 1000) {
  const wantIn = f.type !== 'out', wantOut = f.type !== 'in';
  const [inc, exp] = await Promise.all([
    wantIn ? income.payments(sb, userId, f.from, f.to) : [],
    wantOut ? sb.from('expenses').select('id, amount, category, note, spent_at, recurring_id').eq('user_id', userId)
      .gte('spent_at', f.from).lt('spent_at', f.to).order('spent_at', { ascending: false }).limit(2000)
      .then(r => (r.error && missing(r.error)
        ? sb.from('expenses').select('id, amount, category, note, spent_at').eq('user_id', userId).gte('spent_at', f.from).lt('spent_at', f.to).order('spent_at', { ascending: false }).limit(2000)
        : r)).then(rowsOf, () => []) : []
  ]);
  const words = f.q ? f.q.toLowerCase() : '';
  const has = (...xs) => !words || xs.some(x => String(x || '').toLowerCase().includes(words));
  const rows = (inc || []).filter(r => has(r.source, r.description)).map(r => ({
    kind: 'in', id: r.id, date: String(r.entry_date).slice(0, 10), amount: round2(r.amount),
    label: r.source || 'Payment', note: r.description || '', recurring: !!r.is_recurring
  })).concat(exp.filter(r => has(r.category, r.note)).map(r => ({
    kind: 'out', id: r.id, date: String(r.spent_at).slice(0, 10), amount: round2(r.amount),
    label: r.category || 'Expense', note: r.note || '', recurring: !!r.recurring_id
  })));
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.kind.localeCompare(b.kind)));
  const totIn = round2(rows.filter(r => r.kind === 'in').reduce((a, r) => a + r.amount, 0));
  const totOut = round2(rows.filter(r => r.kind === 'out').reduce((a, r) => a + r.amount, 0));
  return { rows: rows.slice(0, max), count: rows.length, totals: { in: totIn, out: totOut, profit: round2(totIn - totOut) } };
}

// ------------------------------------------------------------------- Export

// One CSV cell: quoted when it needs to be, and never read as a formula by a
// spreadsheet (a leading = + - @ gets an apostrophe).
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const line = cells => cells.map(cell).join(',');

// Every entry in a year: date, type, amount, from/category, note, recurring.
function transactionsCsv(rows) {
  const out = [line(['Date', 'Type', 'Amount', 'From / category', 'Note', 'Recurring'])];
  rows.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach(r => {
    out.push(line([r.date, r.kind === 'in' ? 'Income' : 'Expense', (r.kind === 'out' ? -r.amount : r.amount).toFixed(2), r.label, r.note, r.recurring ? 'yes' : '']));
  });
  return '﻿' + out.join('\r\n') + '\r\n';
}

// The year by month (income, expenses, profit), then expenses by category.
function summaryCsv(rows, year) {
  const months = Array.from({ length: 12 }, (_, i) => year + '-' + String(i + 1).padStart(2, '0'));
  const sum = (k, m) => round2(rows.filter(r => r.kind === k && ym(r.date) === m).reduce((a, r) => a + r.amount, 0));
  const out = [line(['Month', 'Income', 'Expenses', 'Profit'])];
  let ti = 0, to = 0;
  months.forEach(m => { const i = sum('in', m), o = sum('out', m); ti += i; to += o; out.push(line([monthName(m, 'long') + ' ' + year, i.toFixed(2), o.toFixed(2), (i - o).toFixed(2)])); });
  out.push(line(['Total ' + year, round2(ti).toFixed(2), round2(to).toFixed(2), round2(ti - to).toFixed(2)]));
  out.push('');
  out.push(line(['Expense category', 'Total']));
  const byCat = {};
  rows.filter(r => r.kind === 'out').forEach(r => { byCat[r.label] = round2((byCat[r.label] || 0) + r.amount); });
  Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).forEach(c => out.push(line([c, byCat[c].toFixed(2)])));
  out.push('');
  out.push(line(['Income by source', 'Total']));
  const bySrc = {};
  rows.filter(r => r.kind === 'in').forEach(r => { bySrc[r.label] = round2((bySrc[r.label] || 0) + r.amount); });
  Object.keys(bySrc).sort((a, b) => bySrc[b] - bySrc[a]).forEach(c => out.push(line([c, bySrc[c].toFixed(2)])));
  return '﻿' + out.join('\r\n') + '\r\n';
}

// ------------------------------------------------------ Recurring expenses

const firstOf = m => m + '-01';
/**
 * The months a rule still has to log, oldest first, up to `today`: each month
 * from the later of its start and the month after logged_through, whose day
 * has come. Never more than twelve at once, so a rule left a year does not
 * flood the log.
 */
function dueMonths(rule, today) {
  if (!rule || rule.stopped_at) return [];
  const day = Math.min(28, Math.max(1, Number(rule.day_of_month) || 1));
  const startM = ym(rule.starts_on || today);
  const afterLogged = rule.logged_through ? income.addMonths(ym(rule.logged_through), 1) : startM;
  let m = afterLogged > startM ? afterLogged : startM;
  const out = [];
  const curM = ym(today);
  while (m <= curM && out.length < 24) {
    const date = m + '-' + String(day).padStart(2, '0');
    if (date >= String(rule.starts_on || '').slice(0, 10) && date <= today) out.push({ month: m, date });
    m = income.addMonths(m, 1);
  }
  return out.slice(-12);
}

/**
 * Log whatever every active rule owes, then move each rule's logged_through
 * on. A month already logged (the unique constraint) is skipped quietly.
 * Returns { logged, rules } or { notReady: true } before the migration.
 */
async function catchUp(sb, userId, today = new Date().toISOString().slice(0, 10)) {
  const r = await sb.from('recurring_expenses').select('*').eq('user_id', userId).is('stopped_at', null).limit(50);
  if (r.error) return missing(r.error) ? { notReady: true, logged: 0, rules: [] } : { logged: 0, rules: [], error: r.error.message };
  let logged = 0;
  for (const rule of rowsOf(r)) {
    const due = dueMonths(rule, today);
    if (!due.length) continue;
    const rows = due.map(d => ({
      user_id: userId, category: rule.category, amount: rule.amount, note: rule.note || 'Monthly', spent_at: d.date,
      recurring_id: rule.id, recurring_period: firstOf(d.month)
    }));
    const ins = await sb.from('expenses').upsert(rows, { onConflict: 'recurring_id,recurring_period', ignoreDuplicates: true }).select('id');
    if (ins.error) { console.error('[recurring expenses]', ins.error.message); continue; }
    logged += rowsOf(ins).length;
    const last = due[due.length - 1].month;
    await sb.from('recurring_expenses').update({ logged_through: firstOf(last) }).eq('id', rule.id).eq('user_id', userId);
    rule.logged_through = firstOf(last);
  }
  return { logged, rules: rowsOf(r) };
}

// The add form → a rule row, or { error }.
function cleanRule(body, userId, today = new Date().toISOString().slice(0, 10)) {
  const b = body || {};
  const amount = Number(String(b.amount || '').replace(/[$,\s]/g, ''));
  if (!(amount > 0) || amount > 1e7) return { error: 'Enter what it costs each month.' };
  let category = String(b.category || '').trim();
  if (category === '__other') category = String(b.category_other || '').trim();
  category = category.slice(0, 40);
  if (!category) return { error: 'Pick a category.' };
  const day = Number.parseInt(b.day_of_month, 10);
  // From the start of this month: a rent due on the 1st, set up on the 8th,
  // has been paid this month too.
  const starts = /^\d{4}-\d{2}-\d{2}$/.test(String(b.starts_on || '')) ? String(b.starts_on) : today.slice(0, 8) + '01';
  return { row: {
    user_id: userId, category, amount: round2(amount), note: String(b.note || '').trim().slice(0, 200) || null,
    day_of_month: day >= 1 && day <= 28 ? day : 1, starts_on: starts
  } };
}

// An edited payment or expense → the fields to update, or { error }.
function cleanEntry(kind, body, today = new Date().toISOString().slice(0, 10)) {
  const b = body || {};
  const amount = Number(String(b.amount || '').replace(/[$,\s]/g, ''));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : null;
  if (!(amount > 0)) return { error: 'Enter the amount.' };
  if (!date) return { error: 'Pick a date.' };
  if (kind === 'in') {
    if (amount > 1e8) return { error: 'That amount is too large.' };
    if (date > today) return { error: 'A payment cannot be in the future.' };
    return { fields: {
      amount: round2(amount), entry_date: date,
      source: String(b.source || '').trim().slice(0, 80) || null,
      description: String(b.note || '').trim().slice(0, 200) || null,
      is_recurring: !!b.recurring
    } };
  }
  if (amount > 1e7) return { error: 'That amount is too large.' };
  let category = String(b.category || '').trim();
  if (category === '__other') category = String(b.category_other || '').trim();
  return { fields: { amount: round2(amount), spent_at: date, category: (category || 'Other').slice(0, 40), note: String(b.note || '').trim().slice(0, 200) || null } };
}

module.exports = { overview, chart, niceMax, filtersOf, history, cell, transactionsCsv, summaryCsv, dueMonths, catchUp, cleanRule, cleanEntry, missing, fmt };
