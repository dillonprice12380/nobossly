// Tests for what XP is worth and what a level actually gives you.
//
// The numbers this file guards were not chosen in the abstract. Production said
// it: of the 1,260 XP ever awarded on this platform, 1,200 came from three
// self-claimed milestones typed between 16:04:25 and 16:05:31 on one afternoon.
// The remaining 60 came from answering the Compass questionnaire and earning a
// follower — the only two things the software actually watched happen.
//
// A self-claim is a text box with a 30-character minimum and no verification.
// The twelve of them paid 6,500 XP between them; the whole ladder to Level 10
// costs 6,000. So the two properties below are the point of the rebalance:
//
//   1. You cannot climb the ladder on claims alone.
//   2. No single claim covers most of the gap to the rung it gates.
//
// Both are computed from src/ladders.js rather than written down, so moving an
// XP floor re-checks the economy instead of silently unbalancing it. The scale
// is parsed out of the migration, so the migration and this file cannot drift.
//
// The second half is the other audit finding: verified_level was written by
// awardXP and by admin approval, and read by nothing that gated anything.
//
//   node test/economy.js

const fs = require('fs');
const path = require('path');
const ladders = require('../src/ladders');
const unlocks = require('../src/unlocks');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const MIGRATION = 'migrations/2026-09-09_xp_rebalance_and_real_unlocks.sql';
const sql = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');

// The twelve self-claimed milestones, by the slug the migration reprices and
// the title the ladder gates on. Titles are checked against ladders.allGates()
// below, so a rename on either side shows up here rather than in production.
const CLAIMS = [
  { slug: 'registered-my-business',       title: 'Registered my business' },
  { slug: 'opened-business-bank-account', title: 'Opened a business bank account' },
  { slug: 'separate-your-business-money', title: 'Separate your business money' },
  { slug: 'set-up-how-you-get-paid',      title: 'Set up how you get paid' },
  { slug: 'built-a-pitch-deck',           title: 'Built a pitch deck' },
  { slug: 'write-your-one-page-plan',     title: 'Write your one-page plan' },
  { slug: 'first-profitable-month',       title: 'Had my first profitable month' },
  { slug: '1k-mrr',                       title: '$1K MRR' },
  { slug: 'completed-an-accelerator',     title: 'Completed an accelerator program' },
  { slug: 'went-full-time',               title: 'Went full-time on my business' },
  { slug: 'three-1k-months',              title: 'Three $1k months in a row' },
  { slug: 'three-months-rent-and-wages',  title: 'Three months of covering rent and paying yourself' }
];

// The values the migration's UPDATE actually sets, read out of the statement
// that sets them rather than restated here.
const update = sql.slice(sql.indexOf('set xp_reward = s.new_xp'));
const priced = {};
for (const m of update.matchAll(/\('([a-z0-9-]+)',\s*(\d+)\)/g)) priced[m[1]] = Number(m[2]);

console.log('\nThe migration reprices exactly the self-claimed milestones:');
ok('every claim is repriced', CLAIMS.every(c => priced[c.slug] !== undefined),
   CLAIMS.filter(c => priced[c.slug] === undefined).map(c => c.slug).join(', ') || `all ${CLAIMS.length}`);
ok('and nothing else is', Object.keys(priced).length === CLAIMS.length,
   `${Object.keys(priced).length} rows`);

// ---------------------------------------------------------------------------
// 1. You cannot climb the ladder on claims alone.

console.log('\nClaims cannot carry the climb:');

const STAGES = ladders.STAGES;
const toTop = STAGES.reduce((m, s) => Math.max(m, s.xp), 0);
const claimTotal = CLAIMS.reduce((n, c) => n + priced[c.slug], 0);

ok('all twelve claims together are worth less than the ladder costs',
   claimTotal < toTop, `${claimTotal} XP of claims vs ${toTop} XP to Level 10`);
ok('...and by a real margin, not a rounding error',
   claimTotal < toTop * 0.6, `${Math.round(claimTotal / toTop * 100)}% of the climb`);

// ---------------------------------------------------------------------------
// 2. No single claim covers most of the gap to the rung it gates.

console.log('\nNo one claim buys the rung it gates:');

// Which rung each claim is a gate for, on any path. A claim that gates several
// is judged against the tightest gap it sits in.
const gateLevels = {};
for (const p of ladders.SLUGS.concat([ladders.DEFAULT_PATH])) {
  for (const rung of ladders.ladderFor(p)) {
    for (const g of rung.gates || []) {
      if (g.type !== 'milestone') continue;
      const key = g.title.trim().toLowerCase();
      (gateLevels[key] || (gateLevels[key] = [])).push(rung.level);
    }
  }
}
const gapTo = level => {
  const here = STAGES.find(s => s.level === level);
  const prev = STAGES.find(s => s.level === level - 1);
  return here && prev ? here.xp - prev.xp : null;
};

