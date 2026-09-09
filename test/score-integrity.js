// Tests for the one thing a player must not be able to write: their own score.
//
// Every number the game is played for used to be writable by the player.
// awardXP() ran under the member's own credentials, so everything it touched
// was reachable from a hand-rolled request with their own token. Both doors,
// confirmed against production in a rolled-back transaction as a non-admin:
//
//     insert into xp_events (user_id, amount, reason)
//     values (me, 999999, 'I am very good at business');   -- xp_total: 999999
//
//     update profiles set xp_total = 500000, current_level = 10,
//                         tasks_completed = 4242 where id = me;   -- all applied
//
// The fix moves the decisions into the database: xp_award_kinds says what an
// action is worth, level_reached() reads the ladder and the member's actual
// completions to decide the rung, and profiles' score columns are writable only
// under a flag that award_xp_for() and bump_streak_for() set.
//
// That buys safety at the cost of a second copy of the ladder, and a price list
// that has to keep up with the code that calls it. Those are the two things
// this file holds, because the test suite has no network and cannot ask the
// database anything:
//
//   1. the ladder seeded into SQL is byte-identical to what the generator emits
//      from src/ladders.js, and
//   2. every award code any route passes exists in the price list, with an
//      amount that matches what that call site used to hard-code.
//
//   node test/score-integrity.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const MIGRATION = 'migrations/2026-09-09_the_score_is_server_owned.sql';
const sql = read(MIGRATION);

// ---------------------------------------------------------------------------
console.log('\nThe ladder in SQL is the ladder in src/ladders.js:');

const seeded = sql.slice(sql.indexOf('--!ladder-seed-start') + 21, sql.indexOf('--!ladder-seed-end'));
const generated = execFileSync(process.execPath, [path.join(ROOT, 'scripts/gen_ladder_sql.js')],
                               { encoding: 'utf8' });
ok('the seed is exactly what the generator emits', seeded === generated,
   seeded === generated ? `${seeded.split('\n').length - 2} rungs`
     : 'run `node scripts/gen_ladder_sql.js` and paste it back between the markers');

const ladders = require('../src/ladders');
const expectedRungs = ladders.SLUGS.concat([ladders.DEFAULT_PATH])
  .reduce((n, p) => n + ladders.ladderFor(p).length, 0);
ok('every path and rung made it in', (seeded.match(/^\s+\('/gm) || []).length === expectedRungs,
   `${(seeded.match(/^\s+\('/gm) || []).length} of ${expectedRungs}`);

// level_reached() re-implements ladders.meetsRung() in SQL. The shape of that
// rule is what makes a rung mean something, so it is asserted rather than
// assumed: enough XP AND enough gates, and never a demotion.
ok('SQL requires the rung\'s XP floor', /exit when v_xp < r\.xp_required/.test(sql));
ok('SQL requires the rung\'s gates', /exit when v_hits < v_need/.test(sql));
ok('SQL honours min_gates the way meetsRung does',
   /least\(coalesce\(r\.min_gates, jsonb_array_length\(r\.gates\)\), jsonb_array_length\(r\.gates\)\)/.test(sql),
   'min, capped at the number of gates');
ok('SQL never lowers a level anyone reached', /greatest\(v_level, v_current\)/.test(sql));
ok('gates are matched against real completion rows, not anything the client sent',
   /from challenge_completions/.test(sql) && /from user_milestones/.test(sql));

// ---------------------------------------------------------------------------
console.log('\nEvery award the app makes has a price the server sets:');

// What the price list declares.
const kinds = {};
const priceBlock = sql.slice(sql.indexOf('insert into xp_award_kinds'));
for (const m of priceBlock.slice(0, priceBlock.indexOf('on conflict')).matchAll(
       /\('([a-z0-9_]+)',\s*(null|\d+),\s*(null|'[a-z_]+'),\s*(\d+)/g)) {
  kinds[m[1]] = { amount: m[2] === 'null' ? null : Number(m[2]),
                  from: m[3] === 'null' ? null : m[3].replace(/'/g, ''),
                  max: Number(m[4]) };
}
ok('the price list parsed', Object.keys(kinds).length >= 15, Object.keys(kinds).length + ' codes');

// What the app actually asks for.
const srcFiles = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) srcFiles.push(p);
  }
})(path.join(ROOT, 'src'));

const used = [];
for (const f of srcFiles) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/awardXP\([^,]+,[^,]+,[^,]+,\s*'([a-z0-9_]+)'/g)) {
    used.push({ code: m[1], file: path.relative(ROOT, f) });
  }
}
ok('found the award call sites', used.length >= 20, used.length + ' calls');
const unknown = used.filter(u => !kinds[u.code]);
ok('every code a route passes is in the price list', unknown.length === 0,
   unknown.map(u => `${u.code} (${u.file})`).join(', ') || `${new Set(used.map(u => u.code)).size} distinct codes`);

