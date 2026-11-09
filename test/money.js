// The Money page (src/money.js, src/routes/budget.js): profit at a glance and
// the 12-month chart, the full history with filters and editing, the tax-time
// export, and monthly costs that log themselves.
//
//   node test/money.js        (MONEY_OUT=dir also writes the pages as HTML)

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const money = require('../src/money');
const { FLAGS } = require('../src/features');

function fakeSb(answers = {}) {
  const writes = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, eq: {}, is: {}, gte: {}, lt: {}, single: false, opts: null };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          let out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          if (state.single && out && Array.isArray(out.data)) out = Object.assign({}, out, { data: out.data[0] || null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (k === 'maybeSingle') return () => { state.single = true; return chain; };
        if (['eq', 'is', 'gte', 'lt', 'lte', 'neq'].includes(k)) return (c, v) => { (state[k] = state[k] || {})[c] = v; return chain; };
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p, o) => { state.op = k; state.payload = p; state.opts = o; writes.push({ table, op: k, payload: p, opts: o, state }); return chain; };
        return () => chain;
      }
    });
    return chain;
  };
  return { from: q, writes, rpc: () => Promise.resolve({ data: null, error: null }) };
}
function run(router, method, url, { body = {}, query = {}, sb, profile } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user: { id: 'me' }, get: () => '',
      profile: Object.assign({ id: 'me', username: 'dana', path: 'freelancer', subscription_tier: 'free' }, profile || {}) };
    const res = {
      statusCode: 200, locals: {}, headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      send(b) { resolve({ body: b, headers: this.headers }); },
      redirect(to) { resolve({ redirect: to }); },
      render(view, data) { resolve({ view, data }); }
    };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}
const V = f => path.join(ROOT, 'views', f);
const base = {
  title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'dana', display_name: 'Dana', path: 'freelancer' }, plan: 'free', currentPath: '/budget', canonicalUrl: 'x',
  unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null, reactivated: false,
  isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null,
  affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
};
const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
const out = {};

