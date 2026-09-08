// Regression test for the Ladder.
//
// The ladder was hard-capped at Level 4 for months: founder_levels.requirements
// named seven milestones by title that no code path could award, so levels 5,
// 6, 8, 9 and 10 were unreachable — including Level 5, "first sale", the
// product's headline promise. Nothing errored, so nothing surfaced it.
//
// This walks a founder up all ten rungs using the same meetsRequirements logic
// the app runs, earning only each level's own requirements, and fails if any
// rung is unreachable or if quest XP alone can't cover the thresholds.
//
//   node test/ladder.js
//
// ladder-config.json is a snapshot of the live game config (anon RLS blocks
// reads on `challenges`, so it can't be fetched with the publishable key).
// Regenerate it after changing levels, challenges or milestones with:
//
//   select json_build_object(
//     'levels',     (select json_agg(row_to_json(l) order by l.level) from (select level,title,emoji,xp_required,requirements from founder_levels) l),
//     'challenges', (select json_agg(row_to_json(c)) from (select title,xp_reward,requires_proof from challenges where is_active) c),
//     'milestones', (select json_agg(row_to_json(m)) from (select title,xp_reward,auto_kind,is_claimable from predefined_milestones where is_active) m)
//   );

const { meetsRequirements, applicableQuests } = require('../src/xp');
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

// Every path, all ten rungs.
//
// Gates are path-aware now: a creator is not asked to register a company, a
// plumber is not asked for a pitch deck, and a shop is not handed a gate it
// clears before lunch. The failure that shape invites is a path whose
// substitute does not exist, is not awardable, or is worth less XP than the
// gate it replaces — none of which throws. Every one of them would just quietly
// strand somebody at a rung, exactly like the Level 4 cap this file was written
// for. So the climb runs once per path, on that path's own gates.
const climb = pathSlug => {
  const have = new Set();
  let xp = 0;
  const problems = [];
  for (const l of cfg.levels) {
    for (const q of applicableQuests(l.requirements, pathSlug)) {
      const k = key(q.type, q.title);
      if (!awardable.has(k)) { problems.push(`L${l.level}: "${q.title}" (${q.type}) UNAWARDABLE`); continue; }
      if (!have.has(k)) { have.add(k); xp += xpOf.get(k) || 0; }
    }
    if (!meetsRequirements(l.requirements, have, pathSlug)) problems.push(`L${l.level}: quests unmet`);
    if (xp < l.xp_required) problems.push(`L${l.level}: ${l.xp_required - xp} XP short`);
  }
  return { xp, problems };
};

console.log('Every path climbs all ten rungs on quest XP alone:\n');
const totals = {};
for (const p of paths.PATHS) {
  const { xp, problems } = climb(p.slug);
  totals[p.slug] = xp;
  if (problems.length) fail += problems.length;
  console.log(`  ${problems.length ? '✗' : '✓'} ${p.slug.padEnd(17)} ${String(xp).padStart(5)} XP` +
              (problems.length ? '  — ' + problems.join('; ') : ''));
}

// A member who has not finished onboarding has no path. They must still get a
// coherent ladder rather than a rung with no gates or an impossible one.
const nopath = climb(undefined);
if (nopath.problems.length) fail += nopath.problems.length;
console.log(`  ${nopath.problems.length ? '✗' : '✓'} ${'(no path set)'.padEnd(17)} ${String(nopath.xp).padStart(5)} XP` +
            (nopath.problems.length ? '  — ' + nopath.problems.join('; ') : ''));

// Substitution has to be like-for-like. If one path can reach Level 10 for less
// XP than another, the swap quietly made that path's ladder shorter — which is
// the thing the whole design was meant not to do.
const spread = Object.values(totals);
const even = Math.min(...spread) === Math.max(...spread);
if (!even) fail++;
console.log(`\n  ${even ? '✓' : '✗'} every path costs the same XP to climb  — ` +
  (even ? spread[0] + ' XP each'
        : Object.entries(totals).map(([k, v]) => k + ':' + v).join(', ')));

