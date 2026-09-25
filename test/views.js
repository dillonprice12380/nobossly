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
//   2. the landing pages actually render their copy, rungs and
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
  reactivated: false,
  // Every page gets these from middleware (src/affiliates.js, src/premium.js).
  // Affiliate slots come from Supabase, so this is the no-rows case.
  affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false },
  premiumTools: require('../src/premium').TOOLS
};

const render = (file, data) =>
  ejs.render(fs.readFileSync(path.join(VIEWS, file), 'utf8'),
             { ...base, ...data }, { filename: path.join(VIEWS, file) });

// Stand-ins for the two tables the route reads live. Both queries are wrapped
// in .catch(() => []) in the route, so the empty case is a real production
// state, not a hypothetical.
// The quests the route reads live, stand-in for the Supabase rows.
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
  for (const [label, challenges] of
       [['with DB rows', CHALLENGES], ['with an empty DB', []]]) {
    let html = '';
    try {
      html = render('path_landing.ejs', {
        title: def.label, metaDescription: def.marketing.subhead,
        canonicalUrl: 'https://nobossly.com/paths/' + def.slug,
        def, challenges,
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
    if (challenges.length && !html.includes(esc(challenges[0].title))) missing.push('the quest');
    if (!html.includes(esc(def.marketing.bar))) missing.push('the traction bar');
    ok(`${def.slug} ${label}: every block is in the HTML`, !missing.length,
       missing.join(', ') || 'all there');

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
// One tier marked down and one at list price, so the page is exercised in both
// states. The offer is attached the way src/routes/billing.js attaches it.
const TIERS = require('../src/pricing').withOffer([
  { key: 'month', name: 'Escape Monthly', tagline: 'Full access, billed monthly',
    price_cents: 1200, interval_label: 'per month',
    promo_price_cents: 600, promo_label: '2026/27 launch price — 50% off' },
  { key: 'lifetime', name: 'Escape Lifetime', tagline: 'One payment.',
    price_cents: 35000, interval_label: 'one-time' }
]);

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
// server.js belongs in here too: it renders the homepage and the sample
// Compass directly, so it carries their <title> and meta description. It was
// outside the scan, and both were still selling a "Founder Compass" and "The
// Real-Life Founder Game" long after the word was gone from every view.
const sourceFiles = [path.join(ROOT, 'server.js')]
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
// 3c. The feed names each member's rung from THEIR ladder, not the viewer's.
//
// Nine paths means Level 4 is "Regular" for a creator and "Quoting" for a
// plumber. Every view that renders someone else's level has to look the title
// up against that person's own path — the feed, the dashboard peek and the
// member directory all do, and the failure is silent: the page renders, the
// number is right, and the word is somebody else's.

console.log('\nThe feed reads each member from their own ladder:');
{
  const ladders = require('../src/ladders');
  const helpers = {
    rungTitle: (p, l) => { const r = (ladders.ladderFor(p) || []).find(x => x.level === l); return r ? r.title : ''; },
    pathLabel: (s) => { const p = paths.get(s); return p ? p.label : ''; }
  };
  const at = (path, username) => ({
    id: 'e-' + username, kind: 'level', title: 'reached Level 4', emoji: '\u2b06\ufe0f',
    created_at: new Date().toISOString(),
    who: { username, display_name: username, current_level: 4, path }
  });
  const html = render('feed.ejs', Object.assign({ user: { id: 'me' } }, helpers, {
    following: 2, suggestions: [],
    events: [at('creator', 'ana'), at('local_service', 'bo')]
  }));
  const creator = ladders.ladderFor('creator').find(r => r.level === 4).title;
  const trade = ladders.ladderFor('local_service').find(r => r.level === 4).title;
  ok('two members at Level 4 on different paths get different words',
     creator !== trade, `${creator} vs ${trade}`);
  ok('...and both of those words are on the page',
     html.includes(creator) && html.includes(trade), `${creator}, ${trade}`);

  // The empty states are the ones a new member actually sees first.
  const noFollows = render('feed.ejs', Object.assign({ user: { id: 'me' } }, helpers,
    { following: 0, events: [], suggestions: [] }));
  ok('following nobody renders a way out of it', /Find members|not following anyone/i.test(noFollows), 'has a next step');
}


console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
process.exit(fail ? 1 : 0);
