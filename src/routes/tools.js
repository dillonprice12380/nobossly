const router = require('express').Router();
const crypto = require('crypto');
const premium = require('../premium');
const calc = require('../tools_calc');
const { anonClient } = require('../supabase');
const paths = require('../paths');

const id = () => crypto.randomBytes(6).toString('hex');
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const today = () => new Date().toISOString().slice(0, 10);
const back = (res, to, m) => res.redirect(to + (m ? (to.includes('?') ? '&' : '?') + 'm=' + encodeURIComponent(m) : ''));

// Hub: every member sees the five tools; without Premium each links to its
// sales page instead of the tool.
router.get('/', (req, res) => {
  res.render('tools/index', { title: 'Premium tools', welcome: !!req.query.welcome });
});

// ---------------------------------------------------------------- Quit date
router.get('/quit-date', premium.requirePremium('quit'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'quit');
    const inputs = calc.quitInputs(data.inputs || {});
    res.render('tools/quit', {
      title: 'Quit-Date Planner', data, inputs,
      hasPlan: !!data.inputs, plan: data.inputs ? calc.quitPlan(inputs) : null,
      checkins: (data.checkins || []).slice().sort((a, b) => b.month.localeCompare(a.month)),
      monthLabel: calc.monthLabel, m: req.query.m || null
    });
  } catch (e) { next(e); }
});

router.post('/quit-date', premium.requirePremium('quit'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'quit');
    data.inputs = calc.quitInputs(req.body);
    await premium.save(req, 'quit', data);
    back(res, '/tools/quit-date', 'Plan saved.');
  } catch (e) { next(e); }
});

// A monthly check-in updates the plan's starting point to what actually
// happened, and records the dates the plan gave at that moment, so the member
// can watch them move.
router.post('/quit-date/checkin', premium.requirePremium('quit'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'quit');
    if (!data.inputs) return back(res, '/tools/quit-date', 'Set up your plan first.');
    const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : calc.thisMonth();
    const inputs = calc.quitInputs(Object.assign({}, data.inputs, {
      side: req.body.side, savings: req.body.savings, start: month
    }));
    const plan = calc.quitPlan(inputs);
    data.inputs = inputs;
    data.checkins = (data.checkins || []).filter(c => c.month !== month);
    data.checkins.push({
      month, side: inputs.side, savings: inputs.savings, note: str(req.body.note, 300),
      safe: plan.safe && plan.safe.month, leap: plan.leap && plan.leap.month
    });
    data.checkins = data.checkins.sort((a, b) => a.month.localeCompare(b.month)).slice(-120);
    await premium.save(req, 'quit', data);
    back(res, '/tools/quit-date', 'Check-in saved for ' + calc.monthLabel(month) + '.');
  } catch (e) { next(e); }
});

router.post('/quit-date/checkin/:month/delete', premium.requirePremium('quit'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'quit');
    data.checkins = (data.checkins || []).filter(c => c.month !== req.params.month);
    await premium.save(req, 'quit', data);
    back(res, '/tools/quit-date');
  } catch (e) { next(e); }
});

// --------------------------------------------------------------------- Tax
const TAX_LISTS = {
  income:     b => ({ date: b.date, amount: calc.num(b.amount, { max: 1e8 }), source: str(b.source, 80) }),
  deductions: b => ({ date: b.date, amount: calc.num(b.amount, { max: 1e8 }), category: str(b.category, 60), note: str(b.note, 200) }),
  miles:      b => ({ date: b.date, miles: calc.num(b.miles, { max: 1e5 }), purpose: str(b.purpose, 120) }),
  payments:   b => ({ date: b.date, amount: calc.num(b.amount, { max: 1e8 }), quarter: Math.min(4, Math.max(1, parseInt(b.quarter, 10) || 1)), tax_year: String(parseInt(b.tax_year, 10) || new Date().getFullYear()) })
};
const MAX_ENTRIES = 1000;

router.get('/tax', premium.requirePremium('tax'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'tax');
    const thisYear = new Date().getFullYear();
    const year = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : thisYear;
    const sum = calc.taxSummary(data, year);
    const inYear = list => (list || []).filter(e => String(e.date || '').startsWith(String(year))).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.render('tools/tax', {
      title: 'Tax Set-Aside', data, year, thisYear, sum, settings: data.settings || {},
      income: inYear(data.income), deductions: inYear(data.deductions), miles: inYear(data.miles),
      payments: (data.payments || []).filter(p => String(p.tax_year) === String(year)).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      brackets: calc.FED_BRACKETS, today: today(), m: req.query.m || null
    });
  } catch (e) { next(e); }
});