// And each rung must actually ask every path for something.
for (const p of paths.PATHS) {
  for (const l of cfg.levels) {
    if (!l.requirements) continue;
    const n = applicableQuests(l.requirements, p.slug).length;
    if (n === 0) { fail++; console.log(`  ✗ ${p.slug} has NO gate at L${l.level} — a free rung`); }
  }
}

const have = new Set();
let xp = totals.freelancer;
cfg.levels.forEach(l => applicableQuests(l.requirements, 'freelancer').forEach(q => have.add(key(q.type, q.title))));

// The quest board and the trophy case filter by level only, so a path-specific
// gate would otherwise be browsable by everyone. Hiding is the easy half; the
// half worth testing is that nobody's OWN gate goes missing, which would strand
// them at that rung with no way to see what they needed.
const { foreignGateTitles } = require('../src/xp');
for (const p of paths.PATHS) {
  for (const type of ['challenge', 'milestone']) {
    const hidden = foreignGateTitles(cfg.levels, p.slug, type);
    const ownGates = cfg.levels.flatMap(l => applicableQuests(l.requirements, p.slug))
      .filter(q => q.type === type).map(q => q.title.trim().toLowerCase());
    const lost = ownGates.filter(t => hidden.has(t));
    if (lost.length) { fail++; console.log(`  ✗ ${p.slug} would have its own ${type} hidden: ${lost.join(', ')}`); }
  }
}
const creatorHidden = foreignGateTitles(cfg.levels, 'creator', 'milestone');
const hidesRegistration = creatorHidden.has('registered my business');
if (!hidesRegistration) fail++;
console.log(`\n  ${hidesRegistration ? '✓' : '✗'} a creator is not shown "Registered my business"`);
const shopHidden = foreignGateTitles(cfg.levels, 'brick_mortar', 'challenge');
const hidesTinyMonth = shopHidden.has('hit a $1k month');
if (!hidesTinyMonth) fail++;
console.log(`  ${hidesTinyMonth ? '✓' : '✗'} a shop is not shown "Hit a $1k month" — its rent is more than that`);

// Level 9 is "any 2 of 3" — verify the min rule both ways.
const l9 = cfg.levels.find(l => l.level === 9);
const two = new Set(l9.requirements.quests.slice(0, 2).map(q => key(q.type, q.title)));
const one = new Set([key(l9.requirements.quests[0].type, l9.requirements.quests[0].title)]);
const twoOk = meetsRequirements(l9.requirements, two);
const oneBlocked = !meetsRequirements(l9.requirements, one);
if (!twoOk || !oneBlocked) fail++;
console.log(`\n  min-rule: L9 with 2 of 3 -> ${twoOk ? '✓ passes' : '✗ FAILS'}`);
console.log(`  min-rule: L9 with 1 of 3 -> ${oneBlocked ? '✓ blocked' : '✗ WRONGLY PASSES'}`);

// Economy shape.
const sum = (arr, f) => arr.filter(f).reduce((s, x) => s + x.xp_reward, 0);
const external = sum(cfg.challenges, c => c.requires_proof) + sum(cfg.milestones, m => m.is_claimable);
const internal = sum(cfg.milestones, m => !!m.auto_kind) + sum(cfg.challenges, c => !c.requires_proof);
console.log(`\n  Economy: ${external} XP external achievement · ${internal} XP internal activity`
  + ` (${Math.round(100 * external / (external + internal))}% external)`);
console.log(`  First sale ${xpOf.get(key('challenge', 'Make your first sale'))} XP`
  + ` vs all task+streak+checkin trophies ${sum(cfg.milestones, m => ['tasks', 'streak', 'checkins'].includes(m.auto_kind))} XP`);

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nLadder climbable end to end. All checks pass.');
process.exit(fail ? 1 : 0);
