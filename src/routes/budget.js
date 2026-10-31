const router = require('express').Router();
const { planOf } = require('../middleware/auth');
const starter = require('../starter_budget');
const income = require('../income');
const calc = require('../tools_calc');
const premium = require('../premium');

const isPaid = req => planOf(req.profile) === 'paid';

// Load the budget view payload.
async function loadBudget(req, extra = {}) {
  const monthStart = new Date(); monthStart.setDate(1);
  const ms = monthStart.toISOString().slice(0, 10);
  // The launch budget the member declared when they picked their path. This
  // tab is about money and it should not ignore the one money number they
  // already gave us — see src/starter_budget.js.
  const [{ data: budgets }, { data: expenses }, { data: q }] = await Promise.all([
    req.sb.from('budgets').select('*').eq('user_id', req.user.id).order('category'),
    req.sb.from('expenses').select('*').eq('user_id', req.user.id).gte('spent_at', ms).order('spent_at', { ascending: false }).limit(200),
    req.sb.from('questionnaire_responses').select('launch_budget').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
  ]);
  const spentByCat = {};
  let totalSpent = 0;
  (expenses || []).forEach(e => { const amt = Number(e.amount) || 0; spentByCat[e.category] = (spentByCat[e.category] || 0) + amt; totalSpent += amt; });
  const totalBudget = (budgets || []).reduce((s, b) => s + (Number(b.monthly_limit) || 0), 0);
  const cats = [...new Set([...(budgets || []).map(b => b.category), ...Object.keys(spentByCat)])];
  const launchBudget = (q && q.launch_budget) || null;
  const [log, done, rate] = await Promise.all([income.load(req), income.doneTitles(req), setAsideRate(req)]);
  const sum = income.summary(log.income, log.expenses);
  return Object.assign({
    title: 'Income, Budget & Expenses', budgets: budgets || [], expenses: expenses || [],
    incomeLog: log.income.slice(0, 25), incomeSum: sum, setAsideRate: rate,
    claims: income.claimPrompts(req.profile.path, sum, done),
    spentByCat, totalSpent, totalBudget, cats,
    monthLabel: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    paid: isPaid(req), msg: req.query.msg || null, insights: null,
    launchBudget,
    launchBudgetUsd: starter.dollarsFor(launchBudget),
    // Offered only while there is nothing to overwrite. Seeding on top of
    // categories someone has already set would be the app editing their budget.
    suggestion: (budgets || []).length ? [] : starter.suggest(launchBudget, req.profile.path),
    starterMonths: starter.MONTHS,
    budgetCategories: require('../budget_categories').STANDARD
  }, extra);
}

// The share of each payment to put aside for tax: the member's own rates if they
// set them in Tax Set-Aside, otherwise self-employment tax plus the 12% bracket.
async function setAsideRate(req) {
  const tax = await premium.load(req, 'tax');
  return calc.taxRate(tax.settings || {});
}

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
    const { data: q } = await req.sb.from('questionnaire_responses')
      .select('launch_budget').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
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
    if (category && amount > 0) {
      await req.sb.from('expenses').insert({
        user_id: req.user.id, category, amount,
        note: (req.body.note || '').slice(0, 200) || null,
        spent_at: req.body.spent_at || new Date().toISOString().slice(0, 10)
      });
    }
    res.redirect('/budget');
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
    const { error } = await req.sb.from('revenue_entries').insert({
      user_id: req.user.id, entry_type: 'revenue', amount, entry_date: date,
      source: String(req.body.source || '').trim().slice(0, 80) || null,
      description: String(req.body.note || '').trim().slice(0, 200) || null
    });
    if (error) return res.redirect(to + '?msg=' + encodeURIComponent('Could not save that payment. Please try again.'));

    // Say what to put aside, and whether that payment just reached a money
    // rung the member has not recorded yet.
    const [log, done, rate] = await Promise.all([income.load(req), income.doneTitles(req), setAsideRate(req)]);
    const claims = income.claimPrompts(req.profile.path, income.summary(log.income, log.expenses), done);
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

module.exports = router;
