// The income log's "Recurring" tick box, and the money numbers that fill in
// from the log (migrations/2026-11-08_recurring_income.sql).
//
//   node test/recurring_income.js

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
require('../src/path_dashboards');   // defines the path metrics
const { registry, metrics } = require('../src/engines');
const { FLAGS } = require('../src/features');

// A stand-in for supabase-js. rows: { table: [...] }. noColumn: pretend
// revenue_entries has no is_recurring yet (the migration has not run).
function fakeSb(rows = {}, { noColumn = false } = {}) {
  const calls = [];
  const from = table => {
    const st = { table, cols: '', filters: [], insert: null };
    const q = new Proxy({}, { get(_, prop) {
      if (prop === 'then') return (res, rej) => {
        let out;
        if (noColumn && table === 'revenue_entries' && (/is_recurring/.test(st.cols) || (st.insert && 'is_recurring' in st.insert))) {
          out = { data: null, error: { code: '42703', message: 'column revenue_entries.is_recurring does not exist' } };
        } else if (st.insert) {
          (rows[table] = rows[table] || []).push(st.insert); out = { data: null, error: null };
        } else {
          let data = (rows[table] || []).slice();
          for (const [op, col, v] of st.filters) {
            if (op === 'eq') data = data.filter(r => r[col] === undefined || r[col] === v);
            if (op === 'gte') data = data.filter(r => String(r[col]) >= v);
            if (op === 'lte') data = data.filter(r => String(r[col]) <= v);
            if (op === 'lt') data = data.filter(r => String(r[col]) < v);
          }
          out = { data, error: null };
        }
        calls.push(st);
        return Promise.resolve(out).then(res, rej);
      };
      if (prop === 'select') return c => { st.cols = c || ''; return q; };
      if (prop === 'insert') return r => { st.insert = r; return q; };
      if (['eq', 'gte', 'lte', 'lt'].includes(prop)) return (c, v) => { st.filters.push([prop, c, v]); return q; };
      if (prop === 'maybeSingle') return () => q;
      return () => q;
    } });
    return q;
  };
  return { from, calls, rows };
}

const NOW = new Date('2026-11-20T12:00:00Z');
const pay = (amount, date, rec) => ({ user_id: 'me', entry_type: 'revenue', amount, entry_date: date, is_recurring: rec });

