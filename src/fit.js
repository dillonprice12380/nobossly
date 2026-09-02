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

// At least this many criteria must stay in play. Without a floor, marking
// criteria "not applicable" could dissolve the test entirely and hand out a
// 100% on nothing.
const MIN_APPLICABLE = 3;

// Grades ONE criterion. Returns { pass, verified, basis, applicable }.
//
// `modelPass` is what the advisor said. It is used only where the criterion
// cannot be checked — a verifiable criterion ignores the model entirely, which
// is the point: that is the half of the score that stops moving on a re-run.
//
// `modelApplicable` is the advisor saying the criterion does not bear on this
// idea at all ("can it be delivered in evenings?" against a product that is not
// delivered by anyone). Such a criterion is excluded from the score rather than
// forced into a pass, which would inflate it, or a fail, which would make the
// test permanently unpassable.
//
// A criterion that can be CHECKED is always applicable: if there is a real
// number to compare, the question is a real one. That also stops the model
// declaring away the half of the score it does not control.
function gradeCriterion(criterion, idea, modelPass, modelApplicable) {
  const c = criterion || {};
  const applicable = modelApplicable !== false;
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
          applicable: true,
          basis: fmt(actual, metric.unit) + ' vs ' + c.op + ' ' + fmt(threshold, metric.unit)
        };
      }
      // A criterion that says it is checkable but has nothing to check against
      // falls back to the model rather than defaulting to a pass. Silently
      // passing an unverifiable criterion is how a score becomes a lie.
      return { pass: !!modelPass, verified: false, applicable, basis: 'no estimate to check against' };
    }
    return { pass: !!modelPass, verified: false, applicable, basis: 'incomplete criterion' };
  }
  return { pass: !!modelPass, verified: false, applicable, basis: 'advisor judgement' };
}

// Grades the whole test. `fitTest` is the pinned criteria; `modelResults` is
// what the advisor returned, matched by position.
//
// The denominator is the number of APPLICABLE criteria — never a hard 5, and
// never one the advisor did not actually give. Two things follow:
//
//   - A Compass that writes four criteria scores out of four. Completion is a
//     percentage, so the ladder does not soft-lock on founders whose test is
//     not exactly five long.
//   - A criterion the idea genuinely does not touch drops out of the score
//     instead of being forced into a verdict. Forcing a pass inflates the
//     score; forcing a fail makes the test permanently unpassable, which
//     would strand the founder at Level 1 for good.
function gradeFitTest(fitTest, modelResults, idea) {
  const pinned = Array.isArray(fitTest) ? fitTest : null;
  const model = Array.isArray(modelResults) ? modelResults : [];
  // With nothing pinned there is no test to grade against, so fall back to the
  // advisor's own results — this is what older ideas have.
  const source = pinned && pinned.length ? pinned : model.map(r => ({ criterion: r && r.criterion, check: 'judgment' }));
  if (!source.length) return { results: null, passed: null, total: null, verified: 0, applicable: 0, pct: null };

  let results = source.map((c, i) => {
    const mr = model[i] || {};
    const g = gradeCriterion(c, idea, mr.pass, mr.applicable);
    return {
      criterion: String((c && c.criterion) || mr.criterion || '').slice(0, 200),
      pass: g.pass,
      verified: g.verified,
      applicable: g.applicable,
      basis: g.basis,
      note: String(mr.note || '').slice(0, 300)
    };
  });

  // The floor. Beyond the allowance, extra "not applicable" verdicts are put
  // back in play — otherwise an advisor could excuse the whole test and hand
  // out a 100% for nothing.
  const allowedNA = Math.max(0, results.length - MIN_APPLICABLE);
  let na = 0;
  results = results.map(r => {
    if (r.applicable) return r;
    if (na < allowedNA) { na++; return r; }
    return { ...r, applicable: true, basis: r.basis + ' (kept in play: too few criteria left)' };
  });

  const live = results.filter(r => r.applicable);
  const passed = live.filter(r => r.pass).length;
  const total = live.length;
  return {
    results,
    passed,
    total,
    verified: live.filter(r => r.verified).length,
    applicable: total,
    // Completion as a percentage, so the trophies work whatever the test's
    // length. This is what the ladder reads.
    pct: total ? Math.round(100 * passed / total) : null
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

module.exports = { parseMoney, parseWeeks, gradeCriterion, gradeFitTest, pinFitTest, METRICS, MIN_APPLICABLE };
