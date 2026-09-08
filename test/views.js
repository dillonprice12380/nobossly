// Tests for the public marketing views.
//
// A 200 with a full body is not proof a page is visible: /paths/creator shipped
// 49KB of correct HTML that rendered as a blank screen, because every section
// carried `.reveal` — a class the stylesheet sets to opacity:0 and only
// home.js ever clears, and home.js is loaded by the homepage alone.
//
// So this file checks two different things:
//   1. no view can use a class the CSS hides at rest without loading the
//      script that reveals it (derived from the CSS, not hardcoded), and
//   2. the landing pages actually render their copy, questions, criteria and
//      quests — with and without the live DB rows, since those come from
//      Supabase and the page has to hold up when the query returns nothing.
//
//   node test/views.js

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const paths = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
// 1. Nothing may be hidden by CSS unless something un-hides it.

console.log('\nHidden-at-rest classes are always paired with their script:');

const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');

// Class names in a rule that hides the element outright while JS is running.
// Written as `.js .foo { … opacity: 0 … }` — the `.js` prefix is what makes it
// invisible only in the browser, which is exactly the case a status-code check
// cannot see.
const hiddenClasses = new Set();
for (const m of css.matchAll(/\.js\s+\.([a-z0-9_-]+)\s*\{([^}]*)\}/gi)) {
  if (/opacity\s*:\s*0\s*(;|$)/.test(m[2])) hiddenClasses.add(m[1]);
}
ok('found the hidden-at-rest classes in the CSS', hiddenClasses.size > 0,
   [...hiddenClasses].join(', ') || 'none — has the reveal CSS moved?');

// The one script that clears them. If a second one ever does, add it here.
const REVEALERS = ['/js/home.js'];

const viewFiles = fs.readdirSync(VIEWS).filter(f => f.endsWith('.ejs'));
for (const file of viewFiles) {
  const src = fs.readFileSync(path.join(VIEWS, file), 'utf8');
  const used = [...hiddenClasses].filter(c =>
    new RegExp(`class="[^"]*\\b${c}\\b[^"]*"`).test(src));
  if (!used.length) continue;
  const loads = REVEALERS.some(s => src.includes(s));
  ok(`${file} uses ${used.join('/')} and loads its reveal script`, loads,
     loads ? 'ok' : `nothing in ${file} adds .in — the page renders invisible`);
}

// ---------------------------------------------------------------------------
// 2. The landing pages render their content.

console.log('\nPath landing pages render:');

const base = {
  title: 'T', user: null, profile: null, plan: 'free', currentPath: '/paths',
  canonicalUrl: 'https://nobossly.com/paths', unreadCount: 0, unreadMsgs: 0,
  metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null,
  reactivated: false
};

const render = (file, data) =>
  ejs.render(fs.readFileSync(path.join(VIEWS, file), 'utf8'),
             { ...base, ...data }, { filename: path.join(VIEWS, file) });

// Stand-ins for the two tables the route reads live. Both queries are wrapped
// in .catch(() => []) in the route, so the empty case is a real production
// state, not a hypothetical.
const LIBRARY = require('./fit-library-snapshot.json');
const { bindForVisitor } = require('../src/routes/paths_public');

// The rows a visitor to /paths/<slug> would actually be shown, bound the same
// way the route binds them. Using an invented row here is how the page shipped
// printing a literal "{budget}" at readers: the sandbox could not reach the
// database, so the criteria list was always empty when I looked at it.
const criteriaForVisitor = slug => bindForVisitor(
  LIBRARY.filter(r => (r.paths || []).includes(slug))
    .concat(LIBRARY.filter(r => !r.paths || !r.paths.length))
    .slice(0, 5), slug);

const CRITERIA = criteriaForVisitor('creator');
const CHALLENGES = [{ title: 'Post three times this week', description: 'Same hook, three angles.',
  emoji: '🎥', xp_reward: 120, suggested_days: 7, paths: ['creator'] }];

const index = render('paths_index.ejs', { paths: paths.MARKETED });
ok('/paths lists every marketed path',
   paths.MARKETED.every(p => index.includes('/paths/' + p.slug)),
   `${paths.MARKETED.length} paths`);
ok('/paths hides the unmarketed ones',
   paths.PATHS.filter(p => !p.marketing).every(p => !index.includes('/paths/' + p.slug)),
   paths.PATHS.filter(p => !p.marketing).map(p => p.slug).join(', ') || 'none');

