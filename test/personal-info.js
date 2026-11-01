// Contact details stay out of member-written text — in the app
// (src/personal_info_filter.js) and in the database (contains_personal_info()
// in migrations/2026-11-01_personal_info_filter.sql). The two are separate
// regex dialects, so the SQL patterns are read out of the migration and run
// here too: both must agree on every sample.
//
//   node test/personal-info.js

const fs = require('fs');
const path = require('path');
const f = require('../src/personal_info_filter');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const MUST = [
  ['email me at bob@gmail.com', 'email'], ['bob (at) gmail (dot) com', 'email'], ['bob at gmail dot com', 'email'],
  ['bob [at] site [dot] co', 'email'], ['call (555) 123-4567', 'phone'], ['555.123.4567', 'phone'],
  ['+1 555 123 4567', 'phone'], ['+44 20 7946 0958', 'phone'], ['5551234567', 'phone'],
  ['five five five one two three four', 'phone'], ['I live at 120 Main Street', 'address'], ['12 Oak Ln', 'address'],
  ['4500 Martin Luther King Jr Blvd', 'address'], ['PO Box 123', 'address'], ['P.O. Box 77', 'address'],
  ['Apt 4B', 'address'], ['Suite 200', 'address'], ['Unit #3', 'address']
];
const MUST_NOT = [
  'I spent 3 hours on the road', 'took 2 years to drive it', 'We hit $1,000,000 in sales', 'Meeting 2026-11-01 10:00',
  'unit 3 of the course', 'my site is https://example.com', 'follow me @nobossly', 'I made $500 at the market',
  '2 st bernards', 'Check out bob.dev'
];

console.log('\nThe app catches contact details:');
for (const [t, kind] of MUST) ok(`"${t}" → ${kind}`, f.describe(t) === kind, String(f.describe(t)));

console.log('\n...and leaves ordinary sentences alone:');
for (const t of MUST_NOT) ok(`"${t}"`, !f.containsPersonalInfo(t), String(f.describe(t)));

// ---------------------------------------------------------------------------
console.log('\nThe database agrees with the app:');
{
  const sql = read('migrations/2026-11-01_personal_info_filter.sql');
  const body = sql.slice(sql.indexOf('create or replace function public.contains_personal_info'), sql.indexOf('$function$;'));
  // Postgres ARE → JS: \y is a word boundary, '' is a quote inside a literal.
  const pats = [...body.matchAll(/p_text ~\* '((?:[^']|'')+)'/g)]
    .map(m => new RegExp(m[1].replace(/''/g, "'").replace(/\\y/g, '\\b'), 'i'));
  ok('the migration\'s patterns were found', pats.length === f.PATTERNS.length, `${pats.length} SQL, ${f.PATTERNS.length} JS`);
  const sqlHit = t => pats.some(re => re.test(t));
  const disagree = MUST.map(m => m[0]).concat(MUST_NOT).filter(t => sqlHit(t) !== f.containsPersonalInfo(t));
  ok('every sample gets the same answer from both', disagree.length === 0, disagree.join(' | ') || `${MUST.length + MUST_NOT.length} samples`);
  ok('the triggers cover messages, group posts, forum threads and replies',
     ['messages', 'group_posts', 'forum_threads', 'forum_replies'].every(t => new RegExp(`before insert or update of [a-z_, ]+ on public\\.${t}\\b`).test(sql)));
  ok('filter_hits never stores the text', !/\btext_value\b|\bbody\b|\bcontent\b/.test(sql.slice(sql.indexOf('create table if not exists public.filter_hits'))));
  ok('the migration is marked as not applied', /^-- NOT APPLIED, written for review\./.test(sql));
}

// ---------------------------------------------------------------------------
console.log('\nEvery member-written field goes through it:');
{
  const sites = [
    ['src/routes/community.js', 'forum_thread'], ['src/routes/community.js', 'forum_reply'],
    ['src/routes/community.js', 'forum_thread_edit'], ['src/routes/community.js', 'forum_reply_edit'],
    ['src/routes/social.js', 'group_post'], ['src/routes/messages.js', 'message'],
    ['src/routes/members.js', 'profile'], ['src/routes/reviews.js', 'review_request'],
    ['src/routes/reviews.js', 'review_feedback'], ['src/routes/wins.js', 'win'], ['src/routes/challenges.js', 'quest_proof']
  ];
  const missing = sites.filter(([file, where]) => !read(file).includes(`'${where}')`));
  ok('each write refuses contact details before it reaches the database', missing.length === 0,
     missing.map(m => m.join(':')).join(', ') || `${sites.length} write paths`);
  ok('the refusal says what to do instead', /Use NoBossly messages to connect\./.test(f.MESSAGE));
}

console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
process.exit(fail ? 1 : 0);
