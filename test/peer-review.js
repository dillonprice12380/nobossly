// Tests for the peer-review route to "Get 3 Feedback Sessions".
//
// The count of reviews received GATES A LEVEL, so the interesting failures are
// the ones that would let someone walk through it: reviewing yourself, the same
// reviewer counting twice, or posting rows that credit an account you do not
// own. Those are enforced in the database (see the migration) and exercised
// against the live schema in the SQL probe recorded in that file's header —
// what is testable offline is the logic around them.
//
//   node test/peer-review.js

const reviews = require('../src/routes/reviews');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('\nThe shape of the gate:');
eq('three reviews clear it', reviews.SESSIONS_NEEDED, 3);
ok('the rubric asks four things', reviews.RUBRIC.length === 4, reviews.RUBRIC.map(r => r.key).join(', '));
ok('every rubric question has a key and a human label',
   reviews.RUBRIC.every(r => r.key && r.label && r.label.length > 15));
ok('rubric keys are unique', new Set(reviews.RUBRIC.map(r => r.key)).size === reviews.RUBRIC.length);

console.log('\nA review has to be long enough to be a review:');
{
  const MIN = reviews.MIN_FEEDBACK;
  ok('the floor is meaningful, not token', MIN >= 100, String(MIN));
  // The strings this is meant to refuse.
  const junk = ['looks good!', 'nice idea', 'I like it', '👍', 'good luck with this one'];
  ok('every drive-by comment falls under the floor',
     junk.every(t => t.length < MIN), junk.map(t => t.length).join(', ') + ' vs ' + MIN);
  // And a real one clears it.
  const real = 'The problem is clear but the first customer is not — "trades" covers electricians and roofers who buy '
             + 'completely differently. I would pick one and rewrite the offer around how that trade already handles books.';
  ok('a genuine review clears it', real.length >= MIN, String(real.length));
}

console.log('\nScores are bounded, so a rubric cannot be gamed with junk input:');
{
  // Mirrors scoreOf in the route.
  const scoreOf = v => { const n = parseInt(v, 10); return (n >= 1 && n <= 5) ? n : null; };
  eq('"3" is 3', scoreOf('3'), 3);
  eq('"5" is 5', scoreOf('5'), 5);
  eq('"0" is rejected', scoreOf('0'), null);
  eq('"6" is rejected', scoreOf('6'), null);
  eq('"-2" is rejected', scoreOf('-2'), null);
  eq('empty is rejected', scoreOf(''), null);
  eq('nonsense is rejected', scoreOf('five'), null);
  eq('"4abc" clamps to 4 rather than passing junk through', scoreOf('4abc'), 4);
}

console.log('\nThe two routes to the quest stay separate:');
{
  // The gate is a CHALLENGE, not a new milestone, precisely so the ladder does
  // not have to change and the off-site route keeps working untouched.
  const cfg = require('./ladder-config.json');
  const l2 = cfg.levels.find(l => l.level === 2);
  const quest = l2.requirements.quests.find(q => q.title === 'Get 3 Feedback Sessions');
  ok('the Level 2 requirement is still the same challenge', !!quest && quest.type === 'challenge',
     quest ? quest.type : 'missing');
  const ch = cfg.challenges.find(c => c.title === 'Get 3 Feedback Sessions');
  ok('it still requires proof, so the off-site route is unchanged', ch && ch.requires_proof === true);
  const giver = cfg.challenges.find(c => c.title === 'Give a Peer Review');
  ok('giving a review is worth 60 XP, matching what the route awards', giver && giver.xp_reward === 60,
     giver ? String(giver.xp_reward) : 'missing');
}

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nPeer review holds. All checks pass.');
process.exit(fail ? 1 : 0);
