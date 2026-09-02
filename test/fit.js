// Tests for deterministic fit-test grading (src/fit.js).
//
// This is the half of the Level 1 score that is meant to STOP MOVING between
// advisor runs. If the parsing is loose, a criterion silently reverts to the
// model's opinion and the loop becomes farmable again — without ever throwing.
//
//   node test/fit.js

const { parseMoney, parseWeeks, gradeCriterion, gradeFitTest, pinFitTest } = require('../src/fit');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('\nMoney parses to the TOP of a range (never flatter the idea):');
eq('"$500"', parseMoney('$500'), 500);
eq('"$500-800" -> 800, not 500', parseMoney('$500-800'), 800);
eq('"$1,200"', parseMoney('$1,200'), 1200);
eq('"$2k"', parseMoney('$2k'), 2000);
eq('"under $300"', parseMoney('under $300'), 300);
eq('"Free"', parseMoney('Free'), 0);
eq('"$0"', parseMoney('$0'), 0);
eq('"roughly $50/mo plus $200 setup" -> the larger', parseMoney('roughly $50/mo plus $200 setup'), 200);
eq('empty string -> null, not 0', parseMoney(''), null);
eq('null -> null', parseMoney(null), null);
eq('prose with no number -> null', parseMoney('depends on scope'), null);

console.log('\nTime parses to weeks, also topping the range:');
eq('"2-4 weeks" -> 4', parseWeeks('2-4 weeks'), 4);
eq('"3 weeks"', parseWeeks('3 weeks'), 3);
eq('"1 month"', parseWeeks('1 month'), 4.345);
eq('"6-8 months" -> 8 months', parseWeeks('6-8 months'), 8 * 4.345);
eq('"14 days" -> 2 weeks', parseWeeks('14 days'), 2);
eq('"immediately" -> 0', parseWeeks('immediately'), 0);
eq('"soon" -> null', parseWeeks('soon'), null);
eq('empty -> null', parseWeeks(''), null);

console.log('\nA verifiable criterion ignores the model entirely:');
{
  const under800 = { criterion: 'Under $800 to start?', check: 'numeric', metric: 'startup_cost', op: 'lte', value: 800 };
  // The model says FAIL, the arithmetic says pass. Arithmetic wins — this is
  // the whole point of the file.
  const a = gradeCriterion(under800, { startup_cost_lean: '$500' }, false);
  ok('model says fail, $500 <= $800 passes anyway', a.pass === true && a.verified === true, a.basis);
  // And the reverse: the model flatters, the arithmetic refuses.
  const b = gradeCriterion(under800, { startup_cost_lean: '$2,400' }, true);
  ok('model says pass, $2400 > $800 fails anyway', b.pass === false && b.verified === true, b.basis);
  // A range that straddles the threshold is judged on its top.
  const c = gradeCriterion(under800, { startup_cost_lean: '$600-900' }, true);
  ok('"$600-900" against a $800 ceiling fails on the top of the range', c.pass === false, c.basis);
  const d = gradeCriterion(under800, { startup_cost_lean: 'Free' }, false);
  ok('free start passes', d.pass === true && d.verified === true, d.basis);
}

console.log('\nAn unverifiable criterion falls back honestly, never to a free pass:');
{
  const under800 = { criterion: 'Under $800?', check: 'numeric', metric: 'startup_cost', op: 'lte', value: 800 };
  const noEstimate = gradeCriterion(under800, { startup_cost_lean: 'depends' }, false);
  ok('unparseable estimate -> model\'s answer, marked unverified',
     noEstimate.pass === false && noEstimate.verified === false, noEstimate.basis);
  ok('and it does NOT default to passing', gradeCriterion(under800, {}, false).pass === false);
  ok('it also does not default to failing when the model passed it',
     gradeCriterion(under800, {}, true).pass === true);

  const broken = gradeCriterion({ criterion: 'x', check: 'numeric', metric: 'nonsense', op: 'lte', value: 5 }, {}, true);
  ok('an unknown metric degrades to judgement', broken.verified === false, broken.basis);

  const judgment = gradeCriterion({ criterion: 'Does credibility matter?', check: 'judgment' }, {}, true);
  ok('a judgement criterion is the model\'s call, and says so', judgment.pass === true && judgment.verified === false, judgment.basis);

  const untyped = gradeCriterion({ criterion: 'legacy criterion with no check field' }, {}, true);
  ok('an untyped legacy criterion is treated as judgement', untyped.verified === false, untyped.basis);
}

console.log('\nThe whole test grades against the PINNED criteria:');
{
  const pinned = [
    { criterion: 'Under $800?', check: 'numeric', metric: 'startup_cost', op: 'lte', value: 800 },
    { criterion: 'Revenue within 8 weeks?', check: 'numeric', metric: 'time_to_revenue', op: 'lte', value: 8 },
    { criterion: 'Credibility matters?', check: 'judgment' }
  ];
  const idea = { startup_cost_lean: '$400', time_to_revenue: '3-4 weeks' };
  const model = [{ pass: false, note: 'n1' }, { pass: false, note: 'n2' }, { pass: true, note: 'n3' }];
  const g = gradeFitTest(pinned, model, idea);
  ok('denominator is the pinned count, not a hard 5', g.total === 3, `${g.passed}/${g.total}`);
  ok('two verified, one judgement', g.verified === 2, String(g.verified));
  ok('both verifiable criteria overrode the model', g.passed === 3, `${g.passed}/${g.total}`);
  ok('notes survive for the UI', g.results[0].note === 'n1');

  // The goalpost bug: the model returns a DIFFERENT set of criteria than the
  // ones pinned to the idea. The pinned ones must win, or the test the founder
  // is being scored against silently changed.
  const drifted = [{ criterion: 'Something else entirely', pass: true }];
  const g2 = gradeFitTest(pinned, drifted, idea);
  ok('drifted model criteria cannot replace the pinned ones',
     g2.total === 3 && g2.results[0].criterion === 'Under $800?', g2.results.map(r => r.criterion).join(' | '));

  // Nothing pinned (an idea drafted before this existed): fall back to the
  // advisor's own results rather than showing no score at all.
  const g3 = gradeFitTest(null, [{ criterion: 'a', pass: true }, { criterion: 'b', pass: false }], idea);
  ok('an unpinned legacy idea still scores, out of what it has', g3.total === 2 && g3.passed === 1, `${g3.passed}/${g3.total}`);
  ok('and none of it claims to be verified', g3.verified === 0);

  const g4 = gradeFitTest(null, null, idea);
  ok('nothing at all -> unscored, not 0/0', g4.passed === null && g4.total === null);
}

