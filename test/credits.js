// Guards for the AI credit rail and the coach's context.
//
// The rail's arithmetic lives in Postgres and is tested there (see the
// migration notes — running spend_ai_credits() against real profiles is what
// caught the legacy-balance and upgrade-mid-month bugs). What can only be
// tested here is the thing that would quietly undo it: a new AI call added to a
// route that forgets to go through credits.run().
//
//   node test/credits.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
// 1. Every AI call is metered.
//
// This is the guard that matters. The rail is only worth anything if nothing
// routes around it, and the easy mistake is not removing credits.run() — it is
// adding the eleventh AI function and calling it directly, which looks exactly
// like the ten that came before it did before this file existed.

console.log('\nEvery AI call goes through the rail:');

const ai = require('../src/ai');
// The functions in ai.js that actually reach the model. hasKey/pathOf and the
// prompt builders do not, so they are excluded by taking only what the module
// exports as an async function that takes a token first.
const AI_CALLS = Object.keys(ai).filter(k => typeof ai[k] === 'function'
  && !['hasKey', 'pathOf'].includes(k));
ok('found the AI entry points in ai.js', AI_CALLS.length > 0, AI_CALLS.join(', '));

const routeDir = path.join(ROOT, 'src/routes');
const scanned = fs.readdirSync(routeDir).filter(f => f.endsWith('.js'))
  .map(f => ({ file: 'src/routes/' + f, src: fs.readFileSync(path.join(routeDir, f), 'utf8') }))
  .concat(['src/tailor.js', 'src/coach.js'].map(f => ({ file: f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') })));

// A call is metered if `credits.run(` appears within the 220 characters before
// it — that is the wrapper form every call site uses. Generous enough for the
// two-line wrapped calls, tight enough that a call in a different function does
// not count as covering it.
//
// The one other shape that counts is a HAND-ROLLED spend: the Compass debits
// once for 'compass' and then makes two model calls under it (the market scan
// and the Compass itself), because the first Compass is free and the debit has
// to sit behind a conditional. A file only gets that latitude if it does the
// whole job by hand — spend AND refund — so forgetting the refund still fails
// here rather than reading as an exemption.
const handRolled = src => /credits\.spend\s*\(/.test(src) && /credits\.refund\s*\(/.test(src);

const unmetered = [];
for (const { file, src } of scanned) {
  const byHand = handRolled(src);
  for (const fn of AI_CALLS) {
    const re = new RegExp('\\bai\\.' + fn + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 220), m.index);
      if (!/credits\.run\s*\(/.test(before) && !byHand) {
        unmetered.push(file + ':' + (src.slice(0, m.index).split('\n').length) + ' ai.' + fn);
      }
    }
  }
}
ok('no ai.* call is made outside credits.run()', unmetered.length === 0,
   unmetered.join(', ') || `${AI_CALLS.length} entry points, all wrapped`);

// compass_ai.js is a second module that reaches the model, and the Compass and
// the advisor are the two most expensive calls in the product.
const compassCalls = [];
for (const { file, src } of scanned) {
  const re = /\bcai\.(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 260), m.index);
    // generateCompass is the deliberate exception: the FIRST Compass is free
    // and unmetered on any plan, so its route spends by hand (and refunds by
    // hand) around a conditional rather than through the wrapper. Same rule as
    // above — the refund has to be there too.
    const byHand = handRolled(src);
    if (!/credits\.run\s*\(/.test(before) && !byHand) {
      compassCalls.push(file + ' cai.' + m[1]);
    }
  }
}
ok('no compass_ai call is made outside the rail', compassCalls.length === 0,
   compassCalls.join(', ') || 'clean');

// A hand-rolled spend must always have a matching refund, or a failed call
// costs the member credits for nothing.
const compassSrc = fs.readFileSync(path.join(ROOT, 'src/routes/compass.js'), 'utf8');
ok('the hand-rolled Compass spend has a matching refund',
   /credits\.spend\(sb, 'compass'\)/.test(compassSrc) && /credits\.refund\(sb, 'compass'\)/.test(compassSrc),
   'spend + refund both present');

// ---------------------------------------------------------------------------
// 2. The rail cannot be talked out of a refusal.
//
// credits.run() must throw when the balance will not cover the call. The bug
// this guards is the tempting one: treating an unreachable rail as a free pass
// so the feature "still works" when the RPC errors.

console.log('\nThe rail fails closed:');

const credits = require('../src/credits');

const fakeSb = (result) => ({ rpc: async () => result });

(async () => {
  let ran = false;
  try {
    await credits.run(fakeSb({ data: { ok: false, reason: 'insufficient', plan: 'free', balance: 1, cost: 6, cap: 20, visible: true } }),
      'compass', async () => { ran = true; return 'nope'; });
    ok('an insufficient balance stops the call', false, 'it ran anyway');
  } catch (e) {
    ok('an insufficient balance stops the call', !ran && e.outOfCredits === true, e.message);
  }

  ran = false;
  try {
    await credits.run(fakeSb({ error: { message: 'connection refused' } }),
      'compass', async () => { ran = true; return 'nope'; });
    ok('an unreachable rail stops the call too', false, 'it ran anyway');
  } catch (e) {
    ok('an unreachable rail stops the call too', !ran && e.outOfCredits !== true, e.message);
  }

  // The refund path: a call that throws must give the credits back.
  let refunded = null;
  const sb = {
    rpc: async (fn, args) => {
      if (fn === 'refund_ai_credits') { refunded = args.p_kind; return { data: { ok: true } }; }
      return { data: { ok: true, plan: 'free', balance: 14, cost: 6, cap: 20, visible: true } };
    }
  };
  try {
    await credits.run(sb, 'compass', async () => { throw new Error('edge function died'); });
  } catch (_) { /* expected */ }
  ok('a call that throws is refunded', refunded === 'compass', refunded || 'nothing refunded');

  // ...and one that succeeds is not.
  refunded = null;
  const out = await credits.run(sb, 'coach', async () => 'an answer');
  ok('a call that succeeds is not refunded', refunded === null && out === 'an answer', String(refunded));

  // -------------------------------------------------------------------------
  // 3. The coach's context survives a member who has answered nothing.
  //
  // That member is not an edge case — they are exactly who opens the coach
  // first, and a brief() that throws on a null idea or a missing ladder takes
  // the whole page with it.

  console.log('\nThe coach brief holds up on a bare account:');

  const coach = require('../src/coach');
  const bare = {
    name: 'there', pathLabel: 'not chosen yet', subpathLabel: null,
    level: 1, topLevel: 10, rungTitle: '', next: null, quests: [],
    needMin: 0, xpNeeded: 0, hours: null, runway: null, budget: null,
    dealBreakers: null, streak: 0, bar: null, idea: null,
    fitResults: [], fitTest: [], lastWeek: null, checkins: []
  };
  let bareBrief = null;
  try { bareBrief = coach.brief(bare); } catch (e) { /* caught below */ }
  ok('brief() does not throw with nothing answered', typeof bareBrief === 'string', bareBrief === null ? 'threw' : `${bareBrief.split('\n').length} lines`);
  ok('...and does not claim they are at the top of the ladder',
     bareBrief !== null && !/top of their ladder/.test(bareBrief),
     'a null next rung means unknown, not finished');

  // The opposite end: someone genuinely at the top.
  const topped = { ...bare, level: 10, rungTitle: 'Institution' };
  ok('...but does say so when they actually are', /top of their ladder/.test(coach.brief(topped)), 'Level 10');

  // The facts that make this worth paying for have to reach the prompt.
  const full = {
    ...bare, pathLabel: 'Local service', subpathLabel: 'Plumbing',
    level: 4, rungTitle: 'Quoting', next: { level: 5, title: 'First Invoice' },
    quests: [{ title: 'Send 3 quotes', done: false }, { title: 'Get 3 Feedback Sessions', done: true }],
    needMin: 2, hours: '5-10 hours', dealBreakers: 'cold calling',
    lastWeek: { total: 3, done: 1, items: [{ title: 'Price sheet', done: true }, { title: 'Message 4 people', done: false }] }
  };
  const b = coach.brief(full);
  const wanted = ['Plumbing', 'Level 4 — Quoting', 'STILL BLOCKING', 'Send 3 quotes', '5-10 hours', 'cold calling', 'LAST WEEK'];
  const missing = wanted.filter(w => !b.includes(w));
  ok('every fact the coach is sold on reaches the prompt', missing.length === 0, missing.join(', ') || wanted.length + ' facts');
  ok('a cleared quest is not listed as still blocking',
     !/STILL BLOCKING[^\n]*Feedback Sessions/.test(b), 'cleared quests move to "already cleared"');

  // -------------------------------------------------------------------------
  // 4. Weeks are Monday-anchored, and last week really is last week.
  //
  // If these drift, the plan is written against the wrong week's results and
  // the whole "reads last week before writing this week" claim quietly stops
  // being true — silently, because every value still looks like a date.

  console.log('\nWeeks line up:');
  const thisM = new Date(coach.thisMonday() + 'T00:00:00');
  const lastM = new Date(coach.lastMonday() + 'T00:00:00');
  ok('this week starts on a Monday', thisM.getDay() === 1, coach.thisMonday());
  ok('last week starts on a Monday', lastM.getDay() === 1, coach.lastMonday());
  ok('last week is exactly seven days before this one',
     (thisM - lastM) === 7 * 24 * 3600 * 1000, ((thisM - lastM) / 86400000) + ' days');
  ok('today is inside this week', Date.now() >= thisM.getTime() && Date.now() < thisM.getTime() + 7 * 86400000, 'ok');

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})();
