// Building a founder's fit test from a curated library, not from scratch.
//
// The five criteria used to be invented by the model on every Compass draw:
// two founders with identical answers could get different tests, and nobody
// ever reviewed the wording. This matches the founder's answers against a
// library of criteria written and typed by hand (fit_criteria_library), binds
// their own numbers into the wording, and only asks the model for whatever gap
// is left over.
//
// The payoff is not just consistency. A library criterion arrives already
// carrying its check/metric/op, so it can be graded by arithmetic in fit.js
// rather than by opinion — which is the difference between a score that holds
// still between runs and one that drifts.

// ---------- founder facts ----------
//
// The questionnaire stores buckets ("$500-2,000", "10-20"), so the numbers have
// to be derived before anything can be matched or compared against them.

// The TOP of a bucket, deliberately. A founder who picked "$500-2,000" has up
// to $2,000, and a criterion reading "does it start for under $2,000?" is the
// honest ceiling to hold an idea to. Taking the bottom would invent a
// constraint they never stated.
const BUDGET_USD = {
  '$0': 0,
  'under $500': 500,
  '$500-2,000': 2000,
  '$2,000-10,000': 10000,
  '$10,000+': 25000
};

const HOURS_MAX = { '<5': 5, '5-10': 10, '10-20': 20, '20-40': 40, '40+': 40 };

const RUNWAY_WEEKS = {
  'none — need income now': 0,
  'none - need income now': 0,
  '1-3 months': 13,
  '3-6 months': 26,
  '6-12 months': 52,
  '12+ months': 78
};

const INCOME_GOAL = {
  'side income ($500+/mo)': 'side',
  'replace part of salary': 'part_salary',
  'replace full salary': 'full_salary',
  'build something big': 'big'
};

const pathsLib = require('./paths');

const norm = v => String(v == null ? '' : v).trim().toLowerCase();
const arr = v => (Array.isArray(v) ? v : []).map(norm).filter(Boolean);

// A founder with no runway needs money before the runway they do not have runs
// out. Eight weeks is the working assumption — short enough to rule out ideas
// that pay nothing for a year, long enough to be reachable.
const NO_RUNWAY_DEADLINE_WEEKS = 8;

function founderFacts(q) {
  const Q = q || {};
  const budget = BUDGET_USD[norm(Q.launch_budget)];
  const hours = HOURS_MAX[norm(Q.hours_per_week)];
  const runwayWeeks = RUNWAY_WEEKS[norm(Q.runway)];
  const dealBreakers = arr(Q.deal_breakers);
  const dbText = dealBreakers.join(' ');

  return {
    // The declared business path, and how far along they are with it. These
    // used to be one field: founder_path held the stage. They are separate
    // axes now, and criteria match on either.
    path: norm(Q.founder_path) || 'exploring',
    founder_path: norm(Q.founder_path) || 'exploring',
    stage: pathsLib.stageOf(Q),
    is_running: ['running', 'earning'].includes(pathsLib.stageOf(Q)),
    not_started: pathsLib.stageOf(Q) === 'idea',
    work_status: norm(Q.work_status),
    risk_tolerance: norm(Q.risk_tolerance),
    income_goal: INCOME_GOAL[norm(Q.income_year1)] || null,
    biz_models: arr(Q.biz_models),
    deal_breakers: dealBreakers,

    launch_budget_usd: budget == null ? null : budget,
    has_budget: budget != null,
    zero_budget: budget === 0,
    hours_per_week: hours == null ? null : hours,
    runway_weeks: runwayWeeks == null ? null : runwayWeeks,
    // What the fit test should hold "time to revenue" to.
    revenue_deadline_weeks: runwayWeeks === 0 ? NO_RUNWAY_DEADLINE_WEEKS : (runwayWeeks || null),
    no_runway: runwayWeeks === 0,

    // Deal breakers are free text, so these are substring reads rather than an
    // enum. A founder who wrote "no video content" and one who wrote "camera
    // work" are saying the same thing.
    avoids_camera: /camera|video|on-screen|filming|face/.test(dbText),
    avoids_cold_outreach: /cold call|cold outreach|cold email|phone|telesales/.test(dbText),
    avoids_inventory: /inventory|stock|shipping|warehouse|physical product/.test(dbText),

    has_credentials: !!norm(Q.credentials),
    has_customer_access: !!norm(Q.customer_access),
    has_unfair_advantage: !!norm(Q.unfair_advantage),
    has_industry: !!norm(Q.industry_field),
    tech_level: Number.isFinite(Q.tech_level) ? Q.tech_level : null,
    sales_comfort: Number.isFinite(Q.sales_comfort) ? Q.sales_comfort : null,
    marketing_comfort: Number.isFinite(Q.marketing_comfort) ? Q.marketing_comfort : null,
    employed: /employed|student|parent|caregiver/.test(norm(Q.work_status))
  };
}

