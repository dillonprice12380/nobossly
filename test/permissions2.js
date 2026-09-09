// The second half of the security audit: consent, scope and ceilings.
//
// Findings 5-10, each reproduced against production as an ordinary non-admin
// member before it was closed:
//
//   5.  friends_update was `requester_id = auth.uid() or addressee_id =
//       auth.uid()` — right for reading, wrong for answering. A sent their own
//       request and then accepted it. Friendship is not cosmetic: notify_social
//       fans out to friends as well as followers.
//   6.  verification_requests were inserted from src/xp.js under the member's
//       own credentials, so one could be filed by hand at level 10 with no
//       rungs behind it — and vr_own_update_pending let the level be edited
//       while it sat in the queue. Approving it sets verified_level, which
//       decides the Level 3 showcase and the Level 7 mentor listing.
//   7.  `res.redirect(req.body.back || referer)` across the social routes: a
//       real NoBossly form that lands the member on someone else's login page.
//   8.  The uploads bucket was public with no size or type limit, .svg was
//       allowed, and the content type came from the client.
//   9.  peer_reviews_select was `true` — every request and every candid opinion
//       readable by anyone, signed out included.
//   10. push_notification could reach any member, any number of times.
//
//   node test/permissions2.js

const fs = require('fs');
const path = require('path');
const { safeBack, relativePath } = require('../src/safe_back');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const sql = read('migrations/2026-09-09_audit_fixes_consent_scope_and_limits.sql');

// ---------------------------------------------------------------------------
console.log('\nAnswering a friend request belongs to the person who got it:');
ok('a trigger guards the transition', /create trigger friendships_guard_trg before update on friendships/.test(sql));
ok('only the addressee may move the status',
   /new\.status is distinct from old\.status and auth\.uid\(\) is distinct from old\.addressee_id/.test(sql));
ok('...and who it is between never changes',
   /new\.requester_id := old\.requester_id/.test(sql) && /new\.addressee_id := old\.addressee_id/.test(sql));

console.log('\nA verification request is filed by the ladder, not by the applicant:');
ok('the member cannot insert one', /drop policy if exists vr_own_insert on verification_requests/.test(sql));
ok('award_xp_for files it from the level it just worked out',
   /if v_level >= 8 and v_level > v_was_level then[\s\S]{0,160}insert into verification_requests \(user_id, level\) values \(v_user, v_level\)/.test(sql));
ok('...idempotently', /insert into verification_requests[\s\S]{0,120}on conflict do nothing/.test(sql));
ok('the level and the status are immutable to the applicant',
   /new\.level   := old\.level/.test(sql) && /new\.status  := old\.status/.test(sql));
ok('...but the evidence is still theirs to attach',
   !/new\.evidence_note/.test(sql) && /verification_requests_guard/.test(sql));
ok('and src/xp.js no longer inserts one itself',
   !/from\('verification_requests'\)\s*\.insert/.test(read('src/xp.js')));

// ---------------------------------------------------------------------------
console.log('\nA back link can only be a page on this site:');
for (const [value, want] of [
  ['/members', '/members'], ['/members?tab=2', '/members?tab=2'],
  ['https://evil.example/login', null], ['//evil.example', null],
  ['/\\evil.example', null], ['javascript:alert(1)', null],
  ['/a\nSet-Cookie: x', null], ['', null], [null, null]
]) {
  ok(`${JSON.stringify(value)} -> ${JSON.stringify(want)}`, relativePath(value) === want, String(relativePath(value)));
}
const mk = (back, ref, host) => ({ body: back === undefined ? {} : { back }, get: h => h === 'referer' ? ref : (h === 'host' ? host : null) });
ok('an off-site back falls through to the caller\'s default',
   safeBack(mk('https://evil.example', null, 'nobossly.com'), '/members') === '/members');
ok('an off-site referer does too',
   safeBack(mk(undefined, 'https://evil.example/x', 'nobossly.com'), '/members') === '/members');
ok('our own referer keeps its path and query',
   safeBack(mk(undefined, 'https://nobossly.com/quests?a=1', 'nobossly.com'), '/members') === '/quests?a=1');
ok('a good back link is honoured',
   safeBack(mk('/community', null, 'nobossly.com'), '/members') === '/community');

// Nothing may redirect on a raw header or body field any more.
const srcFiles = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) srcFiles.push(p);
  }
})(path.join(ROOT, 'src'));
const raw = srcFiles.filter(f => path.basename(f) !== 'safe_back.js')
  .filter(f => /redirect\([^)]*req\.(body\.back|get\('referer'\))/.test(fs.readFileSync(f, 'utf8')))
  .map(f => path.relative(ROOT, f));
ok('no route redirects on a raw back or referer', raw.length === 0, raw.join(', ') || 'all go through safeBack');

