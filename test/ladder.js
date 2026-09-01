// Regression test for the Founder's Ladder.
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

const { meetsRequirements } = require('../src/xp');
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
const have = new Set();
let xp = 0;

console.log('Climbing on quest XP alone (no grinding tasks or check-ins):\n');
for (const l of cfg.levels) {
  const qs = (l.requirements && l.requirements.quests) || [];
  for (const q of qs) {
    const k = key(q.type, q.title);
    if (!awardable.has(k)) { console.log(`  ✗ L${l.level}: "${q.title}" (${q.type}) is UNAWARDABLE`); fail++; continue; }
    if (!have.has(k)) { have.add(k); xp += xpOf.get(k) || 0; }
  }
  const questsOk = meetsRequirements(l.requirements, have);
  const xpOk = xp >= l.xp_required;
  if (!(questsOk && xpOk)) fail++;
  console.log(`  ${questsOk && xpOk ? '✓' : '✗'} L${String(l.level).padStart(2)} ${l.title.padEnd(13)} quests ${questsOk ? 'ok' : 'NO'} · xp ${String(xp).padStart(5)}/${String(l.xp_required).padEnd(5)} ${xpOk ? 'ok' : 'SHORT ' + (l.xp_required - xp)}`);
}

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
