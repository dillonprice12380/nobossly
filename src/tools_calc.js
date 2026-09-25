// The arithmetic behind the Premium tools, kept free of Express and the
// database so every number a member sees can be checked in isolation.
// Money is handled in plain dollars (floats, rounded for display) — these are
// planning estimates, not accounting.

const num = (v, { min = 0, max = 1e9, def = 0 } = {}) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, ''));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const round2 = n => Math.round(n * 100) / 100;

function addMonths(ym, i) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + i, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthLabel = ym => {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// ---------- Quit-Date Planner ----------
//
// While employed, the job covers living costs, so the member saves their usual
// monthly amount plus whatever the side business nets after tax. Once they
// quit, savings pay for any gap between what the business nets and what life
// costs (living costs plus the benefits the job used to pay for).
//
//   Safe date: the business alone covers life AND savings hold the buffer.
//   Leap date: quitting that month, savings never fall below three months of
//              costs over the next five years while the business keeps growing.
const HORIZON = 120;

function quitInputs(src = {}) {
  return {
    living:    num(src.living,    { max: 1e6 }),
    benefits:  num(src.benefits,  { max: 1e5 }),
    savings:   num(src.savings,   { max: 1e8 }),
    save_rate: num(src.save_rate, { max: 1e6 }),
    side:      num(src.side,      { max: 1e7 }),
    growth:    num(src.growth,    { max: 50, def: 0 }),
    tax:       num(src.tax,       { max: 60, def: 25 }),
    buffer:    num(src.buffer,    { max: 36, def: 6 }),
    start:     /^\d{4}-\d{2}$/.test(src.start || '') ? src.start : thisMonth()
  };
}

function quitPlan(inp) {
  const need = inp.living + inp.benefits;
  const g = inp.growth / 100, keep = 1 - inp.tax / 100;
  const netAt = i => inp.side * Math.pow(1 + g, i) * keep;

  // Savings at the start of each month while still employed.
  const saved = [inp.savings];
  for (let i = 1; i <= HORIZON; i++) saved[i] = saved[i - 1] + inp.save_rate + netAt(i - 1);

  let safe = null, leap = null;
  for (let i = 0; i <= HORIZON && (safe === null || leap === null); i++) {
    if (need <= 0) { safe = leap = 0; break; }
    if (safe === null && netAt(i) >= need && saved[i] >= inp.buffer * need) safe = i;
    if (leap === null) {
      let s = saved[i], ok = true;
      for (let j = i; j < i + 60; j++) { s += netAt(j) - need; if (s < 3 * need) { ok = false; break; } }
      if (ok) leap = i;
    }
  }

  // A few points for the chart: side income after tax against what life costs.
  const points = [];
  for (let i = 0; i <= Math.min(HORIZON, Math.max(12, (safe || 0) + 6)); i += Math.max(1, Math.round(((safe || 36) + 6) / 18))) {
    points.push({ month: addMonths(inp.start, i), net: round2(netAt(i)), need: round2(need), saved: round2(saved[i]) });
  }

  const at = i => (i === null ? null : { index: i, month: addMonths(inp.start, i), label: monthLabel(addMonths(inp.start, i)) });
  return {
    need: round2(need),
    netNow: round2(netAt(0)),
    coverPct: need > 0 ? Math.min(100, Math.round(100 * netAt(0) / need)) : 100,
    // Side income (before tax) the business has to reach to cover life on its own.
    sideNeeded: keep > 0 ? round2(need / keep) : null,
    bufferTarget: round2(inp.buffer * need),
    safe: at(safe),
    leap: at(leap),
    points
  };
}

// ---------- Tax Set-Aside ----------
//
// A planning estimate for US side income: self-employment tax on 92.35% of
// profit, plus the member's federal bracket and state rate. Quarters follow the
// IRS estimated-tax calendar, which is uneven on purpose.
const SE_RATE = 0.153 * 0.9235;
const FED_BRACKETS = [10, 12, 22, 24, 32, 35, 37];
const QUARTERS = [
  { q: 1, from: '01-01', to: '03-31', due: y => y + '-04-15' },
  { q: 2, from: '04-01', to: '05-31', due: y => y + '-06-15' },
  { q: 3, from: '06-01', to: '08-31', due: y => y + '-09-15' },
  { q: 4, from: '09-01', to: '12-31', due: y => (y + 1) + '-01-15' }
];

function taxRate(settings = {}) {
  const fed = FED_BRACKETS.includes(Number(settings.fed)) ? Number(settings.fed) : 12;
  const state = num(settings.state, { max: 15, def: 0 });
  return round2(SE_RATE * 100 + fed + state);
}

function quarterOf(date) {
  const md = String(date || '').slice(5, 10);
  return (QUARTERS.find(q => md >= q.from && md <= q.to) || QUARTERS[0]).q;
}

function taxSummary(data = {}, year) {
  const s = data.settings || {};
  const rate = taxRate(s) / 100;
  const mileRate = num(s.mile_rate, { max: 5, def: 0.70 });
  const inYear = e => String(e.date || '').slice(0, 4) === String(year);
  const income = (data.income || []).filter(inYear);
  const deductions = (data.deductions || []).filter(inYear);
  const miles = (data.miles || []).filter(inYear);
  const paid = (data.payments || []).filter(p => String(p.tax_year || String(p.date || '').slice(0, 4)) === String(year));

  const today = new Date().toISOString().slice(0, 10);
  const quarters = QUARTERS.map(q => {
    const inQ = e => quarterOf(e.date) === q.q;
    const inc = income.filter(inQ).reduce((a, e) => a + num(e.amount), 0);
    const ded = deductions.filter(inQ).reduce((a, e) => a + num(e.amount), 0)
      + miles.filter(inQ).reduce((a, e) => a + num(e.miles) * mileRate, 0);
    const owed = Math.max(0, inc - ded) * rate;
    const pay = paid.filter(p => Number(p.quarter) === q.q).reduce((a, p) => a + num(p.amount), 0);
    const due = q.due(Number(year));
    return { q: q.q, due, income: round2(inc), deductions: round2(ded), owed: round2(owed), paid: round2(pay), left: round2(Math.max(0, owed - pay)), past: due < today };
  });
  const next = quarters.find(q => !q.past) || null;
  const tot = k => round2(quarters.reduce((a, q) => a + q[k], 0));
  return {
    rate: round2(rate * 100), mileRate, quarters, next,
    income: tot('income'), deductions: tot('deductions'), owed: tot('owed'), paid: tot('paid'),
    left: round2(Math.max(0, tot('owed') - tot('paid'))),
    setAsideFor: amount => round2(num(amount) * rate)
  };
}

// ---------- Pricing & Margin ----------
function serviceRate(src = {}) {
  const inp = {
    income:   num(src.income,   { max: 1e8 }),
    expenses: num(src.expenses, { max: 1e7 }),
    tax:      num(src.tax,      { max: 60, def: 25 }),
    hours:    num(src.hours,    { min: 1, max: 80, def: 20 }),
    weeks:    num(src.weeks,    { min: 1, max: 52, def: 46 }),
    project_hours: num(src.project_hours, { max: 10000, def: 10 })
  };
  const keep = 1 - inp.tax / 100;
  const revenue = (keep > 0 ? inp.income / keep : inp.income) + inp.expenses * 12;
  const hourly = revenue / (inp.hours * inp.weeks);
  return {
    inputs: inp,
    revenue: round2(revenue),
    monthly: round2(revenue / 12),
    hourly: round2(hourly),
    day: round2(hourly * 8),
    project: round2(hourly * inp.project_hours)
  };
}

function productMargin(src = {}) {
  const inp = {
    price:     num(src.price,     { max: 1e6 }),
    unit_cost: num(src.unit_cost, { max: 1e6 }),
    shipping:  num(src.shipping,  { max: 1e5 }),
    packaging: num(src.packaging, { max: 1e5 }),
    platform_pct: num(src.platform_pct, { max: 60 }),
    payment_pct:  num(src.payment_pct,  { max: 20, def: 2.9 }),
    payment_fixed: num(src.payment_fixed, { max: 10, def: 0.30 }),
    ad_cost:   num(src.ad_cost,   { max: 1e5 }),
    target:    num(src.target,    { max: 1e8 })
  };
  const fees = inp.price * (inp.platform_pct + inp.payment_pct) / 100 + inp.payment_fixed;
  const cost = inp.unit_cost + inp.shipping + inp.packaging + inp.ad_cost + fees;
  const profit = inp.price - cost;
  // The price at which this product would make a 30% margin after everything.
  const pctOut = (inp.platform_pct + inp.payment_pct) / 100;
  const fixed = inp.unit_cost + inp.shipping + inp.packaging + inp.ad_cost + inp.payment_fixed;
  const priceFor30 = (1 - pctOut - 0.30) > 0 ? fixed / (1 - pctOut - 0.30) : null;
  return {
    inputs: inp,
    fees: round2(fees),
    cost: round2(cost),
    profit: round2(profit),
    margin: inp.price > 0 ? round2(100 * profit / inp.price) : 0,
    unitsForTarget: profit > 0 && inp.target > 0 ? Math.ceil(inp.target / profit) : null,
    priceFor30: priceFor30 ? round2(priceFor30) : null
  };
}

// ---------- Customer Interview Tracker ----------
function tagList(s) {
  return [...new Set(String(s || '').split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean).map(t => t.slice(0, 40)))].slice(0, 12);
}

function interviewSummary(list = []) {
  const n = list.length;
  const pay = { yes: 0, maybe: 0, no: 0 };
  const tags = {};
  list.forEach(iv => {
    if (pay[iv.pay] != null) pay[iv.pay]++;
    (iv.tags || []).forEach(t => {
      tags[t] = tags[t] || { tag: t, count: 0, yes: 0 };
      tags[t].count++;
      if (iv.pay === 'yes') tags[t].yes++;
    });
  });
  const ranked = Object.values(tags)
    .map(t => ({ ...t, pct: n ? Math.round(100 * t.count / n) : 0 }))
    .sort((a, b) => b.count - a.count || b.yes - a.yes);
  return { n, pay, payPct: n ? Math.round(100 * pay.yes / n) : 0, tags: ranked };
}

module.exports = {
  num, round2, addMonths, thisMonth, monthLabel,
  quitInputs, quitPlan,
  FED_BRACKETS, QUARTERS, taxRate, quarterOf, taxSummary,
  serviceRate, productMargin,
  tagList, interviewSummary
};
