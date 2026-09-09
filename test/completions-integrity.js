// Tests for the two tables a rung is decided from.
//
// level_reached() reads challenge_completions and user_milestones to decide
// what rung somebody is on. Both had an INSERT policy of `auth.uid() = user_id`
// — which checks who you are, never what you did — so the row saying you
// finished a quest could be written without finishing it. A more visible lie
// than a silent number, because a forged completion shows on the profile, but
// the same lie.
//
// user_milestones was worse than an insert. It carried UPDATE and DELETE
// policies nothing in the app has ever used, and one of its columns,
// custom_title, is matched directly against a gate title. So a trophy somebody
// legitimately held could be retitled into whichever gate they were short of.
//
// Four functions now own those writes, each re-deriving its condition rather
// than trusting that a route checked it. What this file holds is that the
// conditions did not get left behind in JS, and that the routes actually go
// through the door.
//
//   node test/completions-integrity.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const sql = read('migrations/2026-09-09_completions_and_trophies_are_earned.sql');

// ---------------------------------------------------------------------------
console.log('\nThe writes go through the door, not around it:');

// Nothing in src/ may write these two tables directly any more. The RPC bodies
// live in SQL; a `.insert(` on either table in JS would be a write that the
// database will now refuse at runtime, silently, in a route.
const srcFiles = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) srcFiles.push(p);
  }
})(path.join(ROOT, 'src'));

for (const table of ['challenge_completions', 'user_milestones']) {
  const writers = [];
  for (const f of srcFiles) {
    const s = fs.readFileSync(f, 'utf8');
    const rx = new RegExp(`from\\('${table}'\\)\\s*\\n?\\s*\\.(insert|update|upsert|delete)`, 'g');
    if (rx.test(s)) writers.push(path.relative(ROOT, f));
  }
  ok(`nothing in src/ writes ${table} directly`, writers.length === 0,
     writers.join(', ') || 'reads only');
}

for (const [route, rpc] of [
  ['src/routes/challenges.js', 'complete_quest_for'],
  ['src/routes/reviews.js',    'complete_review_quest_for'],
  ['src/routes/milestones.js', 'claim_trophy_for'],
  ['src/milestones_engine.js', 'sweep_trophies_for']
]) {
  ok(`${path.basename(route)} calls ${rpc}`, read(route).includes(`'${rpc}'`));
}

// ---------------------------------------------------------------------------
console.log('\nEvery condition moved, none stayed behind:');

ok('finishing a quest still needs an active acceptance',
   /a\.status is distinct from 'active'[\s\S]{0,120}'not_active'/.test(sql));
ok('a proof-gated quest still needs 25 characters of proof',
   /requires_proof[\s\S]{0,80}length\(v_proof\) < 25/.test(sql),
   'the same bar the route used to check');
ok('a big quest finished within a day of accepting is still flagged',
   /xp_reward, 0\) >= 150[\s\S]{0,120}interval '1 day'/.test(sql),
   'flagged for review, not blocked');
ok('a trophy claim still needs 30 characters of account',
   /length\(v_note\) < 30/.test(sql));
ok('a trophy can still only be claimed if it is claimable',
   /where id = p_milestone_id and is_active and is_claimable/.test(sql));
ok('claiming twice is still refused', /'already'/.test(sql));

// The peer-review quests are the two that must not become "complete anything by
// name". Each branch names its quest and recounts the rows that earn it.
const reviews = read('src/routes/reviews.js');
for (const c of ['GATE_CHALLENGE', 'GIVER_CHALLENGE']) {
  const title = (reviews.match(new RegExp(`const ${c} = '([^']+)'`)) || [])[1];
  ok(`${c} (${title}) is the title the function completes`, !!title && sql.includes(`'${title}'`),
     'JS and SQL must name the same quest');
}
const NEEDED = Number((reviews.match(/const SESSIONS_NEEDED = (\d+)/) || [])[1]);
ok('SESSIONS_NEEDED matches what the gate counts', NEEDED === 3 && /v_ok := v_n >= 3/.test(sql),
   `route says ${NEEDED}, SQL requires 3`);
ok('the giver quest needs a review you actually wrote',
   /reviewer_id = v_user and status = 'completed'/.test(sql));
ok('the gate needs reviews other people wrote about your work',
   /submitter_id = v_user and status = 'completed' and request_id is not null/.test(sql));
