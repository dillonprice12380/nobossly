// Regression test for the Level 1 idea-refinement loop.
//
// The loop's whole value is that the fit score is HONEST and that progress is
// unfarmable. Three things can quietly break that, and none of them would throw:
//
//   1. A denominator the advisor never gave ("3/5" when it returned 4 criteria).
//   2. best_fit_passed going down after a bad revision, taking back a trophy.
//   3. A Coach that nags you to revise an idea you already cut, or to blueprint
//      one that has not been tested.
//
//   node test/level1-loop.js

const { matches } = require('../src/guidance');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

// ---------- 1. The denominator is whatever the advisor actually returned ----------
// Mirrors scoreFit in src/routes/compass.js and the view's fallback.
function scoreFit(fitResults) {
  if (!Array.isArray(fitResults) || !fitResults.length) return { passed: null, total: null };
  return { passed: fitResults.filter(f => f && f.pass).length, total: fitResults.length };
}
const crit = n => Array.from({ length: n }, (_, i) => ({ criterion: 'c' + i, pass: i < 2 }));

console.log('\nThe fit score never invents a denominator:');
{
  const five = scoreFit(crit(5));
  ok('five criteria -> out of five', five.passed === 2 && five.total === 5, `${five.passed}/${five.total}`);
  const four = scoreFit(crit(4));
  ok('four criteria -> out of FOUR, not five', four.total === 4, `${four.passed}/${four.total}`);
  const none = scoreFit(null);
  ok('no fit_results -> unscored, not 0/5', none.passed === null && none.total === null, `${none.passed}/${none.total}`);
  const empty = scoreFit([]);
  ok('empty array -> unscored, not 0/0', empty.total === null, `${empty.passed}/${empty.total}`);
  const allPass = scoreFit([{ pass: true }, { pass: true }]);
  ok('a 2-criterion run can still be complete', allPass.passed === allPass.total, `${allPass.passed}/${allPass.total}`);
}

// ---------- 2. The high-water mark only ever rises ----------
// Mirrors the best_fit_passed line in runAdvisor.
const best = (prev, now) => Math.max(prev || 0, now || 0);

console.log('\nA worse revision never takes back a trophy:');
{
  ok('4 then 2 keeps 4', best(4, 2) === 4, String(best(4, 2)));
  ok('2 then 4 becomes 4', best(2, 4) === 4, String(best(2, 4)));
  ok('a null score keeps the mark', best(3, null) === 3, String(best(3, null)));
  ok('first score sets the mark', best(0, 3) === 3, String(best(0, 3)));
}

// ---------- 3. Metrics are per-idea where the quest is per-idea ----------
// Mirrors the idea_fit and signals metrics in src/milestones_engine.js.
const idea_fit = rows => (rows || []).reduce((b, r) => Math.max(b, r.best_fit_passed || 0), 0);
function signals(rows) {
  const per = {};
  (rows || []).forEach(r => { per[r.idea_id] = (per[r.idea_id] || 0) + 1; });
  return Object.keys(per).reduce((b, k) => Math.max(b, per[k]), 0);
}

console.log('\nTrophy metrics measure the right thing:');
{
  ok('idea_fit takes the best idea, not the newest',
     idea_fit([{ best_fit_passed: 5 }, { best_fit_passed: 1 }]) === 5);
  ok('idea_fit of no ideas is 0, not NaN', idea_fit([]) === 0, String(idea_fit([])));
  // The quest is "three signals for ONE idea". Spreading one signal across
  // three ideas is not the same achievement and must not clear it.
  ok('three signals on one idea counts as three',
     signals([{ idea_id: 'a' }, { idea_id: 'a' }, { idea_id: 'a' }]) === 3);
  ok('one signal on each of three ideas counts as ONE',
     signals([{ idea_id: 'a' }, { idea_id: 'b' }, { idea_id: 'c' }]) === 1,
     String(signals([{ idea_id: 'a' }, { idea_id: 'b' }, { idea_id: 'c' }])));
}

