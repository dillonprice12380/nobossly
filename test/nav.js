// Tests for where the app sends people.
//
// Two live bugs are the reason this file exists.
//
//   1. The ladder names your blocker and then links you to a filing cabinet.
//      Every quest on the dashboard pointed at /milestones, so "Compass
//      Questions Answered" sent you to a list of things you had not done
//      instead of to the questionnaire. src/quest_routes.js now maps each
//      milestone's auto_kind to the screen where the work actually happens —
//      and a map is only as good as its worst entry, so every destination in
//      it is checked here against the routes the server really mounts. The
//      first version of that map shipped /profile/edit, which is not a route.
//
//   2. The section nav decides for itself whether to render (`_inApp` is true
//      only when the current path matches something in APP_NAV). Coach and
//      Feed were linked from the top nav but absent from APP_NAV, so opening
//      either one made the whole tab row vanish; /wins was in no navigation at
//      all. So: the newest surfaces must be tabs, and every tab must match its
//      own href, or it hides the nav it belongs to.
//
//   node test/nav.js

const fs = require('fs');
const path = require('path');
const questRoutes = require('../src/quest_routes');

const ROOT = path.join(__dirname, '..');
const VIEWS_DIR = path.join(ROOT, 'views');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
// A resolver for "is this href a real page?", built from server.js rather than
// from a list someone has to remember to update.

const server = read('server.js');