router.post('/tax/settings', premium.requirePremium('tax'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'tax');
    data.settings = {
      fed: calc.FED_BRACKETS.includes(Number(req.body.fed)) ? Number(req.body.fed) : 12,
      state: calc.num(req.body.state, { max: 15 }),
      mile_rate: calc.num(req.body.mile_rate, { max: 5, def: 0.70 })
    };
    await premium.save(req, 'tax', data);
    back(res, '/tools/tax', 'Rates saved.');
  } catch (e) { next(e); }
});

router.post('/tax/:list', premium.requirePremium('tax'), async (req, res, next) => {
  try {
    const make = TAX_LISTS[req.params.list];
    if (!make) return res.redirect('/tools/tax');
    if (!isDate(req.body.date)) return back(res, '/tools/tax', 'Pick a date.');
    const entry = Object.assign({ id: id() }, make(req.body));
    const data = await premium.load(req, 'tax');
    data[req.params.list] = (data[req.params.list] || []).concat(entry).slice(-MAX_ENTRIES);
    await premium.save(req, 'tax', data);
    const year = req.params.list === 'payments' ? entry.tax_year : entry.date.slice(0, 4);
    let m = 'Saved.';
    if (req.params.list === 'income') {
      m = 'Saved. Put aside $' + calc.taxSummary(data, year).setAsideFor(entry.amount).toFixed(2) + ' of that for tax.';
    }
    back(res, '/tools/tax?year=' + year, m);
  } catch (e) { next(e); }
});

router.post('/tax/:list/:id/delete', premium.requirePremium('tax'), async (req, res, next) => {
  try {
    if (!TAX_LISTS[req.params.list]) return res.redirect('/tools/tax');
    const data = await premium.load(req, 'tax');
    data[req.params.list] = (data[req.params.list] || []).filter(e => e.id !== req.params.id);
    await premium.save(req, 'tax', data);
    back(res, '/tools/tax' + (req.query.year ? '?year=' + encodeURIComponent(req.query.year) : ''));
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------- Pricing
router.get('/pricing', premium.requirePremium('pricing'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'pricing');
    const mode = req.query.mode === 'product' ? 'product' : 'service';
    res.render('tools/pricing', {
      title: 'Pricing & Margin Calculator', mode,
      service: calc.serviceRate(data.last_service || {}), product: calc.productMargin(data.last_product || {}),
      hasService: !!data.last_service, hasProduct: !!data.last_product,
      scenarios: (data.scenarios || []).slice().reverse(), m: req.query.m || null
    });
  } catch (e) { next(e); }
});

router.post('/pricing/:mode', premium.requirePremium('pricing'), async (req, res, next) => {
  try {
    const mode = req.params.mode === 'product' ? 'product' : 'service';
    const result = mode === 'product' ? calc.productMargin(req.body) : calc.serviceRate(req.body);
    const data = await premium.load(req, 'pricing');
    data['last_' + mode] = result.inputs;
    let m = null;
    if (req.body.save_as && str(req.body.save_as, 60)) {
      data.scenarios = (data.scenarios || []).concat({
        id: id(), mode, name: str(req.body.save_as, 60), inputs: result.inputs, saved_at: today()
      }).slice(-50);
      m = 'Scenario saved.';
    }
    await premium.save(req, 'pricing', data);
    back(res, '/tools/pricing?mode=' + mode, m);
  } catch (e) { next(e); }
});

router.post('/pricing/scenario/:id/load', premium.requirePremium('pricing'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'pricing');
    const sc = (data.scenarios || []).find(s => s.id === req.params.id);
    if (!sc) return res.redirect('/tools/pricing');
    data['last_' + sc.mode] = sc.inputs;
    await premium.save(req, 'pricing', data);
    back(res, '/tools/pricing?mode=' + sc.mode, 'Loaded “' + sc.name + '”.');
  } catch (e) { next(e); }
});

router.post('/pricing/scenario/:id/delete', premium.requirePremium('pricing'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'pricing');
    data.scenarios = (data.scenarios || []).filter(s => s.id !== req.params.id);
    await premium.save(req, 'pricing', data);
    back(res, '/tools/pricing');
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- Proof
const safeUrl = v => {
  const s = str(v, 300);
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? 'mailto:' + s : '');
};