// ---------- matching ----------
//
// Same condition shape as guidance_rules, plus `contains` for the array facts.
function matches(cond, facts) {
  if (!cond) return true;
  try {
    return Object.entries(cond).every(([k, v]) => {
      const f = facts[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.entries(v).every(([op, val]) => {
          if (op === 'gte') return typeof f === 'number' && f >= val;
          if (op === 'lte') return typeof f === 'number' && f <= val;
          if (op === 'gt') return typeof f === 'number' && f > val;
          if (op === 'lt') return typeof f === 'number' && f < val;
          if (op === 'ne') return f !== val;
          if (op === 'in') return Array.isArray(val) && val.includes(f);
          if (op === 'contains') return Array.isArray(f) && f.some(x => String(x).includes(String(val)));
          if (op === 'exists') return val ? (f != null && f !== '' && f !== false) : (f == null || f === '' || f === false);
          return false;
        });
      }
      return f === v;
    });
  } catch (_) { return false; }
}

// ---------- binding ----------
//
// Library wording carries placeholders so one row serves every budget tier:
// "Does it start for under {budget}?" becomes the founder's actual ceiling.
const money = n => '$' + Number(n).toLocaleString('en-US');

function bind(text, facts) {
  return String(text == null ? '' : text)
    .replace(/\{budget\}/g, facts.launch_budget_usd == null ? 'your budget' : money(facts.launch_budget_usd))
    .replace(/\{hours\}/g, facts.hours_per_week == null ? 'the hours you have' : facts.hours_per_week + ' hours')
    .replace(/\{weeks\}/g, facts.revenue_deadline_weeks == null ? 'your runway' : facts.revenue_deadline_weeks + ' weeks')
    .replace(/\{runway_weeks\}/g, facts.runway_weeks == null ? 'your runway' : facts.runway_weeks + ' weeks');
}

// Where a numeric criterion's threshold comes from. A library row says which
// founder number to read rather than hard-coding one, so the same row serves
// every founder.
const VALUE_FROM = {
  launch_budget_usd: f => f.launch_budget_usd,
  revenue_deadline_weeks: f => f.revenue_deadline_weeks,
  hours_per_week: f => f.hours_per_week
};

// Turns one library row into a pinned criterion, or null if it cannot be made
// concrete for this founder. A numeric row whose threshold is missing is
// DROPPED rather than downgraded to judgement: the library wrote it to be
// checked, and a criterion that silently stops being checkable is the failure
// this whole design exists to avoid.
function toCriterion(row, facts) {
  // The column is check_kind ("check" is reserved-ish in SQL and reads badly in
  // a constraint); the rest of the codebase says check.
  row = { ...row, check: row.check || row.check_kind };
  const criterion = bind(row.criterion, facts);
  if (!criterion) return null;
  const out = { criterion, why: bind(row.why, facts), check: 'judgment', metric: null, op: null, value: null, source: 'library', slug: row.slug };
  if (row.check === 'numeric') {
    const from = row.value_from ? VALUE_FROM[row.value_from] : null;
    const value = from ? from(facts) : row.value;
    if (!Number.isFinite(value)) return null;
    out.check = 'numeric'; out.metric = row.metric; out.op = row.op; out.value = value;
  } else if (row.check === 'boolean') {
    out.check = 'boolean';
  }
  return out;
}

const TARGET = 5;

