// Regression test for the ladders — nine of them now, one per path.
//
// The original failure this file was written for: founder_levels.requirements
// named milestones by title that no code path could award, so levels 5, 6, 8, 9
// and 10 were unreachable for months, including "first sale". Nothing errored.
//
// Nine ladders multiply that risk by nine. A gate that does not exist, is not
// awardable, or is worth the wrong XP strands one path and leaves the other
// eight green — so every ladder is climbed here, separately, using the same
// meetsRung the app runs.
//
// ladder-config.json snapshots the quest economy from the database (anon RLS
// blocks reading `challenges` with the publishable key). Level definitions are
// NOT in it any more: src/ladders.js is the source of truth for those, so there
// is nothing to drift. Refresh the quest half after changing challenges or
// milestones with:
//
//   select json_build_object(
//     'challenges', (select json_agg(row_to_json(c) order by c.title) from (select title,xp_reward,requires_proof from challenges where is_active) c),
//     'milestones', (select json_agg(row_to_json(m) order by m.title) from (select title,xp_reward,auto_kind,is_claimable from predefined_milestones where is_active) m));
//
//   node test/ladder.js

const ladders = require('../src/ladders');
const paths = require('../src/paths');
const cfg = require('./ladder-config.json');

const key = (t, title) => t + ':' + String(title).trim().toLowerCase();

const awardable = new Set();
const xpOf = new Map();
cfg.challenges.forEach(c => { awardable.add(key('challenge', c.title)); xpOf.set(key('challenge', c.title), c.xp_reward); });
cfg.milestones.forEach(m => {
  if (m.auto_kind || m.is_claimable) awardable.add(key('milestone', m.title));
  xpOf.set(key('milestone', m.title), m.xp_reward);
});

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// Climb one ladder, earning only what that ladder's own rungs ask for.
function climb(slug) {
  const have = new Set();
  let xp = 0;
  const problems = [];
  for (const rung of ladders.ladderFor(slug)) {
    // Rung 9 takes any two of three, so only earn what it needs — otherwise the
    // XP total would silently include a milestone nobody has to claim.
    const need = rung.min && rung.min > 0 ? Math.min(rung.min, rung.gates.length) : rung.gates.length;
    for (const g of rung.gates.slice(0, need)) {
      const k = ladders.gateKey(g);
      if (!awardable.has(k)) { problems.push(`L${rung.level}: "${g.title}" (${g.type}) UNAWARDABLE`); continue; }
      if (!have.has(k)) { have.add(k); xp += xpOf.get(k) || 0; }
    }
    if (!ladders.meetsRung(rung, have)) problems.push(`L${rung.level}: gates unmet`);
    if (xp < rung.xp_required) problems.push(`L${rung.level}: ${rung.xp_required - xp} XP short`);
  }
  return { xp, problems };
}

console.log('\nEvery path climbs its own ten rungs on gate XP alone:\n');
const totals = {};
for (const slug of ladders.SLUGS.concat([ladders.DEFAULT_PATH])) {
  const { xp, problems } = climb(slug);
  totals[slug] = xp;
  fail += problems.length;
  console.log(`  ${problems.length ? '✗' : '✓'} ${slug.padEnd(17)} ${String(xp).padStart(5)} XP` +
              (problems.length ? '  — ' + problems.join('; ') : ''));
}

console.log('\nThe nine ladders stay one game:');

// Same cost everywhere. A path that reaches Level 10 for less XP than another is
// a shorter ladder wearing different words, which is the thing this design is
// meant not to be.
const spread = [...new Set(Object.values(totals))];
ok('every ladder costs the same XP to climb', spread.length === 1,
   spread.length === 1 ? spread[0] + ' XP each'
     : Object.entries(totals).map(([k, v]) => k + ':' + v).join(', '));