for (const def of paths.MARKETED) {
  const questions = paths.ownQuestions(def.slug);
  for (const [label, criteria, challenges] of
       [['with DB rows', criteriaForVisitor(def.slug), CHALLENGES], ['with an empty DB', [], []]]) {
    let html = '';
    try {
      html = render('path_landing.ejs', {
        title: def.label, metaDescription: def.marketing.subhead,
        canonicalUrl: 'https://nobossly.com/paths/' + def.slug,
        def, questions, criteria, challenges,
        rungs: require("../src/ladders").ladderFor(def.slug),
        subpaths: paths.subpathsOf(def.slug),
        others: paths.MARKETED.filter(p => p.slug !== def.slug)
      });
    } catch (e) {
      ok(`${def.slug} ${label}: renders`, false, e.message);
      continue;
    }

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');

    const missing = [];
    if (!html.includes(esc(def.marketing.headline))) missing.push('headline');
    if (!html.includes(esc(def.marketing.truth))) missing.push('truth');
    for (const p of def.marketing.pains) if (!html.includes(esc(p))) missing.push('a pain line');
    if (!html.includes('/signup?path=' + def.slug)) missing.push('the signup CTA');
    for (const q of questions) if (!html.includes(esc(q.label))) missing.push('question: ' + q.name);
    if (challenges.length && !html.includes(esc(challenges[0].title))) missing.push('the quest');
    if (!html.includes(esc(def.marketing.bar))) missing.push('the traction bar');
    if (criteria.length && !html.includes(esc(criteria[0].criterion))) missing.push('the criterion');
    ok(`${def.slug} ${label}: every block is in the HTML`, !missing.length,
       missing.join(', ') || `${questions.length} questions`);

    // Nothing a visitor reads may still be a template. Library wording carries
    // {budget}, {hours}, {traction} and the rest, filled from a member's own
    // answers — a visitor has none, so the page binds them to the generic
    // phrase instead of printing the braces.
    const raw = (html.match(/\{[a-z_]+\}/g) || []);
    ok(`${def.slug} ${label}: no unbound placeholder reaches the reader`, raw.length === 0,
       raw.slice(0, 4).join(', ') || 'clean');

    // The bug this file exists for: content present in the HTML but painted
    // at opacity 0 forever.
    const hidden = [...hiddenClasses].filter(c =>
      new RegExp(`class="[^"]*\\b${c}\\b[^"]*"`).test(html));
    ok(`${def.slug} ${label}: nothing is hidden at rest`, !hidden.length,
       hidden.join(', ') || 'visible');

    ok(`${def.slug} ${label}: shows at least one question`, questions.length > 0,
       `${questions.length}`);
  }
}


// ---------------------------------------------------------------------------
// 3. The positioning holds.
//
// The site is about getting out of a job, not about being a founder. That is a
// copy decision, and copy drifts back: one new section written in the old voice
// and the pages disagree with each other again. So this reads the RENDERED text
// of the public pages, not the source, and holds it to two rules.

console.log('\nThe pages still say what the site is about:');

const freeFeatures = require('../src/routes/billing');   // side-effect-free require
const TIERS = [{ key: 'month', name: 'Escape Monthly', tagline: 'Full access, billed monthly',
                 price_cents: 1200, interval_label: 'per month' }];

const marketing = {
  'home.ejs': { paths: paths.MARKETED },
  'how_it_works.ejs': {},
  'paths_index.ejs': { paths: paths.MARKETED },
  'pricing.ejs': { tiers: TIERS, freeFeatures: ['Your Compass — archetype, territories & fit test'],
                   paidFeatures: ['Everything in Free'], plan: null, upgrade: null, msg: null }
};
for (const def of paths.MARKETED) {
  marketing['path_landing.ejs:' + def.slug] = {
    def, questions: paths.ownQuestions(def.slug), criteria: [], challenges: [],
    rungs: require('../src/ladders').ladderFor(def.slug),
    subpaths: paths.subpathsOf(def.slug),
    others: paths.MARKETED.filter(p => p.slug !== def.slug)
  };
}

// Visible text only: strip tags, scripts and styles, then decode the few
// entities the copy actually uses. A word inside a class name is not copy.
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ');
}

// Nothing a reader can see says "founder" any more. Level six used to be the
// one exemption — it is "Owner" now, because a content creator whose channel
// pays is not a founder, and neither is a plumber. With the exemption gone the
// rule is absolute, which is the version worth guarding.
const FOUNDER_OK = /(?!)/g;   // matches nothing

// The vocabulary of the repositioning. A public page that manages to say none of
// this has drifted back to being about founders in general.
const JOB_WORDS = /\b(9 to 5|day job|your job|a job|the job|jobs|boss|paycheck|payslip|salary|employer|after work|evenings|notice|full-time|quit)\b/i;

