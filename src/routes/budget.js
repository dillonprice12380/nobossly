const router = require('express').Router();
const { planOf } = require('../middleware/auth');
const starter = require('../starter_budget');
const income = require('../income');
const calc = require('../tools_calc');
const premium = require('../premium');
const dashboards = require('../path_dashboards');
const { FLAGS } = require('../features');
const moneyLib = require('../money');
// "Your income log shows a money rung: claim it" belongs to the levels system;
// with levels off there is nothing to claim.
const claimsFor = (path, sum, done) => (FLAGS.ladder || FLAGS.trophies ? income.claimPrompts(path, sum, done) : []);

const isPaid = req => planOf(req.profile) === 'paid';

// Load the budget view payload.
async function loadBudget(req, extra = {}) {
  // Monthly costs the member set up are logged first, so this month's numbers
  // include them (src/money.js).
  const rec = await moneyLib.catchUp(req.sb, req.user.id).catch(e => { console.error('[recurring]', e.message || e); return { rules: [], logged: 0 }; });
  const monthStart = new Date(); monthStart.setDate(1);
  const ms = monthStart.toISOString().slice(0, 10);
  // The launch budget the member declared when they picked their path. This
  // tab is about money and it should not ignore the one money number they
  // already gave us — see src/starter_budget.js.
  const [{ data: budgets }, { data: expenses }] = await Promise.all([
    req.sb.from('budgets').select('*').eq('user_id', req.user.id).order('category'),
    req.sb.from('expenses').select('*').eq('user_id', req.user.id).gte('spent_at', ms).order('spent_at', { ascending: false }).limit(200)
  ]);
  // The launch budget came from the old questionnaire (questionnaire_responses),
  // an AI-era table being dropped. Nobody who joined since was asked it.
  const q = null;
  const spentByCat = {};
  let totalSpent = 0;
  (expenses || []).forEach(e => { const amt = Number(e.amount) || 0; spentByCat[e.category] = (spentByCat[e.category] || 0) + amt; totalSpent += amt; });
  const totalBudget = (budgets || []).reduce((s, b) => s + (Number(b.monthly_limit) || 0), 0);
  const cats = [...new Set([...(budgets || []).map(b => b.category), ...Object.keys(spentByCat)])];
  const launchBudget = (q && q.launch_budget) || null;
  const [log, done, rate, stripeRes] = await Promise.all([income.load(req), income.doneTitles(req), setAsideRate(req),
    // The Stripe connection, if any (migrations/2026-11-08_stripe_connection.sql).
    req.sb.from('payment_connections').select('status, key_hint, last_synced_at, imported_count').eq('user_id', req.user.id).eq('provider', 'stripe').maybeSingle().then(r => r, () => ({ data: null }))]);
  // Bank transactions waiting to be sorted (migrations/2026-11-09_more_connections.sql).
  const waitingRes = await req.sb.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'new').then(r => r, () => ({ count: 0 }));
  const sum = income.summary(log.income, log.expenses);
  const ov = moneyLib.overview(log.income, log.expenses);
  return Object.assign({
    overview: ov, chart: moneyLib.chart(ov.series, ov.max), fmt: moneyLib.fmt,
    rules: rec.rules || [], rulesReady: !rec.notReady, recurringLogged: rec.logged || 0,
    stripeConn: (stripeRes && stripeRes.data) || null, bankWaiting: (waitingRes && !waitingRes.error && waitingRes.count) || 0,
    title: 'Money', budgets: budgets || [], expenses: expenses || [],
    incomeLog: log.income.slice(0, 25), incomeSum: sum, setAsideRate: rate,
    claims: claimsFor(req.profile.path, sum, done),
    spentByCat, totalSpent, totalBudget, cats,
    monthLabel: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    paid: isPaid(req), msg: req.query.msg || null, insights: null,
    launchBudget,
    launchBudgetUsd: starter.dollarsFor(launchBudget),
    // Offered only while there is nothing to overwrite. Seeding on top of
    // categories someone has already set would be the app editing their budget.
    suggestion: (budgets || []).length ? [] : starter.suggest(launchBudget, req.profile.path),
    starterMonths: starter.MONTHS,
    budgetCategories: require('../budget_categories').STANDARD,
    // The money tools (pricing, tax, the path's cost and price worksheets) and
    // the path's dollar number logs: Dashboard → Money is their home.
    moneyTools: dashboards.moneyToolsFor(req.profile && req.profile.path),
    moneyMetrics: ((dashboards.pathItemsFor(req.profile) || {}).moneyMetrics) || []
  }, extra);
}