(async () => {
  console.log('Which numbers fill in from the income log:');
  {
    const from = registry.all().metrics.filter(m => m.fromIncome).reduce((o, m) => (o[m.key] = m.fromIncome, o), {});
    ok('monthly recurring revenue counts recurring payments only', from.sw_mrr === 'recurring');
    ok('billable income, takings, creator income and revenue count every payment', ['fl_income', 'bm_takings', 'creator_income', 'con_revenue', 'shop_revenue', 'prod_revenue'].every(k => from[k] === 'all'), Object.keys(from).join(', '));
    ok('booked revenue, ad spend and averages do not (they are not money received)', !from.loc_revenue && !from.shop_ad_spend && !from.shop_aov && !from.bm_avg_spend);
    let threw = false;
    try { registry.defineMetric({ key: 'x_bad_from', label: 'Bad', unit: 'count', period: 'month', fromIncome: 'all' }); } catch (_) { threw = true; }
    ok('only a monthly money number can fill in from the log', threw);
  }

  console.log('\nMonthly recurring revenue:');
  {
    const sb = fakeSb({
      metric_entries: [],
      revenue_entries: [pay(29, '2026-11-02', true), pay(29, '2026-11-05', true), pay(400, '2026-11-09', false), pay(29, '2026-10-03', true), pay(12, '2026-08-15', false)]
    });
    const s = await metrics.series(sb, 'me', 'sw_mrr', 4, NOW);
    const by = Object.fromEntries(s.map(p => [p.period, p]));
    ok('a month adds up the payments ticked Recurring', by['2026-11-01'].value === 58 && by['2026-11-01'].source === 'income', JSON.stringify(by['2026-11-01']));
    ok('a one-off payment in the same month is left out', by['2026-11-01'].value === 58);
    ok('last month fills in too', by['2026-10-01'].value === 29);
    ok('a month with no recurring payment stays a gap, not a zero', by['2026-09-01'].value === null && by['2026-08-01'].value === null);

    const typed = fakeSb({ metric_entries: [{ id: 'e1', metric: 'sw_mrr', period: '2026-11-01', value: 50, note: 'annual plan spread' }], revenue_entries: sb.rows.revenue_entries });
    const s2 = await metrics.series(typed, 'me', 'sw_mrr', 4, NOW);
    const nov = s2.find(p => p.period === '2026-11-01');
    ok('a number the member typed for a month wins', nov.value === 50 && nov.source === 'typed' && nov.id === 'e1');
    ok('...and only for that month', s2.find(p => p.period === '2026-10-01').value === 29);

    const before = fakeSb({ metric_entries: [], revenue_entries: sb.rows.revenue_entries }, { noColumn: true });
    const s3 = await metrics.series(before, 'me', 'sw_mrr', 4, NOW);
    ok('before the migration runs, it shows nothing rather than failing', s3.every(p => p.value === null));
  }

  console.log('\nThe other income numbers:');
  {
    const rows = [pay(300, '2026-11-02', false), pay(150, '2026-11-18', true), pay(80, '2026-10-30', false)];
    const s = await metrics.series(fakeSb({ metric_entries: [], revenue_entries: rows }), 'me', 'fl_income', 3, NOW);
    ok('billable income adds up every payment in the month, recurring or not', s.find(p => p.period === '2026-11-01').value === 450 && s.find(p => p.period === '2026-10-01').value === 80);
    const s2 = await metrics.series(fakeSb({ metric_entries: [], revenue_entries: rows }, { noColumn: true }), 'me', 'fl_income', 3, NOW);
    ok('...and keeps working before the migration runs', s2.find(p => p.period === '2026-11-01').value === 450);
    const plain = await metrics.series(fakeSb({ metric_entries: [], revenue_entries: rows }), 'me', 'fl_active_clients', 3, NOW);
    ok('a number that does not come from the log never reads it', plain.every(p => p.value === null));
  }

  console.log('\nLogging a payment:');
  {
    const router = require('../src/routes/budget');
    const run = (body, sb) => new Promise(resolve => {
      const req = { method: 'POST', url: '/income', body, query: {}, params: {}, sb, user: { id: 'me' }, profile: { id: 'me', path: 'software' } };
      const res = { locals: {}, redirect: t => resolve({ redirect: t }), render: (v, d) => resolve({ view: v, data: d }), status() { return this; } };
      router.handle(req, res, e => resolve({ error: e || 'next' }));
    });
    const sb = fakeSb({});
    const r1 = await run({ amount: '29', date: '2026-11-02', source: 'Stripe', recurring: '1' }, sb);
    const saved = (sb.rows.revenue_entries || [])[0] || {};
    ok('ticking Recurring saves it on the payment', saved.is_recurring === true && saved.amount === 29 && /Logged/.test(decodeURIComponent(r1.redirect || '')), JSON.stringify(saved));
    await run({ amount: '400', date: '2026-11-03' }, sb);
    ok('leaving it unticked saves a one-off payment', sb.rows.revenue_entries[1].is_recurring === false);
    const old = fakeSb({}, { noColumn: true });
    const r3 = await run({ amount: '29', date: '2026-11-02', recurring: '1' }, old);
    ok('before the migration runs, the payment still saves (without the tick)', (old.rows.revenue_entries || []).length === 1 && !('is_recurring' in old.rows.revenue_entries[0]) && /Logged/.test(decodeURIComponent(r3.redirect || '')));
  }

  console.log('\nWhat members see:');
  {
    const budget = read('views/budget.ejs'), dash = read('views/dashboard.ejs');
    ok('the Money page and the dashboard both have the Recurring tick box', /name="recurring"/.test(budget) && /name="recurring"/.test(dash));
    ok('recurring payments are tagged in the payments list', /e\.is_recurring[\s\S]{0,80}Recurring/.test(budget));
    const base = { flags: FLAGS };
    const def = registry.metric('sw_mrr');
    const card = metrics.present(def, [{ period: '2026-10-01', label: 'Oct', value: 29, source: 'income' }, { period: '2026-11-01', label: 'Nov', value: 58, source: 'income' }]);
    const html = ejs.render(read('views/partials/metric_card.ejs'), Object.assign({}, base, { card }), { filename: path.join(ROOT, 'views/partials/metric_card.ejs') });
    ok('the dashboard card says the number came from the income log', html.includes('From your income log (recurring payments)') && html.includes('$58'));
    const empty = metrics.present(def, [{ period: '2026-11-01', label: 'Nov', value: null, source: null }]);
    const html2 = ejs.render(read('views/partials/metric_card.ejs'), Object.assign({}, base, { card: empty }), { filename: path.join(ROOT, 'views/partials/metric_card.ejs') });
    ok('...and, before there is one, how to get one', html2.includes('Tick Recurring when you log a subscription payment'));
    const page = read('views/workspace/metric.ejs');
    ok('the number\'s own page explains where it comes from, and that typing replaces it', /This fills in from your/.test(page) && /replaces the income log/.test(page));
    ok('months filled from the log show in its history, without a delete button', /From your income log/.test(read('src/routes/boards.js')) && /<% if \(h\.id\) \{ %>/.test(page));
  }

  console.log('\nThe migration:');
  {
    const sql = read('migrations/2026-11-08_recurring_income.sql');
    ok('it adds one column, unticked by default (a no-op where it already exists)', /add column if not exists is_recurring boolean not null default false/.test(sql));
    ok('it is marked as applied, and the column is in the schema snapshot', /^-- Applied live 2026-11-08/.test(sql) && !JSON.parse(read('test/schema-pending.json')).migrations['2026-11-08_recurring_income.sql'] && JSON.parse(read('test/schema-snapshot.json')).columns.revenue_entries.includes('is_recurring'));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