// ---------- 4. The Coach says the right thing at each stage ----------
// CAVEAT: these conditions are a copy of what lives in guidance_rules, the same
// way ladder-config.json snapshots the live ladder — anon RLS blocks reading
// either with the publishable key. So this proves the RULES ARE COHERENT, not
// that the database still matches. Re-check with the query in
// migrations/2026-09-02_level_1_idea_refinement_loop.sql after editing a rule.
//
// The point of the test is the ORDER: exactly one of the mutually exclusive
// loop rules should match at any given stage.
const RULES = [
  { key: 'no_questionnaire',        priority: 105, cond: { has_questionnaire: false } },
  { key: 'no_compass',              priority: 100, cond: { has_questionnaire: true, has_compass: false } },
  { key: 'compass_no_idea',         priority: 95,  cond: { has_compass: true, live_ideas: 0 } },
  { key: 'idea_unscored',           priority: 94,  cond: { live_ideas: { gte: 1 }, idea_scored: false } },
  { key: 'idea_refine',             priority: 93,  cond: { idea_scored: true, fit_complete: false } },
  { key: 'idea_needs_signals',      priority: 92,  cond: { fit_complete: true, signals_count: { lt: 3 } } },
  { key: 'idea_ready_for_blueprint', priority: 91, cond: { fit_complete: true, signals_count: { gte: 3 }, has_blueprint: false } }
];
const top = state => RULES.filter(r => matches(r.cond, state)).sort((a, b) => b.priority - a.priority).map(r => r.key);

const base = { has_questionnaire: true, has_compass: true, live_ideas: 1, idea_scored: true,
               fit_complete: false, signals_count: 0, has_blueprint: false };

console.log('\nThe Coach walks Level 1 in order:');
const stages = [
  ['fresh signup',            { ...base, has_questionnaire: false, has_compass: false, live_ideas: 0, idea_scored: false }, 'no_questionnaire'],
  ['answered, no Compass',    { ...base, has_compass: false, live_ideas: 0, idea_scored: false },                          'no_compass'],
  ['Compass, no idea',        { ...base, live_ideas: 0, idea_scored: false },                                              'compass_no_idea'],
  ['idea drafted, unscored',  { ...base, idea_scored: false },                                                             'idea_unscored'],
  ['scored 3/5',              { ...base },                                                                                 'idea_refine'],
  ['5/5, no evidence',        { ...base, fit_complete: true },                                                             'idea_needs_signals'],
  ['5/5 with 3 signals',      { ...base, fit_complete: true, signals_count: 3 },                                           'idea_ready_for_blueprint']
];
for (const [label, state, expect] of stages) {
  const hits = top(state);
  ok(label + ' -> ' + expect, hits[0] === expect, hits.length ? hits.join(', ') : 'nothing matched');
}

console.log('\nAnd it does not nag about ideas that are gone or done:');
{
  // A founder who cut their only idea: live_ideas drops to 0, so they are told
  // to draft the next one rather than to revise the one they just cut.
  const afterCut = { ...base, live_ideas: 0, idea_scored: false };
  ok('cut their only idea -> draft another, not "revise"',
     top(afterCut)[0] === 'compass_no_idea' && !top(afterCut).includes('idea_refine'),
     top(afterCut).join(', '));
  // Blueprint built and everything passing: the loop is finished and silent.
  const done = { ...base, fit_complete: true, signals_count: 3, has_blueprint: true };
  ok('loop finished -> no loop rule fires', top(done).length === 0, top(done).join(', ') || 'silent');
  // Never both "revise" and "gather evidence" at once.
  const anyDouble = stages.some(([, st]) => {
    const h = top(st);
    return h.includes('idea_refine') && h.includes('idea_needs_signals');
  });
  ok('never asks to revise and to gather evidence at the same time', !anyDouble);
}

// The idea page these render checks read (views/idea_detail.ejs) was removed
// with Compass on 2026-09-24, so its checks went with it.

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nLevel 1 loop holds. All checks pass.');
process.exit(fail ? 1 : 0);