// A fit test made entirely of constraints tests only whether an idea is
// survivable, never whether it is worth this founder doing. Constraints
// naturally carry the highest priorities — budget, runway, deal breakers are
// all urgent — so without a reserved slot the founder's own edge gets crowded
// out every time. One slot is held for it whenever the library has one to give.
const RESERVED_CATEGORIES = ['advantage'];

// Picks the founder's criteria from the library.
//
// At most one per category, so a founder does not end up with five different
// ways of asking about their budget. Highest priority first, then by slug so
// the same profile always produces the same test rather than depending on the
// order rows came back in.
const categoryOf = (rows, slug) => ((rows || []).find(r => r && r.slug === slug) || {}).category;

function selectFromLibrary(rows, facts, target = TARGET) {
  // A criterion tagged with paths applies only to those; an empty tag means it
  // applies everywhere. "Can it be delivered without a fixed premises?" is a
  // real question for a freelancer and a meaningless one for a shop.
  const onPath = r => !r.paths || !r.paths.length || r.paths.includes(facts.path);
  const eligible = (rows || [])
    .filter(r => r && r.is_active !== false && onPath(r) && matches(r.applies_when, facts))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.slug).localeCompare(String(b.slug)));

  const chosen = [];
  const usedCategory = new Set();
  for (const row of eligible) {
    if (chosen.length >= target) break;
    if (row.category && usedCategory.has(row.category)) continue;
    const c = toCriterion(row, facts);
    if (!c) continue;
    chosen.push(c);
    if (row.category) usedCategory.add(row.category);
  }

  // Hold a slot for the founder's edge. If the priority pass filled the test
  // with constraints alone, trade the weakest one for the strongest advantage
  // criterion available.
  for (const reserved of RESERVED_CATEGORIES) {
    if (chosen.length < target) break;
    if (chosen.some(c => categoryOf(rows, c.slug) === reserved)) continue;
    const candidate = eligible.find(r => r.category === reserved && toCriterion(r, facts));
    if (!candidate) continue;
    const c = toCriterion(candidate, facts);
    if (!c) continue;
    // Drop the last-placed criterion, which is the lowest priority of the set.
    chosen.pop();
    chosen.push(c);
    usedCategory.add(reserved);
  }

  // A second pass allowing repeats of a category, but only to fill a gap the
  // library could not otherwise cover — two budget criteria beat asking the
  // model for something it will invent.
  if (chosen.length < target) {
    const have = new Set(chosen.map(c => c.slug));
    for (const row of eligible) {
      if (chosen.length >= target) break;
      if (have.has(row.slug)) continue;
      const c = toCriterion(row, facts);
      if (!c) continue;
      chosen.push(c);
      have.add(row.slug);
    }
  }
  return chosen;
}

// Combines the library's criteria with whatever the model wrote to fill the
// gap. The library wins: a model asked for two extra criteria sometimes returns
// five, and silently letting it overwrite curated, checkable criteria with its
// own would undo the whole point.
//
// Model-written criteria are always judgement. They arrive untyped, and a
// threshold nobody reviewed is not something to grade arithmetic against.
function mergeFitTest(fromLibrary, modelFitTest, facts) {
  const out = (fromLibrary || []).slice(0, TARGET);
  const gap = TARGET - out.length;
  if (gap <= 0) return out;

  const seen = new Set(out.map(c => norm(c.criterion)));
  (Array.isArray(modelFitTest) ? modelFitTest : []).forEach(c => {
    if (out.length >= TARGET) return;
    const criterion = String((c && c.criterion) || '').trim().slice(0, 200);
    if (!criterion || seen.has(norm(criterion))) return;
    seen.add(norm(criterion));
    out.push({
      criterion,
      why: String((c && c.why) || '').trim().slice(0, 300),
      check: 'judgment', metric: null, op: null, value: null,
      source: 'ai', slug: null
    });
  });
  return out;
}

module.exports = { founderFacts, matches, bind, toCriterion, selectFromLibrary, mergeFitTest, TARGET,
                   BUDGET_USD, HOURS_MAX, RUNWAY_WEEKS, INCOME_GOAL, NO_RUNWAY_DEADLINE_WEEKS };