const CEILING = 0.45; // a claim may be worth at most this share of its rung's gap
let gated = 0;
for (const c of CLAIMS) {
  const levels = gateLevels[c.title.trim().toLowerCase()];
  if (!levels) continue;                       // ungated claims have no gap to blow
  gated++;
  const tightest = Math.min(...levels.map(gapTo).filter(Boolean));
  const share = priced[c.slug] / tightest;
  ok(`${c.title} (${priced[c.slug]} XP) vs its ${tightest} XP rung`,
     share <= CEILING, `${Math.round(share * 100)}% of the gap`);
}
ok('the claims that gate rungs were all found in the ladder', gated > 0, `${gated} of ${CLAIMS.length}`);

// A claim title that no longer matches a gate is the silent failure mode: the
// check above skips it and the milestone stops unlocking anything.
const ladderMilestones = new Set(ladders.allGates()
  .filter(g => g.type === 'milestone').map(g => g.title.trim().toLowerCase()));
const orphaned = CLAIMS.filter(c => !ladderMilestones.has(c.title.trim().toLowerCase()));
ok('no claim title has drifted away from the ladder', orphaned.length === 0,
   orphaned.map(c => c.title).join(', ') || 'clean');

// ---------------------------------------------------------------------------
// 3. verified_level gates something now.

console.log('\nverified_level is what the live unlocks read:');

const gameOnly = { current_level: 10, verified_level: 1 };   // never verified
const verified = { current_level: 1,  verified_level: 7 };   // verified higher than the score

ok('a Level 10 game score with no verification does not show the build',
   !unlocks.showsBuild(gameOnly), 'current_level is the score, not the claim');
ok('a verified Level 3 does', unlocks.showsBuild({ verified_level: 3 }));
ok('a verified Level 2 does not', !unlocks.showsBuild({ verified_level: 2 }));

ok('a Level 10 game score with no verification is not a mentor',
   !unlocks.isMentor(gameOnly));
ok('a verified Level 7 is', unlocks.isMentor(verified));
ok('...unless they turned it off',
   !unlocks.isMentor({ ...verified, mentor_available: false }),
   'being listed as available to help is declinable');
ok('a verified Level 6 is not', !unlocks.isMentor({ verified_level: 6 }));

// Reading verified_level would strand every existing member at 1 without a
// backfill — they would lose a showcase they already had.
ok('the migration backfills verified_level from current_level',
   /update profiles[\s\S]*set verified_level[\s\S]*current_level/.test(sql));
ok('...and never lowers anyone', /greatest\(/.test(sql));
ok('...and does not hand out unverified Level 8+', /least\(coalesce\(current_level, 1\), 7\)/.test(sql));

// ---------------------------------------------------------------------------
// 4. No unlock promises something nothing delivers.

console.log('\nEvery unlock is either delivered or honestly labelled:');

const all = Object.entries(unlocks.UNLOCKS);
ok('every unlock declares how it is delivered',
   all.every(([, us]) => us.every(u => u.kind === 'live' || u.kind === 'manual')));

// The live ones are the contract: each must be something a function in this
// file actually decides. Add a live unlock and you have to add its check here,
// which is the point — Level 7 sat as 'manual' with nothing arranging it.
const DELIVERED = { 3: 'showsBuild', 7: 'isMentor' };
for (const [level, us] of all) {
  for (const u of us) {
    if (u.kind !== 'live') continue;
    ok(`Level ${level} "${u.label}" is delivered by ${DELIVERED[level] || '???'}()`,
       !!DELIVERED[level] && typeof unlocks[DELIVERED[level]] === 'function',
       DELIVERED[level] ? 'ok' : 'a live unlock with no code behind it');
  }
}
ok('Level 7 is no longer an unarranged promise',
   unlocks.forLevel(7).every(u => u.kind === 'live'),
   'it advertised a mentor track that opened no request and notified nobody');

// Reaching a rung has to say what it gave you: the dashboard only previews the
// unlocks of the level you are climbing toward, so arriving used to clear them
// off the screen.
const xpSrc = fs.readFileSync(path.join(ROOT, 'src/xp.js'), 'utf8');
ok('reaching a level announces its live unlocks',
   /unlocks\.forLevel\(level\)[\s\S]{0,120}kind === 'live'/.test(xpSrc));
ok('...and only the live ones', !/forLevel\(level\)\)\s*\{[\s\S]{0,80}push_notification/.test(xpSrc));

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
