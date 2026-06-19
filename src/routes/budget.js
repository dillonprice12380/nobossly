const router = require('express').Router();
const ai = require('../ai');
const { planOf } = require('../middleware/auth');

const isPaid = req => planOf(req.profile) === 'paid';

// Load the budget view payload (shared by GET and the AI-insights render).
async function loadBudget(req, extra = {}) {
  const monthStart = new Date(); monthStart.setDate(1);
  const ms = monthStart.toISOString().slice(0, 10);
  const [{ data: budgets }, { data: expenses }] = await Promise.all([
    req.sb.from('budgets').select('*').eq('user_id', req.user.id).order('category'),
    req.sb.from('expenses').select('*').eq('user_id', req.user.id).gte('spent_at', ms).order('spent_at', { ascending: false }).limit(200)
  ]);
  const spentByCat = {};
  let totalSpent = 0;
  (expenses || []).forEach(e => { const amt = Number(e.amount) || 0; spentByCat[e.category] = (spentByCat[e.category] || 0) + amt; totalSpent += amt; });
  const totalBudget = (budgets || []).reduce((s, b) => s + (Number(b.monthly_limit) || 0), 0);
  const cats = [...new Set([...(budgets || []).map(b => b.category), ...Object.keys(spentByCat)])];
  return Object.assign({
    title: 'Budget & Expenses', budgets: budgets || [], expenses: expenses || [],
    spentByCat, totalSpent, totalBudget, cats,
    monthLabel: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    paid: isPaid(req), msg: req.query.msg || null, insights: null
  }, extra);
}

router.get('/', async (req, res, next) => {
  try {
    res.render('budget', await loadBudget(req));
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

// ---------- AI budget (paid) ----------
// Suggest a lean startup budget tailored to the founder's active blueprint.
router.post('/ai/suggest', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const { data: bp } = await req.sb.from('blueprints').select('*').eq('user_id', req.user.id).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bp) return res.redirect('/budget?msg=' + encodeURIComponent('Create a launch blueprint first, then I can tailor a startup budget to it.'));
    let items;
    try { items = await ai.generateBudget(req.accessToken, bp); }
    catch (err) { return res.redirect('/budget?msg=' + encodeURIComponent('Could not generate a budget: ' + err.message)); }
    if (!Array.isArray(items) || !items.length) return res.redirect('/budget?msg=' + encodeURIComponent('No budget was generated — please try again.'));
    for (const it of items.slice(0, 12)) {
      const category = String(it.category || '').trim().slice(0, 40);
      const limit = Math.max(0, Math.round(Number(it.monthly_limit) || 0));
      if (category) await req.sb.from('budgets').upsert({ user_id: req.user.id, category, monthly_limit: limit }, { onConflict: 'user_id,category' });
    }
    res.redirect('/budget?msg=' + encodeURIComponent('Added an AI-tailored starter budget — adjust any limits to fit you.'));
  } catch (e) { next(e); }
});

// AI read on current spending vs. budget (paid). Rendered inline, no redirect.
router.post('/ai/insights', async (req, res, next) => {
  try {
    if (!isPaid(req)) return res.redirect('/pricing?upgrade=1');
    const payload = await loadBudget(req);
    const summary = {
      month: payload.monthLabel,
      totalBudget: payload.totalBudget,
      totalSpent: payload.totalSpent,
      categories: payload.cats.map(c => ({
        category: c,
        limit: (payload.budgets.find(b => b.category === c) || {}).monthly_limit || 0,
        spent: Math.round((payload.spentByCat[c] || 0) * 100) / 100
      }))
    };
    let insights = null;
    try { insights = await ai.budgetInsights(req.accessToken, summary); }
    catch (err) { payload.msg = 'Could not generate insights: ' + err.message; }
    res.render('budget', Object.assign(payload, { insights }));
  } catch (e) { next(e); }
});

module.exports = router;
