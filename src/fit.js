// Grading an idea against the founder's fit test.
//
// The fit test used to be graded entirely by the model: it wrote the five
// criteria, then decided whether the idea passed them. Nothing defined what
// "pass" meant, so the same idea could score differently on a re-run — and
// re-running is the whole Level 1 loop, which made the score farmable by
// clicking again.
//
// This grades every criterion it can in code instead. A criterion like "does it
// start for under $800?" carries its own threshold, so the only thing left to
// the model is the cost ESTIMATE; the comparison is arithmetic and gives the
// same answer every time. Criteria that are genuinely judgement ("does your
// clinical credibility matter to the buyer?") still go to the model, and are
// labelled as judgement so a 5/5 is not read as certainty.
//
// Everything here is pure: no database, no network, no model. That is
// deliberate — it is the part that has to be predictable.

// ---------- parsing the advisor's own estimates ----------
//
// Both parsers take the TOP of a range. "$500-800" against a $800 ceiling reads
// as 800, not 500: the conservative reading is the honest one, and flattering
// an idea on the cheap end of its own estimate is exactly the failure this file
// exists to prevent.

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';

function parseMoney(raw) {
  const str = String(raw == null ? '' : raw).toLowerCase();
  if (!str.trim()) return null;
  // "free", "$0", "nothing to start" all mean zero, and zero is a real answer.
  if (/\b(free|no cost|nothing|zero)\b/.test(str) && !new RegExp(NUM).test(str)) return 0;
  const nums = [];
  const re = new RegExp(NUM + '\\s*(k\\b)?', 'g');
  let m;
  while ((m = re.exec(str)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (m[2]) n *= 1000;          // "$2k"
    nums.push(n);
  }
  if (!nums.length) return null;
  return Math.max.apply(null, nums);
}

const WEEKS = { day: 1 / 7, week: 1, month: 4.345, quarter: 13, year: 52 };

function parseWeeks(raw) {
  const str = String(raw == null ? '' : raw).toLowerCase();
  if (!str.trim()) return null;
  if (/\b(immediate|immediately|instantly|same day|day one)\b/.test(str)) return 0;
  const re = new RegExp(NUM + '(?:\\s*[-–—]\\s*' + NUM + ')?\\s*(day|week|month|quarter|year)s?', 'g');
  let best = null, m;
  while ((m = re.exec(str)) !== null) {
    const unit = WEEKS[m[3]];
    // The top of the range when one is given, otherwise the single figure.
    const n = parseFloat((m[2] || m[1]).replace(/,/g, ''));
    if (!Number.isFinite(n) || !unit) continue;
    const weeks = n * unit;
    if (best == null || weeks > best) best = weeks;
  }
  return best;
}

// Which of the advisor's fields a numeric criterion can be checked against.
// Anything not listed here has no number to compare, so it stays judgement
// rather than being guessed at.
const METRICS = {
  startup_cost: { field: 'startup_cost_lean', parse: parseMoney, unit: '' },
  time_to_revenue: { field: 'time_to_revenue', parse: parseWeeks, unit: ' weeks' }
};

const OPS = {
  lte: (a, b) => a <= b,
  lt: (a, b) => a < b,
  gte: (a, b) => a >= b,
  gt: (a, b) => a > b
};

const fmt = (n, unit) => (Math.round(n * 100) / 100) + unit;

// Grades ONE criterion. Returns { pass, verified, basis }.
//
// `modelPass` is what the advisor said. It is used only where the criterion
// cannot be checked — a verifiable criterion ignores the model entirely, which
// is the point: that is the half of the score that stops moving on a re-run.
function gradeCriterion(criterion, idea, modelPass) {
  const c = criterion || {};
  if (c.check === 'numeric') {
    const metric = METRICS[c.metric];
    const op = OPS[c.op];
    const threshold = typeof c.value === 'number' ? c.value : parseFloat(c.value);
    if (metric && op && Number.isFinite(threshold)) {
      const actual = metric.parse(idea && idea[metric.field]);
      if (actual != null) {
        return {
          pass: op(actual, threshold),
          verified: true,
          basis: fmt(actual, metric.unit) + ' vs ' + c.op + ' ' + fmt(threshold, metric.unit)
        };
      }
      // A criterion that says it is checkable but has nothing to check against
      // falls back to the model rather than defaulting to a pass. Silently
      // passing an unverifiable criterion is how a score becomes a lie.
      return { pass: !!modelPass, verified: false, basis: 'no estimate to check against' };
    }
    return { pass: !!modelPass, verified: false, basis: 'incomplete criterion' };
  }
  return { pass: !!modelPass, verified: false, basis: 'advisor judgement' };
}

// Grades the whole test. `fitTest` is the pinned criteria; `modelResults` is
// what the advisor returned, matched by position.
//
// The denominator is the number of criteria actually pinned — never a hard 5.
// Showing "3/5" when the Compass only ever wrote four is a score nobody gave.
function gradeFitTest(fitTest, modelResults, idea) {
  const pinned = Array.isArray(fitTest) ? fitTest : null;
  const model = Array.isArray(modelResults) ? modelResults : [];
  // With nothing pinned there is no test to grade against, so fall back to the
  // advisor's own results — this is what older ideas have.
  const source = pinned && pinned.length ? pinned : model.map(r => ({ criterion: r && r.criterion, check: 'judgment' }));
  if (!source.length) return { results: null, passed: null, total: null, verified: 0 };

  const results = source.map((c, i) => {
    const mr = model[i] || {};
    const g = gradeCriterion(c, idea, mr.pass);
    return {
      criterion: String((c && c.criterion) || mr.criterion || '').slice(0, 200),
      pass: g.pass,
      verified: g.verified,
      basis: g.basis,
      note: String(mr.note || '').slice(0, 300)
    };
  });
  return {
    results,
    passed: results.filter(r => r.pass).length,
    total: results.length,
    verified: results.filter(r => r.verified).length
  };
}

// Sanitises the Compass's fit_test before it is pinned to an idea. The model
// writes these, so nothing here trusts the shape: an unknown metric or a
// non-numeric threshold is demoted to judgement rather than stored as a
// half-built "numeric" criterion that would silently never verify.
function pinFitTest(fitTest) {
  if (!Array.isArray(fitTest) || !fitTest.length) return null;
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  return fitTest.slice(0, 5).map(c => {
    const criterion = str(c && c.criterion, 200);
    const out = { criterion, why: str(c && c.why, 300), check: 'judgment', metric: null, op: null, value: null };
    if (!c) return out;
    const value = typeof c.value === 'number' ? c.value : parseFloat(c.value);
    if (c.check === 'numeric' && METRICS[c.metric] && OPS[c.op] && Number.isFinite(value)) {
      out.check = 'numeric'; out.metric = c.metric; out.op = c.op; out.value = value;
    } else if (c.check === 'boolean') {
      out.check = 'boolean';
    }
    return out;
  }).filter(c => c.criterion);
}

module.exports = { parseMoney, parseWeeks, gradeCriterion, gradeFitTest, pinFitTest, METRICS };
