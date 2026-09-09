// Tests for who is allowed to write what.
//
// Four findings from the security audit, all reproduced against production as
// an ordinary non-admin member before they were closed:
//
//   1. A peer_reviews row is either a REQUEST (request_id null) or a REVIEW of
//      one. Both policies treated the table as one shape — `submitter_id =
//      auth.uid() or reviewer_id = auth.uid()` — and peer_reviews_bind_submitter
//      copies submitter_id onto a review from its parent. So on your own
//      request the submitter branch passes, and you could insert a review
//      naming anyone as its reviewer. Three fabricated reviews attributed to
//      three real members cleared Level 2's peer-review gate.
//   2. The same shape on UPDATE let the person whose work was reviewed rewrite
//      what the reviewer said, with it still attributed to them: rating 1 and
//      "Honestly, this will not work." became rating 5 and "Amazing, I would
//      invest today."
//   3. refund_ai_credits(p_kind) added credits back with nothing checking a
//      spend had happened. Drained to 0, forty-three calls took it back to the
//      plan cap. Spend to zero, refund to cap, repeat.
//   4. notify_social(actor uuid, ...) never looked at auth.uid(), so anyone
//      could fan a message of their choosing out to another member's followers,
//      as that member.
//
// The suite has no network, so what is held here is the shape of the rules in
// the migration and the fact that the routes stopped relying on the latitude
// that was removed.
//
//   node test/permissions.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const sql = read('migrations/2026-09-09_audit_fixes_review_forgery_credits_and_impersonation.sql');

// ---------------------------------------------------------------------------
console.log('\nA request and a review are different rows with different owners:');

const ins = sql.slice(sql.indexOf('create policy peer_reviews_insert'));
const insBody = ins.slice(0, ins.indexOf(');'));
ok('the insert policy branches on which kind of row it is', /case when request_id is null/.test(insBody));
ok('a request must be your own, and carry no reviewer',
   /submitter_id = auth\.uid\(\) and reviewer_id is null/.test(insBody));
ok('a review must be written by you', /else reviewer_id = auth\.uid\(\)/.test(insBody),
   'submitter_id is bound from the parent, so it can never be the test');
// Read from the statements only — the migration quotes the old rule in its
// comments, which is where the reasoning for replacing it lives.
const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
ok('the old either/or rule is gone',
   !/auth\.uid\(\) = submitter_id or auth\.uid\(\) = reviewer_id/.test(statements));

const upd = sql.slice(sql.indexOf('create policy peer_reviews_update'));
const updBody = upd.slice(0, upd.indexOf(');'));
ok('the update policy branches the same way', /case when request_id is null/.test(updBody));
ok('...and carries a WITH CHECK, not only a USING', /using \([\s\S]*?\) with check \(/.test(updBody),
   'without one the new row is only held to the old row\'s test');
const branches = [...updBody.matchAll(/case when request_id is null then submitter_id = auth\.uid\(\) else reviewer_id = auth\.uid\(\) end/g)];
ok('...and both halves say the same thing', branches.length === 2, branches.length + ' matching branches');

// The request's status used to be written by the reviewer onto the submitter's
// row. That cross-user write is the only reason the policy had to be loose.
console.log('\nNobody writes anybody else\'s row to keep a status up to date:');
ok('the status is derived by a trigger', /create trigger peer_reviews_sync_request_status_trg/.test(sql));
ok('...after a review lands', /after insert on peer_reviews/.test(sql));
ok('...and a withdrawn request stays withdrawn', /status <> 'withdrawn'/.test(sql));

const reviews = read('src/routes/reviews.js');
ok('the route no longer writes the request status itself',
   !/SESSIONS_NEEDED \? 'completed'/.test(reviews),
   'that update ran as the REVIEWER, against the submitter\'s row');
ok('...though the submitter can still withdraw their own request',
   /\.update\(\{ status: 'withdrawn'/.test(reviews));

// Three places now hold the number three. They have to agree, or the gate opens
// at a different count from the one the request is marked complete at.
const NEEDED = Number((reviews.match(/const SESSIONS_NEEDED = (\d+)/) || [])[1]);
const gate = read('migrations/2026-09-09_completions_and_trophies_are_earned.sql');
ok('the route, the gate and the trigger agree on three reviews',
   NEEDED === 3 && /v_ok := v_n >= 3/.test(gate) && /v_done >= 3/.test(sql),
   `route ${NEEDED}, gate 3, trigger 3`);

// ---------------------------------------------------------------------------
console.log('\nA refund has to answer a spend:');

ok('a refund counts the spends it could be answering',
   /select count\(\*\) into v_spends from ai_spend[\s\S]{0,200}kind = p_kind\b/.test(sql));
ok('...and the refunds already given for them',
   /select count\(\*\) into v_refunds from ai_spend[\s\S]{0,200}p_kind \|\| ':refund'/.test(sql));
ok('...and refuses when there is nothing left to give back',
   /if v_spends <= v_refunds then[\s\S]{0,120}'nothing_to_refund'/.test(sql));
ok('the window matches how the rail actually works',
   (sql.match(/interval '15 minutes'/g) || []).length >= 2,
   'charge, call, refund on throw — all inside seconds');
ok('the refund still cannot push a balance past the plan cap',
   /least\(balance \+ v_cost, v_cap\)/.test(sql));
ok('...and is still logged as a negative row', /p_kind \|\| ':refund', -v_cost/.test(sql),
   'which is also what makes a second refund of one spend impossible');

// src/credits.js is the only thing that should ever refund, and only after it
// charged. If it ever refunds without charging first, the window check will
// silently start failing in production instead of here.
const credits = read('src/credits.js');
ok('the rail charges before it runs and refunds only on a throw',
   /spend/.test(credits) && /refund/.test(credits));

// ---------------------------------------------------------------------------
console.log('\nYou can only speak as yourself:');

ok('notify_social checks that you are signed in', /if auth\.uid\(\) is null then raise exception/.test(sql));
ok('...and that the actor is you', /actor is distinct from auth\.uid\(\)/.test(sql));
ok('...with admins the one exception', /and not is_admin\(\) then[\s\S]{0,90}cannot post activity as another member/.test(sql),
   'an admin featuring a win can level its owner up and announce it for them');

// Every call site passes the acting member. A call that passes somebody else
// would now throw at runtime rather than fanning out.
const srcFiles = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) srcFiles.push(p);
  }
})(path.join(ROOT, 'src'));
const actors = new Set();
for (const f of srcFiles) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/(?<!function )notifySocial\([^,]+,\s*([^,]+),/g)) actors.add(m[1].trim());
}
const strangers = [...actors].filter(a => !/^(req\.user\.id|userId)$/.test(a));
ok('every call site posts as the acting member', strangers.length === 0,
   strangers.join(', ') || [...actors].join(', '));

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
