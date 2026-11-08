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
//   2. the landing pages actually render their copy and quests — with and without the live DB rows, since those come from
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
  // Set on every request by the affiliate and premium middleware, so every
  // view can count on them. Built the same way here, with no offers loaded.
  affiliates: (() => { const a = {}; require('../src/affiliates').attach({}, { locals: a }, () => {}); return a.affiliates; })(),
  premiumTools: require('../src/premium').TOOLS, isPremium: false,
  flags: require('../src/features').FLAGS
};

const render = (file, data) =>
  ejs.render(fs.readFileSync(path.join(VIEWS, file), 'utf8'),
             { ...base, ...data }, { filename: path.join(VIEWS, file) });

// Stand-ins for the two tables the route reads live. Both queries are wrapped
// in .catch(() => []) in the route, so the empty case is a real production
// state, not a hypothetical.
// The fit-test criteria these pages used to list were retired with the fit
// test itself; the route no longer reads or passes any. Rendered empty, the
// way the route renders them now.
const criteriaForVisitor = () => [];

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
        dash: require('../src/path_dashboards').previewFor(def.slug),
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
    // Curated quests and the "rules of thumb" bar were retired (2026-11-08):
    // NoBossly is a workspace and community, not a program telling you what to do.
    if (challenges.length && html.includes(esc(challenges[0].title))) missing.push('no curated quest');
    if (def.marketing.bar || /The number this path turns on/.test(html)) missing.push('no traction bar');
    const dash = require('../src/path_dashboards').previewFor(def.slug);
    if (!html.includes('Your dashboard on this path') || !dash.stages.every(st => html.includes(esc(st)))) missing.push('the dashboard preview');
    if (/\bXP\b|\brungs?\b|\bladder\b/.test(html.replace(/<style[\s\S]*?<\/style>/g, ''))) missing.push('no retired XP/ladder wording');
    if (criteria.length && !html.includes(esc(criteria[0].criterion))) missing.push('the criterion');
    ok(`${def.slug} ${label}: every block is in the HTML`, !missing.length,
       missing.join(', ') || 'all present');

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
  'pricing.ejs': { tiers: TIERS, freeFeatures: ['Every path, tool and the whole community'],
                   paidFeatures: ['Everything in Free'], plan: null, upgrade: null, msg: null }
};
for (const def of paths.MARKETED) {
  marketing['path_landing.ejs:' + def.slug] = {
    def, questions: paths.ownQuestions(def.slug), criteria: [], challenges: [],
    dash: require('../src/path_dashboards').previewFor(def.slug),
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

const COACHING = /\b(quests?|electives?|next (real )?step|fit test|playbooks?|step-by-step|curriculum|the tools an accelerator|worksheets an accelerator|we('ll| will) (guide|coach|teach))\b/i;

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

  // A workspace and a community, not an accelerator: no curriculum, no quests
  // to accept, no "next step" handed down, nothing that tests your plan.
  const coaching = text.match(COACHING);
  ok(`${name}: no program or coaching framing`, !coaching, coaching ? coaching[0] : 'clean');
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
// 3c. The feed is people posting, and their shared results.
//
// Members post updates, questions, resources and results; wins and finished
// challenges sit in the same timeline. XP and levels are switched off
// (FLAGS.ladder), so nothing on the feed may print one.

console.log('\nThe feed shows what members post:');
{
  const who = (u) => ({ id: 'id-' + u, username: u, display_name: u.toUpperCase(), avatar_url: null, path: 'creator', headline: 'Bakes for markets' });
  const post = {
    id: '11111111-1111-1111-1111-111111111111', user_id: 'id-ana', post_type: 'question', content: 'How do you price a first batch?',
    link_url: null, link_title: null, like_count: 2, comment_count: 4, created_at: new Date().toISOString(),
    who: who('ana'), type: { label: 'Question', emoji: '❓' }, likedByMe: true, mine: false,
    comments: [{ id: 'c1', user_id: 'id-bo', content: 'Cost times three, then test.', created_at: new Date().toISOString(), who: who('bo') }],
    moreComments: 3
  };
  const event = { id: 'e1', user_id: 'id-bo', kind: 'win', title: 'posted a win: first paying customer', emoji: '🤝', created_at: new Date().toISOString(), who: who('bo') };
  const locals = { user: { id: 'me' }, msg: null, scope: 'everyone', types: require('../src/posts').TYPES, maxPost: 500, maxComment: 280,
    pathLabel: () => 'Creator' };
  const html = render('feed.ejs', Object.assign({}, locals, { following: 2, suggestions: [],
    items: [{ item: 'post', at: post.created_at, post }, { item: 'event', at: event.created_at, event }] }));
  ok('a member post renders with its author and headline', html.includes('How do you price a first batch?') && html.includes('Bakes for markets'));
  ok('...with its reactions, comments and a way to reply', html.includes('👍 2') && html.includes('Cost times three') && html.includes('/feed/p/' + post.id + '/comment'));
  ok('...and a link to the rest of the comments', html.includes('View all 4 comments'));
  ok('a shared result sits in the same timeline', html.includes('first paying customer') && html.includes('href="/wins"'));
  ok('there is a box to post from', html.includes('action="/feed/post"'));
  const text = html.replace(/<[^>]+>/g, ' ');
  ok('no XP or level is printed', !/\bXP\b|Level \d/.test(text));

  const empty = render('feed.ejs', Object.assign({}, locals, { following: 0, items: [], suggestions: [] }));
  ok('an empty feed gives a next step', /Be the first to post/.test(empty) && /Find members/.test(empty));
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

// The questionnaire this guard was written for is gone; the rule holds for
// every page that is still rendered, so it runs over the public ones.
const mangled = Object.entries(marketing).flatMap(([name, data]) => {
  const html = render(name.split(':')[0], { title: 'T', metaDescription: '', canonicalUrl: 'https://nobossly.com/', ...data });
  return (html.match(/\b[a-z-]+=&(#34|quot|amp);/g) || []).map(m => name + ' ' + m);
});
ok('no attribute was escaped twice', mangled.length === 0,
   mangled.slice(0, 3).join(', ') || 'clean');

console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
process.exit(fail ? 1 : 0);