const setAsideRate = income.setAsideRate;   // shared with the dashboard (src/income.js)

router.get('/', async (req, res, next) => {
  try {
    res.render('budget', await loadBudget(req));
  } catch (e) { next(e); }
});

// Seed the categories from the declared launch budget. Free, deterministic, no
// AI: this is arithmetic on an answer they already gave. Refuses when anything
// is already set, so it can only ever fill a blank.
router.post('/start', async (req, res, next) => {
  try {
    const { data: existing } = await req.sb.from('budgets').select('id').eq('user_id', req.user.id).limit(1);
    if (existing && existing.length) return res.redirect('/budget');
    const q = null; // see loadBudget: the launch-budget answer is gone with the questionnaire
    const rows = starter.suggest(q && q.launch_budget, req.profile.path);
    if (!rows.length) return res.redirect('/budget');
    await req.sb.from('budgets').insert(rows.map(r => ({ user_id: req.user.id, ...r })));
    res.redirect('/budget?msg=' + encodeURIComponent(
      'Started from the ' + (q && q.launch_budget) + ' you said you could put in, spread over ' +
      starter.MONTHS + ' months. Change any of it below.'));
  } catch (e) { next(e); }
});

router.post('/category', async (req, res, next) => {
  try {
    const category = (req.body.category || '').trim().slice(0, 40);
    const limit = Math.max(0, parseFloat(req.body.monthly_limit) || 0);
    if (category) {
      await req.sb.from('budgets').upsert({ user_id: req.user.id, category, monthly_limit: limit }, { onConflict: 'user_id,category' });
    }
    res.redirect('/budget');
  } catch (e) { next(e); }
});

router.post('/category/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('budgets').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/budget');
  } catch (e) { next(e); }
});

router.post('/expense', async (req, res, next) => {
  try {
    let category = (req.body.category || '').trim();
    if (category === '__other') category = (req.body.category_other || '').trim();
    category = (category || 'Other').slice(0, 40);
    const amount = parseFloat(req.body.amount);
    if (category && amount > 0 && amount <= 1e7) {
      await req.sb.from('expenses').insert({
        user_id: req.user.id, category, amount: Math.round(amount * 100) / 100,
        note: (req.body.note || '').slice(0, 200) || null,
        spent_at: /^\d{4}-\d{2}-\d{2}$/.test(req.body.spent_at || '') ? req.body.spent_at : new Date().toISOString().slice(0, 10)
      });
    }
    res.redirect('/budget#expenses');
  } catch (e) { next(e); }
});

router.post('/expense/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('expenses').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/budget');
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ Income
const today = () => new Date().toISOString().slice(0, 10);
const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const backTo = req => (req.body.from === 'dashboard' ? '/dashboard' : '/budget');

router.post('/income', async (req, res, next) => {
  try {
    const amount = calc.num(req.body.amount, { max: 1e8 });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') && req.body.date <= today() ? req.body.date : today();
    const to = backTo(req);
    if (!(amount > 0)) return res.redirect(to + '?msg=' + encodeURIComponent('Enter the amount you were paid.'));
    const row = {
      user_id: req.user.id, entry_type: 'revenue', amount, entry_date: date,
      source: String(req.body.source || '').trim().slice(0, 80) || null,
      description: String(req.body.note || '').trim().slice(0, 200) || null
    };
    // Ticked "Recurring": a subscription or retainer payment. It feeds monthly
    // recurring revenue (src/engines/metrics.js). Before the column exists
    // (migrations/2026-11-08_recurring_income.sql) the payment saves without it.
    let { error } = await req.sb.from('revenue_entries').insert(Object.assign({ is_recurring: !!req.body.recurring }, row));
    if (error && /is_recurring/.test(error.message || '')) ({ error } = await req.sb.from('revenue_entries').insert(row));
    if (error) return res.redirect(to + '?msg=' + encodeURIComponent('Could not save that payment. Please try again.'));

    // Say what to put aside, and whether that payment just reached a money
    // rung the member has not recorded yet.
    const [log, done, rate] = await Promise.all([income.load(req), income.doneTitles(req), setAsideRate(req)]);
    const claims = claimsFor(req.profile.path, income.summary(log.income, log.expenses), done);
    let m = 'Logged ' + money(amount) + '. Put about ' + money(amount * rate / 100) + ' of it aside for tax.';
    if (claims.length) m += ' Your income log shows “' + claims[0].title + '” — ' + claims[0].how + '.';
    res.redirect(to + '?msg=' + encodeURIComponent(m));
  } catch (e) { next(e); }
});