console.log('\nPinning sanitises what the model wrote:');
{
  const pinned = pinFitTest([
    { criterion: 'Under $800?', why: 'w', check: 'numeric', metric: 'startup_cost', op: 'lte', value: 800 },
    { criterion: 'Earning in 8 weeks?', check: 'numeric', metric: 'time_to_revenue', op: 'lte', value: '8' },
    { criterion: 'On camera?', check: 'boolean' },
    { criterion: 'Credibility?', check: 'judgment' },
    // Half-built numeric criteria must be demoted, not stored as numeric — a
    // stored "numeric" that can never verify would silently be judgement while
    // claiming to be checked.
    { criterion: 'Made-up metric', check: 'numeric', metric: 'vibes', op: 'lte', value: 3 },
    { criterion: 'No threshold', check: 'numeric', metric: 'startup_cost', op: 'lte' },
    { criterion: '' }
  ]);
  eq('caps at five criteria', pinned.length, 5);
  eq('a well-formed numeric survives', pinned[0].check, 'numeric');
  eq('a string threshold is coerced to a number', pinned[1].value, 8);
  eq('boolean survives', pinned[2].check, 'boolean');
  eq('an unknown metric is demoted to judgement', pinned[4].check, 'judgment');
  ok('and its metric is cleared, not left dangling', pinned[4].metric === null, String(pinned[4].metric));
  eq('nothing at all -> null', pinFitTest([]), null);
  eq('not an array -> null', pinFitTest('nope'), null);

  const blankDropped = pinFitTest([{ criterion: '' }, { criterion: 'real one' }]);
  eq('a criterion with no text is dropped', blankDropped.length, 1);
}

console.log('\nThe goalposts cannot move once an idea is pinned:');
{
  // The bug: fit_test lived only on the Compass, so "Sharpen it" redrew the
  // criteria under an idea already scored against them.
  const atDraft = pinFitTest([
    { criterion: 'Under $800?', check: 'numeric', metric: 'startup_cost', op: 'lte', value: 800 },
    { criterion: 'Credibility?', check: 'judgment' }
  ]);
  const idea = { startup_cost_lean: '$400' };
  const before = gradeFitTest(atDraft, [{ pass: false }, { pass: true }], idea);
  // The Compass is later redrawn with a harsher budget and a third criterion.
  const redrawn = pinFitTest([
    { criterion: 'Under $200?', check: 'numeric', metric: 'startup_cost', op: 'lte', value: 200 },
    { criterion: 'Credibility?', check: 'judgment' },
    { criterion: 'Brand new criterion', check: 'judgment' }
  ]);
  const after = gradeFitTest(atDraft, [{ pass: false }, { pass: true }], idea);
  ok('the same pinned test gives the same score', before.passed === after.passed && before.total === after.total,
     `${before.passed}/${before.total} then ${after.passed}/${after.total}`);
  const wouldHaveBeen = gradeFitTest(redrawn, [{ pass: false }, { pass: true }, { pass: true }], idea);
  ok('the redrawn Compass WOULD have scored differently — which is the bug pinning prevents',
     wouldHaveBeen.total !== before.total || wouldHaveBeen.passed !== before.passed,
     `pinned ${before.passed}/${before.total} vs redrawn ${wouldHaveBeen.passed}/${wouldHaveBeen.total}`);
}

console.log('\nA re-run of an unchanged idea cannot move the checked half:');
{
  const pinned = pinFitTest([
    { criterion: 'Under $800?', check: 'numeric', metric: 'startup_cost', op: 'lte', value: 800 },
    { criterion: 'Earning in 8 weeks?', check: 'numeric', metric: 'time_to_revenue', op: 'lte', value: 8 },
    { criterion: 'Credibility?', check: 'judgment' }
  ]);
  const idea = { startup_cost_lean: '$400', time_to_revenue: '3 weeks' };
  // Same idea, same estimates, but the model flips its mind on every criterion.
  const runA = gradeFitTest(pinned, [{ pass: true }, { pass: true }, { pass: true }], idea);
  const runB = gradeFitTest(pinned, [{ pass: false }, { pass: false }, { pass: true }], idea);
  ok('the two verified criteria hold across both runs',
     runA.results.slice(0, 2).every(r => r.pass) && runB.results.slice(0, 2).every(r => r.pass));
  ok('only the judgement criterion can swing',
     runA.passed === runB.passed, `${runA.passed}/${runA.total} vs ${runB.passed}/${runB.total}`);
  // And when the judgement one does swing, the score moves by exactly one.
  const runC = gradeFitTest(pinned, [{ pass: true }, { pass: true }, { pass: false }], idea);
  eq('a swung judgement moves the score by one', runA.passed - runC.passed, 1);
}

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nFit grading holds. All checks pass.');
process.exit(fail ? 1 : 0);
