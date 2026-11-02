// The comparison matrix: a few options scored against your own criteria, each
// criterion weighted. Exploring uses it to compare ideas or paths; brick and
// mortar will use it for premises, physical product for manufacturers.
//
// It is a worksheet with layout 'matrix', so it lives in workspace_docs like
// every other worksheet and gets the same list / duplicate / delete pages.
// Stored shape: { options: [text], criteria: [{ label, weight }], scores: { 'o:c': 1–5 } }

const MAX_OPTIONS = 5;
const MAX_CRITERIA = 8;
const WEIGHTS = { 1: 'Nice to have', 2: 'Matters', 3: 'Must have' };

const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// A submitted form, cleaned. Options and criteria are kept in the order given,
// blanks dropped; a score only survives if both its option and criterion do.
function clean(def, body) {
  const options = [];
  const optIndex = {};
  for (let i = 0; i < MAX_OPTIONS; i++) {
    const v = t(body['opt_' + i], 80);
    if (v) { optIndex[i] = options.length; options.push(v); }
  }
  const criteria = [];
  const critIndex = {};
  for (let j = 0; j < MAX_CRITERIA; j++) {
    const v = t(body['crit_' + j], 80);
    if (!v) continue;
    const w = parseInt(body['w_' + j], 10);
    critIndex[j] = criteria.length;
    criteria.push({ label: v, weight: WEIGHTS[w] ? w : 2 });
  }
  const scores = {};
  Object.keys(optIndex).forEach(i => Object.keys(critIndex).forEach(j => {
    const n = parseInt(body['s_' + i + '_' + j], 10);
    if (n >= 1 && n <= 5) scores[optIndex[i] + ':' + critIndex[j]] = n;
  }));
  const data = { options, criteria, scores };
  const note = t(body.decision, 600);
  if (note) data.decision = note;
  return data;
}

// Weighted totals per option, best first, as a percentage of the best possible.
function results(data) {
  const d = data || {};
  const options = Array.isArray(d.options) ? d.options : [];
  const criteria = Array.isArray(d.criteria) ? d.criteria : [];
  const scores = d.scores || {};
  const maxPer = criteria.reduce((n, c) => n + 5 * (c.weight || 2), 0);
  const rows = options.map((label, i) => {
    let total = 0;
    let scored = 0;
    criteria.forEach((c, j) => {
      const s = scores[i + ':' + j];
      if (Number.isInteger(s)) { total += s * (c.weight || 2); scored++; }
    });
    return { index: i, label, total, scored, pct: maxPer ? Math.round(total / maxPer * 100) : 0, complete: scored === criteria.length && criteria.length > 0 };
  });
  const ranked = rows.slice().sort((a, b) => b.total - a.total);
  const leader = ranked.length && ranked[0].total > 0 ? ranked[0] : null;
  const tie = leader && ranked[1] && ranked[1].total === leader.total;
  return { rows, ranked, leader: tie ? null : leader, tie: !!tie, max: maxPer, MAX_OPTIONS, MAX_CRITERIA, WEIGHTS };
}

// "3 of 4 options fully scored", for the list page.
function progress(def, data) {
  const r = results(data);
  return { done: r.rows.filter(x => x.complete).length, total: Math.max(2, r.rows.length) };
}

module.exports = { MAX_OPTIONS, MAX_CRITERIA, WEIGHTS, clean, results, progress };