// ---------------------------------------------------------------------------
console.log('\nAn upload is what its extension says it is:');
const up = read('src/routes/uploads.js');
ok('svg is no longer accepted', !/svg/.test(up.match(/const SAFE_EXT = [^;]+;/)[0]),
   'the bucket is public, and an SVG opened directly runs its own script');
ok('the content type comes from the extension, not the request',
   /TYPE_BY_EXT\[ext\]/.test(up) && !/contentType: req\.file\.mimetype/.test(up));
// Expand the alternation the way the regex reads it: jpe?g is jpg and jpeg,
// docx? is doc and docx. An accepted extension with no content type would be
// stored as application/octet-stream, which is not what the file is.
const exts = [];
for (const alt of (up.match(/const SAFE_EXT = \/\\\.\(([^)]+)\)/) || [])[1].split('|')) {
  const m = alt.match(/^(.*?)([a-z])\?(.*)$/);
  if (m) { exts.push(m[1] + m[3]); exts.push(m[1] + m[2] + m[3]); } else exts.push(alt);
}
const block = up.slice(up.indexOf('const TYPE_BY_EXT'));
const typed = new Set([...block.slice(0, block.indexOf('};')).matchAll(/([a-z0-9]+):\s*'/g)].map(m => m[1]));
const untyped = exts.filter(e => !typed.has(e));
ok('every accepted extension has a content type', untyped.length === 0,
   untyped.join(', ') || exts.length + ' accepted, all typed');
ok('the bucket has its own ceiling and allowlist too',
   /update storage\.buckets[\s\S]{0,200}file_size_limit = 8388608[\s\S]{0,600}allowed_mime_types/.test(sql),
   'the app is not the only thing that can write to it');

// ---------------------------------------------------------------------------
console.log('\nA review is between the two people in it:');
ok('a signed-out visitor is turned away first', /auth\.uid\(\) is not null\s*\n\s*and case when request_id is null/.test(sql),
   'and so never reaches is_admin(), which anon could not execute');
ok('the open queue stays browsable by members', /then true\s+-- the queue, for members/.test(sql));
ok('a review is visible to its two parties and admins',
   /submitter_id = auth\.uid\(\) or reviewer_id = auth\.uid\(\) or is_admin\(\)/.test(sql));
ok('anon can evaluate is_admin, so no policy errors instead of hiding a row',
   /grant execute on function public\.is_admin\(\) to anon/.test(sql),
   'wins_select would have failed the public Wins wall on the first unapproved win');

console.log('\nAnd a ceiling on what one member can send another:');
ok('notifications to somebody else are counted', /actor_id = auth\.uid\(\) and user_id <> auth\.uid\(\)/.test(sql));
ok('...over the last hour', /created_at > now\(\) - interval '1 hour'/.test(sql));
ok('...and stop at thirty', /if v_recent >= 30 then/.test(sql));
ok('notifying yourself is never limited', /target_user is distinct from auth\.uid\(\) and not is_admin\(\)/.test(sql),
   'level-ups, trophies and task reminders all go to the member themselves');

// ---------------------------------------------------------------------------
console.log('\nThe low-severity items:');

const hygiene = read('migrations/2026-09-09_audit_fixes_hygiene.sql');
ok('admin is granted only on a confirmed address',
   /lower\(u\.email\) = 'dillonprice@nobossly\.com'[\s\S]{0,80}email_confirmed_at is not null/.test(hygiene),
   'the address alone was the whole test before');
// Deliberately still open, and the file has to say so. server.js:217 calls it
// through the anon client every ten minutes for the in-app task_due
// notifications; revoking it returned 401 every ten minutes until it was put
// back. If it is ever closed for real, the caller has to move first.
ok('process_task_reminders is still callable by the sweep that needs it',
   /grant execute on function public\.process_task_reminders\(\) to anon, authenticated/.test(hygiene)
   && /setInterval/.test(read('server.js')) && /process_task_reminders/.test(read('server.js')),
   'server.js runs the sweep on an interval through the anon client');
for (const fn of ['set_updated_at()', 'guide_location_filter_ids(text)', 'count_guides(text, text, text)',
                  'guide_facets(text, text, text)', 'list_guides(text, text, text, integer, integer)',
                  'similar_location_guides(uuid, integer)']) {
  ok(`${fn.split('(')[0]} has a pinned search_path`,
     hygiene.includes(`alter function public.${fn} set search_path to 'public';`));
}

// pg_net is load-bearing: cron job 1 calls net.http_post to run the daily
// reminder. Dropping or moving it would have ended those emails silently.
ok('pg_net is neither dropped nor moved', !/drop extension pg_net/i.test(hygiene)
   && !/alter extension pg_net set schema/i.test(hygiene),
   'cron job 1 calls net.http_post for the daily reminder emails');
ok('...and the revoke that cannot work is not left in the file as if it did',
   !/^revoke all on function net\./m.test(hygiene),
   'postgres cannot revoke a grant supabase_admin made');
process.exit(fail ? 1 : 0);