for (const [name, data] of Object.entries(marketing)) {
  const file = name.split(':')[0];
  let html;
  try {
    html = render(file, { title: 'T', metaDescription: '', canonicalUrl: 'https://nobossly.com/', ...data });
  } catch (e) { ok(`${name}: renders`, false, e.message); continue; }
  const text = visibleText(html);

  const founders = (text.replace(FOUNDER_OK, ' ').match(/founder/gi) || []);
  ok(`${name}: no retired founder framing`, founders.length === 0,
     founders.length ? founders.length + ' left' : 'clean');

  ok(`${name}: says what the reader is getting out of`, JOB_WORDS.test(text),
     (text.match(JOB_WORDS) || ['—'])[0]);
}

// The two names that were retired outright, checked across the source so a
// server-rendered string or an email template cannot bring them back either.
console.log('\nRetired names stay retired:');
const RETIRED = ['Founder Compass', "Founder's Ladder", 'Founder’s Ladder', 'Founder&rsquo;s Ladder'];
const sourceFiles = []
  .concat(fs.readdirSync(VIEWS).filter(f => f.endsWith('.ejs')).map(f => path.join(VIEWS, f)))
  .concat(['src', 'src/routes'].flatMap(d => fs.readdirSync(path.join(ROOT, d))
    .filter(f => f.endsWith('.js')).map(f => path.join(ROOT, d, f))));
for (const term of RETIRED) {
  const hits = sourceFiles.filter(p => fs.readFileSync(p, 'utf8').includes(term))
    .map(p => path.relative(ROOT, p));
  ok(`"${term}" appears nowhere`, hits.length === 0, hits.join(', ') || 'clean');
}

// ---------------------------------------------------------------------------
// 3b. Nothing promises a question count the questionnaire does not ask.
//
// The core round was seven questions before paths existed. It is now the six
// universal questions, the path question, the subpath question and the path's
// own — twelve to fourteen, depending on the path. "Seven questions" survived
// in fourteen places across the views, the emails and a path's own marketing
// subhead, which is a promise the second screen immediately breaks. The copy
// says "about a dozen" now, so the guard is both halves: the stale phrase is
// gone, and a dozen is still an honest word for the real count.

console.log('\nThe promised question count is the real one:');
const STALE_COUNT = [/seven[- ]question/i, /seven answers/i, /\bseven questions\b/i];
for (const re of STALE_COUNT) {
  const hits = sourceFiles.filter(p => re.test(fs.readFileSync(p, 'utf8')))
    .map(p => path.relative(ROOT, p));
  ok(`nothing says ${re}`, hits.length === 0, hits.join(', ') || 'clean');
}
{
  const counts = paths.PATHS.map(p => paths.coreQuestions(p.slug).length);
  const lo = Math.min(...counts), hi = Math.max(...counts);
  ok('every path asks about a dozen core questions', lo >= 11 && hi <= 16, `${lo}–${hi}`);
}


// ---------------------------------------------------------------------------
// 4. Attributes built inside a template tag are not double-escaped.
//
// `<%= %>` escapes what it prints, so a string that already contains escaped
// quotes comes out as placeholder=&#34;… — which is not an attribute at all.
// Every placeholder on the questionnaire was invisible this way, silently,
// because the markup stays valid enough to render. Nothing throws; the hint
// text simply never appears.

console.log('\nAttributes survive the template:');

const qHtml = render('questionnaire.ejs', {
  paths: paths.PATHS, path: 'creator', pathDef: paths.get('creator'),
  step: 2, totalSteps: paths.totalSteps('creator'), requiredSteps: 2, deepening: false,
  questions: paths.coreQuestions('creator'), q: {}, pathAnswers: {}, run: 1,
  canCancel: false, msg: null, profile: { username: 'x' }
});

const mangled = (qHtml.match(/\b[a-z-]+=&(#34|quot|amp);/g) || []);
ok('no attribute was escaped twice', mangled.length === 0,
   mangled.slice(0, 3).join(', ') || 'clean');
ok('placeholders actually render as placeholders',
   /placeholder="the narrower the better/.test(qHtml),
   (qHtml.match(/placeholder="[^"]{0,40}/) || ['NONE'])[0]);

// The conditional-question payload has to survive as parseable JSON, or the
// browser silently shows every question at once.
const conds = [...qHtml.matchAll(/data-show-if="([^"]*)"/g)].map(m => m[1]);
// The count grows as conditional questions are added, so this asserts the
// mechanism is live rather than pinning a number that changes with content.
ok('conditional questions carry their condition', conds.length >= 2, conds.length + ' found');
ok('...and each parses after HTML decoding', conds.every(c => {
  try { return !!JSON.parse(c.replace(/&quot;/g, '"').replace(/&amp;/g, '&')); }
  catch (e) { return false; }
}), conds.length ? 'parsed' : 'none');

console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
process.exit(fail ? 1 : 0);