router.post('/income/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('revenue_entries').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/budget');
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------- History
// Every payment and expense, filtered; each one editable.
router.get('/history', async (req, res, next) => {
  try {
    await moneyLib.catchUp(req.sb, req.user.id).catch(() => null);
    const f = moneyLib.filtersOf(req.query);
    const h = await moneyLib.history(req.sb, req.user.id, f);
    const thisYear = Number(today().slice(0, 4));
    res.render('budget_history', {
      title: 'Money history', f, h, years: [thisYear, thisYear - 1, thisYear - 2].map(String),
      months: Array.from({ length: 12 }, (_, i) => income.addMonths(income.thisMonth(), -i)),
      monthLabel: m => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

const KINDS = { in: 'revenue_entries', out: 'expenses' };
const ownEntry = (req) => {
  const table = KINDS[req.params.kind];
  if (!table || !/^[0-9a-f-]{36}$/i.test(req.params.id)) return Promise.resolve({ data: null });
  return req.sb.from(table).select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
};
const backOf = req => { const b = String((req.body && req.body.back) || (req.query && req.query.back) || ''); return /^\/budget(\/history)?(\?[\w=&%.-]*)?$/.test(b) ? b : '/budget/history'; };

router.get('/entry/:kind/:id', async (req, res, next) => {
  try {
    const { data: e } = await ownEntry(req);
    if (!e) return res.status(404).render('error', { title: 'Not found', message: 'That entry is gone.' });
    res.render('budget_edit', {
      title: req.params.kind === 'in' ? 'Edit payment' : 'Edit expense', kind: req.params.kind, e, back: backOf(req),
      budgetCategories: require('../budget_categories').STANDARD, today: today(), err: req.query.err || null
    });
  } catch (e) { next(e); }
});

router.post('/entry/:kind/:id', async (req, res, next) => {
  try {
    const table = KINDS[req.params.kind];
    const back = backOf(req);
    const self = '/budget/entry/' + req.params.kind + '/' + req.params.id + '?back=' + encodeURIComponent(back);
    if (!table) return res.redirect('/budget/history');
    if (req.body.delete) {
      await req.sb.from(table).delete().eq('id', req.params.id).eq('user_id', req.user.id);
      return res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('Deleted.'));
    }
    const c = moneyLib.cleanEntry(req.params.kind, req.body, today());
    if (c.error) return res.redirect(self + '&err=' + encodeURIComponent(c.error));
    let { error } = await req.sb.from(table).update(c.fields).eq('id', req.params.id).eq('user_id', req.user.id);
    if (error && req.params.kind === 'in' && /is_recurring/.test(error.message || '')) {
      delete c.fields.is_recurring;
      ({ error } = await req.sb.from(table).update(c.fields).eq('id', req.params.id).eq('user_id', req.user.id));
    }
    if (error) return res.redirect(self + '&err=' + encodeURIComponent('That did not save. Try again.'));
    res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('Saved.'));
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ Export
// A year as CSV: every entry, or summed by month and category.
router.get('/export', (req, res) => {
  const y = Number(today().slice(0, 4));
  res.render('budget_export', { title: 'Export for tax time', years: [y, y - 1, y - 2].map(String) });
});

router.get('/export/:file', async (req, res, next) => {
  try {
    const file = req.params.file;
    if (!['transactions.csv', 'summary.csv'].includes(file)) return res.redirect('/budget/export');
    const year = /^20\d{2}$/.test(String(req.query.year || '')) ? String(req.query.year) : today().slice(0, 4);
    await moneyLib.catchUp(req.sb, req.user.id).catch(() => null);
    const h = await moneyLib.history(req.sb, req.user.id, moneyLib.filtersOf({ year }), 100000);
    const body = file === 'summary.csv' ? moneyLib.summaryCsv(h.rows, year) : moneyLib.transactionsCsv(h.rows);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="nobossly-' + year + '-' + file.replace('.csv', '') + '.csv"');
    res.send(body);
  } catch (e) { next(e); }
});

// ------------------------------------------------------- Recurring expenses
router.post('/recurring', async (req, res, next) => {
  try {
    const c = moneyLib.cleanRule(req.body, req.user.id, today());
    if (c.error) return res.redirect('/budget?msg=' + encodeURIComponent(c.error) + '#monthly');
    const { error } = await req.sb.from('recurring_expenses').insert(c.row);
    if (error) return res.redirect('/budget?msg=' + encodeURIComponent(moneyLib.missing(error) ? 'Monthly costs are being switched on. Check back shortly.' : 'That did not save. Try again.') + '#monthly');
    const r = await moneyLib.catchUp(req.sb, req.user.id, today());
    const m = c.row.category + ' (' + moneyLib.fmt(c.row.amount) + ') is set up for the ' + ordinal(c.row.day_of_month) + ' of each month.' + (r.logged ? ' This month\'s is logged.' : '');
    res.redirect('/budget?msg=' + encodeURIComponent(m) + '#monthly');
  } catch (e) { next(e); }
});

router.post('/recurring/:id/stop', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.redirect('/budget#monthly');
    await req.sb.from('recurring_expenses').update({ stopped_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/budget?msg=' + encodeURIComponent('Stopped. What was already logged stays in your expenses.') + '#monthly');
  } catch (e) { next(e); }
});

const ordinal = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

// ------------------------------------------------------------ CSV import
// Upload an export from a bank, Stripe, PayPal, Etsy, Shopify or a sheet;
// see what would come in (src/csv_import.js), adjust the columns, then save.
// Nothing is stored between the steps: the preview carries the file's text
// back in a multipart form, and saving re-reads it from scratch.
const multer = require('multer');
const csv = require('../csv_import');
const CSV_MAX = 2 * 1024 * 1024;
const csvForm = multer({ storage: multer.memoryStorage(), limits: { fileSize: CSV_MAX, fieldSize: CSV_MAX * 1.5, files: 1, fields: 20 } });
const takeCsv = (req, res, next) => csvForm.single('file')(req, res, err => {
  if (err) return res.redirect('/budget/import?msg=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 2 MB. Export a shorter date range and try again.' : 'That upload did not work. Please try again.'));
  next();
});

// A file's text: UTF-8, or Latin-1 when it is not valid UTF-8 (older bank exports).
function textOf(buf) {
  const u = buf.toString('utf8');
  return u.includes('�') ? buf.toString('latin1') : u;
}

const signed = n => (n < 0 ? '−' + money(-n) : money(n));
const colOf = v => (/^-?\d+$/.test(String(v)) ? Math.max(-1, Math.min(200, parseInt(v, 10))) : undefined);
function optsOf(req, existing) {
  const b = req.body || {};
  const columns = {};
  for (const k of ['date', 'amount', 'debit', 'description', 'status', 'type']) { const c = colOf(b['col_' + k]); if (c !== undefined) columns[k] = c; }
  return {
    columns, existing, today: today(),
    source: b.source === undefined ? undefined : String(b.source).slice(0, 40),
    recurring: ['none', 'matching', 'all'].includes(b.recurring) ? b.recurring : 'matching',
    skipPayouts: b.skip_payouts === '1'
  };
}
async function existingOf(req) {
  const { data } = await req.sb.from('revenue_entries').select('entry_date, amount, source')
    .eq('user_id', req.user.id).eq('entry_type', 'revenue').order('entry_date', { ascending: false }).limit(20000);
  return data || [];
}

router.get('/import', (req, res) => {
  res.render('budget_import', { title: 'Import payments', step: 'upload', msg: req.query.msg || null });
});

router.post('/import', takeCsv, async (req, res, next) => {
  try {
    const text = req.file ? textOf(req.file.buffer) : String((req.body && req.body.csv) || '');
    if (!text.trim()) return res.redirect('/budget/import?msg=' + encodeURIComponent('Choose a CSV file to import.'));
    if (text.length > CSV_MAX * 1.5) return res.redirect('/budget/import?msg=' + encodeURIComponent('That file is too large. Export a shorter date range and try again.'));
    const result = csv.plan(text, optsOf(req, await existingOf(req)));
    if (!result.rows.length) return res.redirect('/budget/import?msg=' + encodeURIComponent('No rows found in that file. Is it a CSV export?'));
    res.render('budget_import', { title: 'Import payments', step: 'preview', msg: null, csvText: text, result, labels: csv.SKIP_LABEL, $m: signed });
  } catch (e) { next(e); }
});

router.post('/import/save', takeCsv, async (req, res, next) => {
  try {
    const text = String((req.body && req.body.csv) || '');
    if (!text.trim()) return res.redirect('/budget/import');
    const result = csv.plan(text, optsOf(req, await existingOf(req)));
    const rows = result.rows.filter(r => !r.skip).map(r => ({
      user_id: req.user.id, entry_type: 'revenue', amount: r.amount, entry_date: r.date,
      source: r.source, description: r.description, is_recurring: r.recurring
    }));
    let saved = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await req.sb.from('revenue_entries').insert(rows.slice(i, i + 500));
      if (error) {
        const m = saved ? 'Imported ' + saved + ' payments, then something went wrong. Import the same file again to add the rest; the ones already in are skipped.' : 'Could not import that file. Please try again.';
        return res.redirect('/budget?msg=' + encodeURIComponent(m));
      }
      saved += Math.min(500, rows.length - i);
    }
    const skipped = result.counts.total - saved;
    const m = saved
      ? 'Imported ' + saved + ' payment' + (saved === 1 ? '' : 's') + ' (' + money(result.counts.total_amount) + ')' + (result.counts.recurring ? ', ' + result.counts.recurring + ' ticked Recurring' : '') + '.' + (skipped ? ' ' + skipped + ' row' + (skipped === 1 ? ' was' : 's were') + ' skipped.' : '')
      : 'Nothing new to import from that file.';
    res.redirect('/budget?msg=' + encodeURIComponent(m) + '#income');
  } catch (e) { next(e); }
});

// ---------------------------------------------------------- Stripe connection
// A read-only restricted key, stored in Supabase Vault (never readable back),
// synced by src/stripe_sync.js every few hours and on "Sync now".
const stripe = require('../stripe_sync');
const { serviceClient } = require('../supabase');
const service = () => { try { return serviceClient(); } catch (_) { return null; } };
const back = (m, path = '/budget/connect/stripe') => path + '?msg=' + encodeURIComponent(m);

async function myConnection(req) {
  const { data, error } = await req.sb.from('payment_connections')
    .select('id, provider, key_hint, status, last_error, last_synced_at, synced_through, imported_count, created_at')
    .eq('user_id', req.user.id).eq('provider', 'stripe').maybeSingle();
  return { conn: data || null, ready: !error };
}
const syncedMsg = r => (r.error ? r.error
  : r.imported ? 'Synced: ' + r.imported + ' new payment' + (r.imported === 1 ? '' : 's') + ' from Stripe' + (r.skipped ? ' (' + r.skipped + ' already in your log)' : '') + '.'
  : 'Synced. Nothing new from Stripe' + (r.skipped ? ' (' + r.skipped + ' already in your log)' : '') + '.');

router.get('/connect/stripe', async (req, res, next) => {
  try {
    const { conn, ready } = await myConnection(req);
    res.render('budget_stripe', { title: 'Connect Stripe', conn, ready, canSync: !!service(), msg: req.query.msg || null, everyHours: stripe.EVERY_HOURS });
  } catch (e) { next(e); }
});

router.post('/connect/stripe', async (req, res, next) => {
  try {
    const checked = stripe.checkKey(req.body.key);
    if (checked.error) return res.redirect(back(checked.error));
    const ok = await stripe.verify(checked.key);
    if (!ok.ok) return res.redirect(back(ok.error));
    const { data: id, error } = await req.sb.rpc('payment_connect_stripe', { p_key: checked.key });
    if (error || !id) return res.redirect(back('Could not save the connection. Please try again.'));
    // First sync now, so the member sees their payments straight away.
    const sc = service();
    if (!sc) return res.redirect(back('Connected. Your payments will appear after the next sync.'));
    const { conn } = await myConnection(req);
    const r = await stripe.syncConnection(sc, Object.assign({}, conn, { user_id: req.user.id }));
    res.redirect(back(r.error ? 'Connected, but the first sync failed: ' + r.error : 'Connected. ' + syncedMsg(r)));
  } catch (e) { next(e); }
});

router.post('/connect/stripe/sync', async (req, res, next) => {
  try {
    const { conn } = await myConnection(req);
    if (!conn) return res.redirect('/budget/connect/stripe');
    const sc = service();
    if (!sc) return res.redirect(back('Syncing is not switched on right now. Try again later.'));
    if (conn.last_synced_at && Date.now() - new Date(conn.last_synced_at).getTime() < 60000) return res.redirect(back('Synced less than a minute ago.'));
    const r = await stripe.syncConnection(sc, Object.assign({}, conn, { user_id: req.user.id }));
    res.redirect(back(syncedMsg(r)));
  } catch (e) { next(e); }
});

router.post('/connect/stripe/disconnect', async (req, res, next) => {
  try {
    await req.sb.rpc('payment_disconnect', { p_provider: 'stripe' });
    res.redirect(back('Disconnected. The key is deleted from NoBossly; the payments already logged stay in your income log. You can also delete the key in Stripe.'));
  } catch (e) { next(e); }
});

// Shopify, Gumroad, Square and banks (src/routes/connect.js).
router.use(require('./connect'));

module.exports = router;