(async () => {
  const now = new Date('2026-11-08T15:00:00Z');
  const pay = (d, a, src, rec) => ({ id: 'i' + d + a, entry_date: d, amount: a, source: src || 'Acme', is_recurring: !!rec });
  const spend = (d, a, c) => ({ id: 'e' + d + a, spent_at: d, amount: a, category: c || 'Software' });
  const inc = [pay('2026-11-03', 1200, 'Acme', true), pay('2026-11-06', 450.5, 'Etsy'), pay('2026-10-12', 2000), pay('2026-05-02', 300), pay('2025-11-20', 999)];
  const exp = [spend('2026-11-05', 29), spend('2026-11-07', 120, 'Marketing'), spend('2026-10-01', 400, 'Rent'), spend('2026-02-14', 60)];

  console.log('Profit at a glance and the chart:');
  const ov = money.overview(inc, exp, now);
  ok('this month: in, out and profit', ov.thisMonth.in === 1650.5 && ov.thisMonth.out === 149 && ov.thisMonth.profit === 1501.5, JSON.stringify(ov.thisMonth));
  ok('...against last month', ov.lastMonth.in === 2000 && ov.lastMonth.out === 400);
  ok('twelve months, oldest first, ending this month', ov.series.length === 12 && ov.series[0].month === '2025-12' && ov.series[11].month === '2026-11');
  ok('...so a payment thirteen months ago is not in it', !ov.series.some(s => s.month === '2025-11'));
  ok('the year so far', ov.yearToDate.in === 3950.5 && ov.yearToDate.out === 609 && ov.yearToDate.profit === 3341.5, JSON.stringify(ov.yearToDate));
  const c = money.chart(ov.series, ov.max);
  ok('the chart scales to a round top and draws every month', money.niceMax(2000) === 2000 && money.niceMax(2100) === 2500 && c.bars.length === 12 && c.grid[2].label === '$2,000');
  ok('...bars sit on the baseline and the tallest reaches the top', c.bars.every(b => Math.abs(b.inY + b.inH - c.baseY) < 0.02) && Math.abs(c.bars[10].inY - c.grid[2].y) < 0.02);
  ok('...and an empty month draws nothing', c.bars[1].inH === 0 && c.bars[1].outH === 0);

  console.log('\nHistory and filters:');
  const f0 = money.filtersOf({}, now);
  ok('by default: the last twelve months', f0.from === '2025-12-01' && f0.to === '2026-12-01' && f0.type === 'all');
  ok('a month, a year, the page\'s one "When" menu, and junk', money.filtersOf({ month: '2026-10' }).from === '2026-10-01' && money.filtersOf({ year: '2025' }).to === '2026-01-01' && money.filtersOf({ period: '2026-05' }).month === '2026-05' && money.filtersOf({ period: '2025' }).year === '2025' && money.filtersOf({ month: '2026-13', type: 'x' }, now).type === 'all');
  // Like the database: only rows inside the asked-for dates.
  const within = (rows, col) => s => ({ data: rows.filter(r => (!s.gte[col] || r[col] >= s.gte[col]) && (!s.lt[col] || r[col] < s.lt[col])), error: null });
  const histSb = () => fakeSb({ revenue_entries: within(inc, 'entry_date'), expenses: within(exp, 'spent_at') });
  const h = await money.history(histSb(), 'me', money.filtersOf({}, now));
  ok('payments and expenses in one list, newest first', h.rows.map(r => r.date).join() === inc.concat(exp).map(r => r.entry_date || r.spent_at).filter(d => d >= '2025-12-01').sort().reverse().join() && h.rows[0].kind === 'out');
  ok('with totals for what is listed', h.totals.in === 3950.5 && h.totals.out === 609, JSON.stringify(h.totals));
  ok('...and nothing from before the twelve months', !h.rows.some(r => r.date < '2025-12-01'));
  const hq = await money.history(histSb(), 'me', money.filtersOf({ q: 'etsy' }, now));
  ok('words match the source, category or note', hq.rows.length === 1 && hq.rows[0].label === 'Etsy');
  const ho = await money.history(histSb(), 'me', money.filtersOf({ type: 'out' }, now));
  ok('Expenses only shows expenses', ho.rows.every(r => r.kind === 'out') && ho.totals.in === 0);
  const br = require('../src/routes/budget');
  {
    const r = await run(br, 'GET', '/history', { sb: histSb(), query: { type: 'in' } });
    out.history = render('budget_history.ejs', r.data);
    ok('the history page lists them by month, each a link to edit it', r.view === 'budget_history' && out.history.includes('November 2026') && /href="\/budget\/entry\/in\/i2026-11-031200\?back=/.test(out.history) && out.history.includes('+$1,200.00'), out.history.startsWith('ERR') ? out.history.slice(0, 300) : undefined);
  }

  console.log('\nEditing an entry:');
  ok('a payment edit is cleaned', JSON.stringify(money.cleanEntry('in', { amount: '$1,250.5', date: '2026-11-03', source: ' Acme ', recurring: '1' }, '2026-11-08').fields) === JSON.stringify({ amount: 1250.5, entry_date: '2026-11-03', source: 'Acme', description: null, is_recurring: true }));
  ok('...and refuses a future payment, no amount or no date', !!money.cleanEntry('in', { amount: '5', date: '2026-12-01' }, '2026-11-08').error && !!money.cleanEntry('in', { amount: '0', date: '2026-11-01' }).error && !!money.cleanEntry('out', { amount: '5' }).error);
  ok('an expense can take a category of its own', money.cleanEntry('out', { amount: '9', date: '2026-11-01', category: '__other', category_other: 'Props' }).fields.category === 'Props');
  {
    const sb = fakeSb({ expenses: { data: [{ id: '00000000-0000-0000-0000-0000000000e1', user_id: 'me', amount: 29, category: 'Software', spent_at: '2026-11-05', recurring_id: 'r1' }], error: null } });
    const g = await run(br, 'GET', '/entry/out/00000000-0000-0000-0000-0000000000e1', { sb, query: { back: '/budget/history?type=out' } });
    out.edit = render('budget_edit.ejs', g.data);
    ok('the edit page has the entry filled in', g.view === 'budget_edit' && out.edit.includes('value="29.00"') && out.edit.includes('Logged by a monthly cost') && out.edit.includes('value="/budget/history?type=out"'), out.edit.startsWith('ERR') ? out.edit.slice(0, 300) : undefined);
    const p = await run(br, 'POST', '/entry/out/00000000-0000-0000-0000-0000000000e1', { sb, body: { amount: '31', date: '2026-11-05', category: 'Software', back: '/budget/history?type=out' } });
    const w = sb.writes.find(x => x.op === 'update');
    ok('saving updates only that row, then goes back', !!w && w.payload.amount === 31 && w.state.eq.id === '00000000-0000-0000-0000-0000000000e1' && w.state.eq.user_id === 'me' && p.redirect === '/budget/history?type=out&msg=Saved.');
    const d = await run(br, 'POST', '/entry/out/00000000-0000-0000-0000-0000000000e1', { sb: fakeSb(), body: { delete: '1', back: 'https://evil.example' } });
    ok('delete works, and "back" never leaves the Money pages', d.redirect.startsWith('/budget/history?msg='));
    const bad = await run(br, 'GET', '/entry/x/1', { sb: fakeSb() });
    ok('unknown kinds and ids are a 404', bad.view === 'error');
  }

  console.log('\nExport:');
  const rows = (await money.history(histSb(), 'me', money.filtersOf({ year: '2026' }), 100000)).rows;
  const tx = money.transactionsCsv(rows);
  ok('every entry, oldest first, expenses as negatives, with a BOM for Excel', tx.startsWith('﻿Date,Type,Amount') && tx.split('\r\n')[1].startsWith('2026-02-14,Expense,-60.00') && tx.includes('2026-11-03,Income,1200.00,Acme,,yes'));
  ok('spreadsheet formulas and commas are made safe', money.cell('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"' && money.cell('-60.00') === '-60.00' && money.cell('a,b') === '"a,b"');
  const sum = money.summaryCsv(rows, '2026');
  ok('the summary has each month, the year total, categories and sources', sum.includes('November 2026,1650.50,149.00,1501.50') && sum.includes('Total 2026,3950.50,609.00,3341.50') && sum.includes('Rent,400.00') && sum.includes('Acme,3500.00'), sum.split('\r\n').slice(10, 16).join(' | '));
  {
    const r = await run(br, 'GET', '/export/summary.csv', { sb: histSb(), query: { year: '2026' } });
    ok('the download is a CSV named for the year', r.headers['Content-Type'].startsWith('text/csv') && /nobossly-2026-summary\.csv/.test(r.headers['Content-Disposition']) && r.body.includes('Total 2026'));
    const bad = await run(br, 'GET', '/export/passwords.csv', { sb: histSb() });
    ok('only the two files exist', bad.redirect === '/budget/export');
    out.export = render('budget_export.ejs', { years: ['2026', '2025', '2024'] });
    ok('the export page offers both, and gives no tax advice', out.export.includes('/budget/export/summary.csv') && out.export.includes('/budget/export/transactions.csv') && out.export.includes('does not file anything or give tax advice'));
  }

  console.log('\nMonthly costs:');
  const rule = { id: 'r1', category: 'Software', amount: 29, day_of_month: 5, starts_on: '2026-09-01', logged_through: null, stopped_at: null };
  ok('a rule owes each month whose day has come', money.dueMonths(rule, '2026-11-08').map(d => d.date).join() === '2026-09-05,2026-10-05,2026-11-05');
  ok('...not this month before the day', money.dueMonths(rule, '2026-11-04').map(d => d.month).join() === '2026-09,2026-10');
  ok('...nothing already logged, so a deleted one stays deleted', money.dueMonths(Object.assign({}, rule, { logged_through: '2026-10-01' }), '2026-11-08').map(d => d.month).join() === '2026-11');
  ok('...nothing once stopped, and never more than twelve at once', !money.dueMonths(Object.assign({}, rule, { stopped_at: '2026-10-01' }), '2026-11-08').length && money.dueMonths(Object.assign({}, rule, { starts_on: '2023-01-01' }), '2026-11-08').length === 12);
  ok('set up today with a day already past: this month counts', money.cleanRule({ amount: '400', category: 'Rent', day_of_month: '1' }, 'me', '2026-11-08').row.starts_on === '2026-11-01');
  ok('...and the form is cleaned', (() => { const r = money.cleanRule({ amount: '$1,200', category: '__other', category_other: 'Studio', day_of_month: '31' }, 'me', '2026-11-08').row; return r.amount === 1200 && r.category === 'Studio' && r.day_of_month === 1; })() && !!money.cleanRule({ amount: '0', category: 'x' }, 'me').error);
  {
    const sb = fakeSb({ recurring_expenses: { data: [rule], error: null }, expenses: s => ({ data: s.op === 'upsert' ? s.payload.map((p, i) => ({ id: 'n' + i })) : [], error: null }) });
    const r = await money.catchUp(sb, 'me', '2026-11-08');
    const up = sb.writes.find(w => w.table === 'expenses');
    ok('catching up logs the months owed, never twice', r.logged === 3 && up.op === 'upsert' && up.opts.onConflict === 'recurring_id,recurring_period' && up.opts.ignoreDuplicates && up.payload[2].recurring_period === '2026-11-01' && up.payload[2].spent_at === '2026-11-05');
    ok('...then remembers how far it got', sb.writes.some(w => w.table === 'recurring_expenses' && w.payload.logged_through === '2026-11-01'));
    const nr = await money.catchUp(fakeSb({ recurring_expenses: { data: null, error: { code: '42P01', message: 'relation does not exist' } } }), 'me');
    ok('before the migration it quietly does nothing', nr.notReady === true && nr.logged === 0);
  }
  {
    const sb = fakeSb({ recurring_expenses: { data: [], error: null } });
    const r = await run(br, 'POST', '/recurring', { sb, body: { amount: '29', category: 'Software', note: 'Canva Pro', day_of_month: '5' } });
    ok('adding a monthly cost says when it is logged', sb.writes.some(w => w.table === 'recurring_expenses' && w.op === 'insert' && w.payload.user_id === 'me') && /set up for the 5th of each month/.test(decodeURIComponent(r.redirect)));
    const s2 = fakeSb();
    await run(br, 'POST', '/recurring/00000000-0000-0000-0000-0000000000a1/stop', { sb: s2 });
    ok('stopping one only marks it stopped', s2.writes.length === 1 && !!s2.writes[0].payload.stopped_at && s2.writes[0].state.eq.user_id === 'me');
  }

  console.log('\nThe Money page:');
  {
    const sb = fakeSb({
      revenue_entries: { data: inc, error: null }, expenses: { data: exp, error: null }, budgets: { data: [], error: null },
      recurring_expenses: { data: [Object.assign({}, rule, { logged_through: '2026-11-01', note: 'Canva Pro' })], error: null },
      payment_connections: { data: null, error: null }, challenge_completions: { data: [] }, user_milestones: { data: [] }, premium_tool_data: { data: [] }
    });
    const r = await run(br, 'GET', '/', { sb });
    out.money = render('budget.ejs', r.data);
    const h = out.money;
    ok('it renders', r.view === 'budget' && !h.startsWith('ERR'), h.startsWith('ERR') ? h.slice(0, 300) : undefined);
    ok('profit at a glance leads, before the income form and the tools', h.indexOf('class="card money-ov"') > 0 && h.indexOf('money-ov') < h.indexOf('id="income"') && h.indexOf('id="income"') < h.indexOf('Money tools'));
    ok('...with the chart and its numbers on hover', h.includes('aria-label="Income and expenses for the last twelve months"') && /<title>Nov: \$1,651 in, \$149 out, \$1,502 profit<\/title>/.test(h));
    ok('monthly costs are listed with their day and a Stop button', h.includes('id="monthly"') && h.includes('Canva Pro') && h.includes('on the 5th') && h.includes('/budget/recurring/r1/stop'));
    ok('History and Export are one click away', h.includes('href="/budget/history"') && h.includes('href="/budget/export"'));
    ok('entries on the page open the editor', h.includes('href="/budget/entry/in/'));
  }

  if (process.env.MONEY_OUT) {
    const css = x => x.replace(/href="\/css\/style\.css\?v=\d+"/, 'href="' + path.join(ROOT, 'public/css/style.css') + '"');
    for (const [k, v] of Object.entries(out)) fs.writeFileSync(path.join(process.env.MONEY_OUT, k + '.html'), css(v));
  }
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