// app.get('/profile', …) — a page handled by server.js itself.
const topLevel = new Set(
  [...server.matchAll(/app\.get\(\s*'([^']+)'/g)].map(m => m[1]));

// app.use('/members', requireAuth, require('./src/routes/members'))
const mounts = [...server.matchAll(/app\.use\(\s*'([^']+)'[^)]*require\('\.\/(src\/routes\/[a-z_]+)'\)/g)]
  .map(m => ({ prefix: m[1], file: m[2] + '.js' }))
  .sort((a, b) => b.prefix.length - a.prefix.length);

// The paths one router file answers to, each with whether it is literal or has
// a :param. A '/'-mounted catch-all like /:slug must not be allowed to vouch
// for a link, or every typo "resolves".
function routesIn(file) {
  const src = read(file);
  return [...src.matchAll(/router\.(?:get|all)\(\s*'([^']*)'/g)].map(m => ({
    p: m[1] || '/',
    literal: !m[1].includes(':') && !m[1].includes('*')
  }));
}
const routeCache = {};
const routesFor = f => (routeCache[f] || (routeCache[f] = routesIn(f)));

function resolves(href) {
  const url = href.split(/[?#]/)[0];
  if (topLevel.has(url)) return true;
  for (const { prefix, file } of mounts) {
    const atRoot = prefix === '/';
    if (!atRoot && url !== prefix && !url.startsWith(prefix + '/')) continue;
    const rest = (atRoot ? url : url.slice(prefix.length)) || '/';
    for (const r of routesFor(file)) {
      if (r.p === rest) return true;
      if (atRoot) continue; // no param matching from a catch-all mount
      const rx = new RegExp('^' + r.p.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*') + '$');
      if (rx.test(rest)) return true;
    }
    if (!atRoot) return false; // the prefix owns this URL; nothing under it matched
  }
  return false;
}

console.log('\nThe resolver can tell a real route from a made-up one:');
ok('/dashboard resolves', resolves('/dashboard'));
ok('/members/me/edit resolves', resolves('/members/me/edit'));
ok('/profile resolves (handled in server.js)', resolves('/profile'));
ok('/profile/edit does NOT resolve', !resolves('/profile/edit'),
   'the destination the quest map first shipped');
ok('/nonsense does NOT resolve', !resolves('/nonsense'));

// ---------------------------------------------------------------------------
// 1. Every quest destination is a page.

console.log('\nEvery quest sends you somewhere you can do the work:');

// Every auto_kind carried by a row in predefined_milestones. Kept here rather
// than read from the DB because the test suite has no network; add to it when
// a migration adds a kind, and this file will tell you if the map lags behind.
const AUTO_KINDS = [
  'blueprints', 'challenges', 'checkins', 'followers', 'idea_fit_pct', 'ideas',
  'ideas_cut', 'posts', 'profile', 'questionnaire', 'signals', 'sprints_done',
  'sprints_started', 'streak', 'tasks'
];

for (const kind of AUTO_KINDS) {
  const to = questRoutes.destinationFor({ type: 'milestone', title: kind },
                                        { auto_kind: kind, is_claimable: false });
  const routed = to.href !== '/milestones';
  ok(`${kind} → ${to.href} "${to.cta}"`, routed && resolves(to.href),
     !routed ? 'fell through to the trophy case — no mapping' :
     resolves(to.href) ? 'ok' : 'not a mounted route');
}

// The two fallbacks, and the one challenge with an on-platform home.
const claim = questRoutes.destinationFor({ type: 'milestone', title: '$1,000 Revenue' },
                                         { auto_kind: null, is_claimable: true });
ok(`a self-claimed trophy → ${claim.href}`, resolves(claim.href) && claim.href === '/trophies',
   'self-claimed trophies are logged on the trophy case, which is right');
const chal = questRoutes.destinationFor({ type: 'challenge', title: 'Validate your idea' });
ok(`a quest → ${chal.href}`, resolves(chal.href) && chal.href === '/quests');
const feedback = questRoutes.destinationFor({ type: 'challenge', title: 'Get 3 Feedback Sessions' });
ok(`"Get 3 Feedback Sessions" → ${feedback.href}`, feedback.href === '/reviews' && resolves(feedback.href),
   'the peer-review queue is the on-platform way to do it');

// Every gate carries a CTA, because the button label is the instruction.
const noCta = AUTO_KINDS
  .map(k => questRoutes.destinationFor({ type: 'milestone', title: k }, { auto_kind: k }))
  .filter(d => !d.cta || d.cta === 'Go');
ok('no quest button says a generic "Go"', noCta.length === 0, noCta.length ? `${noCta.length} do` : 'clean');

// ---------------------------------------------------------------------------
// 2. The section nav.

console.log('\nThe section nav holds every section:');

const appnav = read('views/partials/appnav.ejs');
const block = appnav.match(/var APP_NAV = (\[[\s\S]*?\n  \]);/);
ok('APP_NAV is where this test expects it', !!block);
const APP_NAV = block ? new Function('return ' + block[1])() : [];

ok('every tab points at a real page',
   APP_NAV.every(i => resolves(i.href)),
   APP_NAV.filter(i => !resolves(i.href)).map(i => i.href).join(', ') || 'all ' + APP_NAV.length);

// _inApp is `APP_NAV.some(_active)`, so a tab whose own href does not match its
// own patterns hides the entire nav on the page it links to.
const selfBlind = APP_NAV.filter(i =>
  !i.match.some(m => i.href === m || i.href.startsWith(m + '/')));
ok('every tab matches its own href (or it hides the nav it is in)',
   selfBlind.length === 0, selfBlind.map(i => i.href).join(', ') || 'clean');

for (const href of ['/coach', '/feed', '/wins']) {
  ok(`${href} is in the section nav`, APP_NAV.some(i => i.href === href),
     'opening it used to make the whole tab row disappear');
}

// The phone bar shows `short`, so two tabs sharing one short name are two
// identical buttons. "Wins" meant both Milestones and the Wins wall.
const shorts = APP_NAV.map(i => i.short.toLowerCase());
const dupes = shorts.filter((s, i) => shorts.indexOf(s) !== i);
ok('no two tabs share a phone-bar name', dupes.length === 0, dupes.join(', ') || 'clean');
ok('no two tabs share an href', new Set(APP_NAV.map(i => i.href)).size === APP_NAV.length);

// The top nav is global-only: everything section-shaped belongs to the tab row,
// or the same link lives in two navigations that highlight independently.
const head = read('views/partials/head.ejs');
const loggedIn = head.match(/<% if \(user\) \{ %>([\s\S]*?)<% \} else \{ %>/);
if (loggedIn) {
  const inTop = [...loggedIn[1].matchAll(/href="(\/[a-z-]+)"/g)].map(m => m[1]);
  const both = inTop.filter(h => APP_NAV.some(i => i.href === h) && h !== '/dashboard');
  ok('the top nav does not duplicate section tabs', both.length === 0,
     both.join(', ') || 'only /dashboard, which is the way home');
}

// ---------------------------------------------------------------------------
// 3. One name per thing.
//
// The nav said "Challenges" and "Milestones" while the pages themselves, the
// upgrade panel and the ladder countdown all said "quests" and "trophy case".
// Two words for each of the product's two loops, and the phone bar had already
// quietly switched to the second set — which is how "Wins" ended up meaning
// both Milestones and the Wins wall. These hold the settled names.

console.log('\nThe product has one word for each of its two loops:');

const renamed = { '/quests': 'Quests', '/trophies': 'Trophies' };
for (const [href, label] of Object.entries(renamed)) {
  const tab = APP_NAV.find(i => i.href === href);
  ok(`${href} is the tab, labelled "${label}"`, !!tab && tab.label === label,
     tab ? `labelled "${tab.label}"` : 'no tab points there');
}

// Old URLs are in notifications already sent and in whatever anyone bookmarked.
// They are mounted, not redirected, so a POST to one still works.
for (const old of ['/challenges', '/milestones']) {
  ok(`${old} still resolves`, resolves(old), 'the former name has to keep working');
  ok(`...and ${old} is matched by its tab, so the nav still renders there`,
     APP_NAV.some(i => i.match.includes(old)));
}

// The retired names must not come back as the name of a section. The words
// themselves are ordinary English and stay allowed in prose; what is banned is
// a heading or nav label that names the tab by its old name.
const RETIRED = [
  [/<h1>[^<]*\bChallenges\b/, 'no page heading says "Challenges"'],
  [/<h1>[^<]*\bMilestones\b/, 'no page heading says "Milestones"'],
  [/label: 'Challenges'/,       'no nav tab is labelled "Challenges"'],
  [/label: 'Milestones'/,       'no nav tab is labelled "Milestones"']
];
const viewSrc = fs.readdirSync(VIEWS_DIR, { recursive: true })
  .filter(f => String(f).endsWith('.ejs'))
  .map(f => ({ f, src: fs.readFileSync(path.join(VIEWS_DIR, String(f)), "utf8") }));
for (const [rx, why] of RETIRED) {
  const hit = viewSrc.filter(v => rx.test(v.src.replace(/<svg[\s\S]*?<\/svg>/g, '')));
  ok(why, hit.length === 0, hit.map(v => v.f).join(', ') || 'clean');
}

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