// A code passed as a variable would slip past the check above and blow up at
// runtime with "unknown award code", so the fourth argument has to be a literal.
const dynamic = [];
for (const f of srcFiles) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/awardXP\(([^;]{0,200}?)\)/g)) {
    const args = m[1].split(',');
    if (args.length >= 4 && !/^\s*'[a-z0-9_]+'\s*$/.test(args[3])
        && !/code, reason/.test(m[1])) dynamic.push(path.relative(ROOT, f) + ': ' + args[3].trim());
  }
}
ok('no call site passes a computed code', dynamic.length === 0, dynamic.join('; ') || 'all literal');

// The amounts that used to be hard-coded at the call sites. Kept here so the
// rebalance is a decision someone makes on purpose rather than a diff nobody
// notices — change a price and this line is what makes you say so.
const WAS = {
  compass_drawn: 25, idea_drafted: 15, blueprint_created: 50, blueprint_dispersed: 15,
  quest_accepted: 5, peer_review_given: 60, win_featured: 25, forum_thread: 10,
  forum_reply: 5, beta_joined: 15, sprint_started: 30, sprint_task_done: 10,
  task_done: 10, daily_checkin: 15
};
const moved = Object.entries(WAS).filter(([c, v]) => kinds[c] && kinds[c].amount !== v);
ok('the fixed prices are the ones the call sites used to pass', moved.length === 0,
   moved.map(([c, v]) => `${c}: was ${v}, now ${kinds[c].amount}`).join('; ') || `${Object.keys(WAS).length} unchanged`);

// The peer-review row records what it paid. It reads a constant in the route,
// and the award now reads the price list — two numbers that must not diverge.
const reviewSrc = read('src/routes/reviews.js');
const REVIEW_XP = Number((reviewSrc.match(/const REVIEW_XP = (\d+)/) || [])[1]);
ok('REVIEW_XP matches what peer_review_given pays', REVIEW_XP === kinds.peer_review_given.amount,
   `route records ${REVIEW_XP}, server pays ${kinds.peer_review_given.amount}`);

// Entity-priced codes read xp_reward off a row. Two of those tables are the
// member's own — a tailored quest and an AI goal are rows they can PATCH — so
// the ceiling is the only thing between that and minting.
for (const [code, k] of Object.entries(kinds).filter(([, k]) => k.amount === null)) {
  ok(`${code} reads ${k.from} and is capped at ${k.max}`, !!k.from && k.max > 0 && k.max <= 900);
}
ok('the amount comes from a fixed table name, never a parameter',
   /format\('select coalesce\(xp_reward, 0\) from %I where id = \$1', v_kind\.amount_from\)/.test(sql),
   'the code chooses the table; the caller never names one');

// ---------------------------------------------------------------------------
console.log('\nBoth doors stay shut:');

ok('the member cannot insert their own XP events', /drop policy if exists xp_events_insert on xp_events/.test(sql));
for (const col of ['xp_total', 'current_level', 'streak_days', 'longest_streak',
                   'tasks_completed', 'last_checkin_date', 'streak_freeze_used_month']) {
  ok(`${col} is reverted on an untrusted write`,
     new RegExp('new\\.' + col + '\\s*:=\\s*old\\.' + col).test(sql));
}
ok('the trusted flag is transaction-local', /set_config\('app\.trusted_write', 'on', true\)/.test(sql),
   'the third argument is what stops it leaking into the next request on the connection');
ok('award_xp_for acts on auth.uid()', /v_user := auth\.uid\(\)/.test(sql));
ok('...and only an admin may award to somebody else',
   /if not is_admin\(\) then raise exception 'not allowed to award to another member'/.test(sql));
ok('the RPCs are granted to authenticated and nobody else',
   /revoke all on function public\.award_xp_for[\s\S]*?from public, anon/.test(sql)
   && /grant execute on function public\.award_xp_for[\s\S]*?to authenticated/.test(sql));
ok('the streak is computed server-side too', /create or replace function public\.bump_streak_for/.test(sql));

// The old sqrt-based promotion must not come back with the trigger.
ok('the XP trigger still has no opinion about levels',
   !/current_level\s*=\s*GREATEST\(1, FLOOR\(SQRT/i.test(sql));

// awardXP's signature changed from an amount to a code. A call site left on the
// old shape would pass a number where a code goes and fail at the database.
const numeric = [];
for (const f of srcFiles) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/awardXP\([^,]+,[^,]+,[^,]+,\s*(\d+|[A-Z_]+|[a-z]+\.[a-z_]+)/g)) {
    numeric.push(path.relative(ROOT, f) + ': ' + m[1]);
  }
}
ok('no call site still passes an amount', numeric.length === 0, numeric.join('; ') || 'clean');

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