ok('an unrecognised review quest is refused, not completed',
   /raise exception 'unknown review quest %'/.test(sql),
   'otherwise this is "complete any quest by name" with a tidy signature');

// ---------------------------------------------------------------------------
console.log('\nThe sweep counts once, in one place:');

// computeMetrics() used to live in JS beside the insert. Both moved; if the JS
// copy comes back, the trophy case's progress bars and what it awards can
// disagree.
const engine = read('src/milestones_engine.js');
ok('the engine no longer counts anything itself',
   !/(async )?function computeMetrics/.test(engine) && !/count: 'exact'/.test(engine),
   'the RPC returns the metrics it awarded on');
ok('...and renders the metrics the sweep actually used', /res\.metrics/.test(engine));

// The fifteen kinds the definitions can carry. A kind with no branch in SQL
// reads as 0 and its trophy never unlocks.
const AUTO_KINDS = [
  'blueprints', 'challenges', 'checkins', 'followers', 'idea_fit_pct', 'ideas',
  'ideas_cut', 'posts', 'profile', 'questionnaire', 'signals', 'sprints_done',
  'sprints_started', 'streak', 'tasks'
];
const missing = AUTO_KINDS.filter(k => !new RegExp(`'${k}',`).test(sql));
ok('every auto_kind is counted', missing.length === 0,
   missing.join(', ') || `all ${AUTO_KINDS.length}`);

// The two that are not plain counts, and the reasons they are not.
ok('idea_fit_pct is the best percentage on any idea, not a count',
   /coalesce\(max\(best_fit_pct\), 0\)/.test(sql),
   'revising into a worse score must never take a trophy back');
ok('signals are counted per idea, not summed across them',
   /max\(c\)[\s\S]{0,120}group by idea_id/.test(sql),
   'three pieces of evidence for ONE idea, not one each on three');
ok('a sprint with every task done counts as done',
   /tasks_done, 0\) >= tasks_total/.test(sql));
ok('the sweep survives a race rather than dropping the trophy',
   /exception when unique_violation/.test(sql));

// ---------------------------------------------------------------------------
console.log('\nThe doors:');

ok('members cannot insert their own completions',
   /drop policy if exists completions_insert on challenge_completions/.test(sql));
ok('members cannot insert their own trophies',
   /drop policy if exists user_milestones_insert on user_milestones/.test(sql));
ok('...nor retitle one into a gate they are short of',
   /drop policy if exists user_milestones_update on user_milestones/.test(sql),
   'custom_title is matched against gate titles by level_reached()');
ok('...nor delete one', /drop policy if exists user_milestones_delete on user_milestones/.test(sql));
for (const fn of ['complete_quest_for', 'complete_review_quest_for', 'claim_trophy_for',
                  'sweep_trophies_for', 'is_paid_member']) {
  ok(`${fn} is granted to authenticated and nobody else`,
     new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public, anon`).test(sql)
     && new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to authenticated`).test(sql));
  ok(`...and ${fn} acts on the caller`,
     fn === 'is_paid_member' || new RegExp(`${fn}[\\s\\S]{0,400}?auth\\.uid\\(\\)`).test(sql));
}

// `pinned` used to be passed up by the route from the member's own client.
ok('pinned is decided from the plan, not from the request',
   /v_paid := is_paid_member\(v_user\)/.test(sql) && !/pinned: isPaid\(req\)/.test(read('src/routes/milestones.js')));

// is_paid_member mirrors planOf(). Both cases that are easy to miss are the
// ones that matter: a cancelled subscription is paid until the period ends,
// and an active one with no end date is paid.
ok('is_paid_member treats a cancelled-but-unexpired plan as paid',
   /subscription_status in \('active', 'canceled', 'trialing'\)/.test(sql));
ok('...and an active plan with no end date as paid',
   /subscription_status = 'active' and p\.subscription_period_end is null/.test(sql));
const planOf = read('src/middleware/auth.js');
ok('...the same three statuses planOf() accepts',
   /'active' \|\| status === 'canceled' \|\| status === 'trialing'/.test(planOf));
ok('...and lifetime and admin count in both',
   /is_admin \|\| profile\.is_lifetime/.test(planOf) && /p\.is_admin or p\.is_lifetime/.test(sql));

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