// Same shape everywhere: ten rungs, same floors, same meaning per rung.
const shape = ladders.STAGES.map(s => s.level + '@' + s.xp).join(',');
for (const slug of ladders.SLUGS) {
  const rungs = ladders.ladderFor(slug);
  const mine = rungs.map(r => r.level + '@' + r.xp_required).join(',');
  if (mine !== shape) { fail++; console.log(`  ✗ ${slug}: rungs or XP floors differ from the spine`); }
}
ok('all ten rungs and XP floors identical across paths', true, shape.split(',').length + ' rungs');

// Every path is covered, and nobody shares a title with another path's rung —
// two ladders using the same word for different rungs would make the
// leaderboard unreadable.
ok('every path has a ladder', paths.SLUGS.every(s => ladders.LADDERS[s]),
   paths.SLUGS.filter(s => !ladders.LADDERS[s]).join(', ') || 'all nine');
for (const slug of ladders.SLUGS) {
  const titles = ladders.ladderFor(slug).map(r => r.title);
  if (new Set(titles).size !== titles.length) { fail++; console.log(`  ✗ ${slug}: repeats a rung title`); }
}

// No rung may be free, and rung 9 is the only one that takes a subset.
for (const slug of ladders.SLUGS.concat([ladders.DEFAULT_PATH])) {
  for (const r of ladders.ladderFor(slug)) {
    if (r.level > 1 && !r.gates.length) { fail++; console.log(`  ✗ ${slug} L${r.level} asks for nothing`); }
    if (r.min && r.min > r.gates.length) { fail++; console.log(`  ✗ ${slug} L${r.level} needs ${r.min} of ${r.gates.length}`); }
  }
}
ok('no rung above the first is free', true, 'checked 10 ladders');

// The min rule, both ways, on the rung that uses it.
const nine = ladders.rungAt('creator', 9);
const two = new Set(nine.gates.slice(0, 2).map(ladders.gateKey));
const one = new Set([ladders.gateKey(nine.gates[0])]);
ok('rung 9 passes with two of three', ladders.meetsRung(nine, two), `min ${nine.min}`);
ok('rung 9 is blocked with one of three', !ladders.meetsRung(nine, one), 'blocked');

// Hiding other paths' gates must never hide a path's own.
console.log('\nQuest boards show each path only its own gates:');
for (const slug of ladders.SLUGS) {
  for (const type of ['challenge', 'milestone']) {
    const hidden = ladders.foreignGateTitles(slug, type);
    const own = ladders.ladderFor(slug).flatMap(r => r.gates).filter(g => g.type === type)
      .map(g => g.title.trim().toLowerCase());
    const lost = own.filter(t => hidden.has(t));
    if (lost.length) { fail++; console.log(`  ✗ ${slug} would hide its own ${type}: ${lost.join(', ')}`); }
  }
}
ok('no path hides a gate it needs', true, ladders.SLUGS.length + ' paths');
ok('a creator is not shown "Registered my business"',
   ladders.foreignGateTitles('creator', 'milestone').has('registered my business'), 'hidden');
ok('a plumber is not shown "Pitch 25 brands or collaborators"',
   ladders.foreignGateTitles('local_service', 'challenge').has('pitch 25 brands or collaborators'), 'hidden');

// Economy shape, unchanged in spirit: the ladder should be bought with
// real-world achievement, not with activity inside the app.
const sum = (arr, f) => arr.filter(f).reduce((s, x) => s + x.xp_reward, 0);
const external = sum(cfg.challenges, c => c.requires_proof) + sum(cfg.milestones, m => m.is_claimable);
const internal = sum(cfg.milestones, m => !!m.auto_kind) + sum(cfg.challenges, c => !c.requires_proof);
console.log(`\n  Economy: ${external} XP external achievement · ${internal} XP internal activity`
  + ` (${Math.round(100 * external / (external + internal))}% external)`);

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nAll nine ladders climbable end to end. All checks pass.');
process.exit(fail ? 1 : 0);