router.get('/proof', premium.requirePremium('proof'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'proof');
    res.render('tools/proof', {
      title: 'Proof Page', page: data, username: req.profile.username,
      publicUrl: 'https://nobossly.com/proof/' + req.profile.username, m: req.query.m || null
    });
  } catch (e) { next(e); }
});

router.post('/proof', premium.requirePremium('proof'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'proof');
    Object.assign(data, {
      published: req.body.published === 'on',
      headline: str(req.body.headline, 120),
      about: str(req.body.about, 1500),
      services: String(req.body.services || '').split('\n').map(s => s.trim().slice(0, 120)).filter(Boolean).slice(0, 12),
      contact_url: safeUrl(req.body.contact_url),
      contact_label: str(req.body.contact_label, 40),
      show_wins: req.body.show_wins === 'on',
      show_level: req.body.show_level === 'on'
    });
    await premium.save(req, 'proof', data);
    back(res, '/tools/proof', data.published ? 'Saved — your page is live.' : 'Saved. Your page is not published yet.');
  } catch (e) { next(e); }
});

router.post('/proof/testimonial', premium.requirePremium('proof'), async (req, res, next) => {
  try {
    const quote = str(req.body.quote, 800);
    if (quote.length < 5) return back(res, '/tools/proof', 'Add the testimonial text.');
    const data = await premium.load(req, 'proof');
    data.testimonials = (data.testimonials || []).concat({
      id: id(), quote, name: str(req.body.name, 80), context: str(req.body.context, 120)
    }).slice(-30);
    await premium.save(req, 'proof', data);
    back(res, '/tools/proof', 'Testimonial added.');
  } catch (e) { next(e); }
});

router.post('/proof/testimonial/:id/delete', premium.requirePremium('proof'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'proof');
    data.testimonials = (data.testimonials || []).filter(t => t.id !== req.params.id);
    await premium.save(req, 'proof', data);
    back(res, '/tools/proof');
  } catch (e) { next(e); }
});

// Public page, mounted at /proof/:username in server.js. proof_page() returns
// nothing unless the owner has Premium and has published it.
async function publicProof(req, res, next) {
  try {
    const { data: p, error } = await (req.sb || anonClient()).rpc('proof_page', { p_username: str(req.params.username, 60) });
    if (error) console.error('[db] proof_page failed:', error.message);
    if (!p) return res.status(404).render('error', { title: 'Not found', message: 'This page is not available.' });
    const def = p.path ? paths.get(p.path) : null;
    res.render('proof_public', {
      title: (p.display_name || p.username) + (p.page.headline ? ' — ' + p.page.headline : ''),
      metaDescription: String(p.page.about || p.page.headline || '').slice(0, 280),
      p, pathLabel: def ? def.label : null
    });
  } catch (e) { next(e); }
}

// -------------------------------------------------------------- Interviews
router.get('/interviews', premium.requirePremium('interviews'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'interviews');
    const list = (data.list || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const tag = str(req.query.tag, 40).toLowerCase();
    res.render('tools/interviews', {
      title: 'Customer Interview Tracker', sum: calc.interviewSummary(list),
      list: tag ? list.filter(iv => (iv.tags || []).includes(tag)) : list,
      tag, today: today(), m: req.query.m || null
    });
  } catch (e) { next(e); }
});

router.post('/interviews', premium.requirePremium('interviews'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'interviews');
    data.list = (data.list || []).concat({
      id: id(),
      date: isDate(req.body.date) ? req.body.date : today(),
      who: str(req.body.who, 120),
      channel: str(req.body.channel, 60),
      tags: calc.tagList(req.body.tags),
      pay: ['yes', 'maybe', 'no'].includes(req.body.pay) ? req.body.pay : 'maybe',
      quote: str(req.body.quote, 600),
      notes: str(req.body.notes, 1500)
    }).slice(-500);
    await premium.save(req, 'interviews', data);
    back(res, '/tools/interviews', 'Interview logged.');
  } catch (e) { next(e); }
});

router.post('/interviews/:id/delete', premium.requirePremium('interviews'), async (req, res, next) => {
  try {
    const data = await premium.load(req, 'interviews');
    data.list = (data.list || []).filter(iv => iv.id !== req.params.id);
    await premium.save(req, 'interviews', data);
    back(res, '/tools/interviews');
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.publicProof = publicProof;
