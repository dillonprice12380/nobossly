// The dashboard overview (views/dashboard.ejs): onboarding on top, then two
// columns, the work on the left and quick glances on the right.
//
//   node test/dashboard.js            (DASH_OUT=dir also writes the pages as HTML)

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const { FLAGS } = require('../src/features');
const dash = require('../src/path_dashboards');
const news = require('../src/news');

function fakeSb(rows = {}) {
  const chain = table => {
    const q = new Proxy({}, { get(_, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: rows[table] || [], error: null }).then(res, rej);
      return () => q;
    } });
    return q;
  };
  return { from: t => chain(t) };
}

(async () => {
  const now = new Date('2026-11-05T15:00:00Z');
  const profile = { id: 'me', username: 'dana', display_name: 'Dana', path: 'freelancer', subpath: 'design', path_answers: { stage: 'Some regular clients' }, current_level: 2, xp_total: 340, streak_days: 4, tasks_completed: 12 };
  const panel = await dash.panelFor(fakeSb({
    metric_entries: [{ id: 'e1', metric: 'fl_income', period: '2026-11-01', value: 2400 }, { id: 'e2', metric: 'fl_income', period: '2026-10-01', value: 1800 }],
    pipeline_items: [{ stage: 'lead', value: 500 }, { stage: 'won', value: 1200 }],
    checklist_progress: [{ item: 'scope', done_at: '2026-11-01T00:00:00Z' }]
  }), 'me', profile, now);
  const ago = h => new Date(Date.now() - h * 3600000).toISOString();
  const pathNews = [
    { id: 'n1', label: 'Search and ads', publisher: 'Search Engine Roundtable', title: 'Google AI Mode Now With Up To Four Ads', url: 'https://example.com/1', published_at: ago(3) },
    { id: 'n2', label: 'AI and creative tools', publisher: 'Inc.', title: 'Adobe Just Removed AI From Lightroom. Well, Sort Of', url: 'https://example.com/2', published_at: ago(9) },
    { id: 'n3', label: 'Freelance work', publisher: 'Entrepreneur', title: 'What Clients Need Before They Trust You With Sensitive Work', url: 'https://example.com/3', published_at: ago(26) }
  ];
  const checklist = { done: 3, total: 5, steps: [
    { label: 'Pick your path', done: true, href: '/choose-path', cta: 'Pick' },
    { label: 'Set up your dashboard', done: true, href: '/choose-path/setup', cta: 'Set up' },
    { label: 'Log your first number', done: true, href: '/workspace', cta: 'Log' },
    { label: 'Accept your first quest', done: false, href: '/quests', cta: 'Browse quests' },
    { label: 'Follow three members', done: false, href: '/members', cta: 'Find members' }
  ] };
  const pinned = [{ id: 'a1', challenge_id: 'c1', duration_days: 7, due_date: '2026-11-09', challenge: { title: 'Send three cold pitches', emoji: '📨', xp_reward: 50, requires_proof: false } }];
  const coach = [
    { message: 'Your pipeline has a lead with no follow-up for 5 days.', cta_href: '/workspace', cta_label: 'Follow up' },
    { message: 'You logged income last month but not this month.', cta_href: '/budget', cta_label: 'Log it' },
    { message: 'Three members on your path posted wins this week.', cta_href: '/feed', cta_label: 'See' },
    { message: 'A fourth nudge that should not show.', cta_href: '/x', cta_label: 'X' }
  ];
  const feedPeek = [{ who: { username: 'sam', display_name: 'Sam' }, emoji: '🎉', title: 'landed their first retainer client' }];

  const base = {
    title: 'Dashboard', user: { id: 'me' }, profile, plan: 'paid', currentPath: '/dashboard', canonicalUrl: 'x',
    unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null, reactivated: false,
    isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null,
    affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false },
    sprint: null, tasks: [], checkinToday: false, today: '2026-11-05',
    needsSetup: false, needsPath: false, pathTools: dash.featuredFor('freelancer'), pathPanel: panel,
    pathNews, newsAgo: news.ago, levelInfo: { current: { title: 'Starter', emoji: '🌱' }, next: { title: 'Earner', xp_required: 500 } },
    ladder: null, yourPath: { label: 'Freelancer', emoji: '💻' }, pinned, analytics: null, coach,
    checklist, sprintSuggestions: [], feedPeek, following: true, rungTitle: () => ''
  };
  const render = data => { try { return ejs.render(read('views/dashboard.ejs'), Object.assign({}, base, data), { filename: path.join(ROOT, 'views/dashboard.ejs') }); } catch (e) { return 'ERR ' + e.message; } };
  const at = (html, s) => html.indexOf(s);

  console.log('The overview, as members see it today:');
  const html = render({});
  ok('it renders', !html.startsWith('ERR'), html.startsWith('ERR') ? html.slice(0, 300) : undefined);
  const main = html.slice(at(html, 'class="dash-main"'), at(html, 'class="dash-side"'));
  const side = html.slice(at(html, 'class="dash-side"'));
  ok('onboarding comes before the columns', at(html, 'Your first week') > 0 && at(html, 'Your first week') < at(html, 'class="dash"'));
  ok('the checklist only lists what is left', !html.includes('Pick your path</span>') && html.includes('Accept your first quest') && html.includes('3 of 5 done'));
  ok('the work is on the left: quests, your path, tools', ['Your freelancer dashboard', 'Active quests', 'Your tools'].every(s => main.includes(s)), ['Your freelancer dashboard', 'Active quests', 'Your tools'].map(s => at(main, s)).join(','));
  ok('...in that order', at(main, 'Active quests') < at(main, 'Your freelancer dashboard') && at(main, 'Your freelancer dashboard') < at(main, 'Your tools'));
  ok('glances are on the right: Got paid, nudges, news, your people', ['Got paid?', 'Nudges', 'News for your path', 'Your people'].every(s => side.includes(s)) && at(side, 'Got paid?') < at(side, 'Nudges') && at(side, 'Nudges') < at(side, 'News for your path') && at(side, 'News for your path') < at(side, 'Your people'));
  ok('three nudges at most', html.includes('Three members on your path') && !html.includes('A fourth nudge'));
  ok('no lone "tasks done" tile when the ladder and sprints are off', !html.includes('class="stat-row"'));
  ok('Got paid still logs to the income log', side.includes('action="/budget/income"') && side.includes('name="from" value="dashboard"'));

  console.log('\nNew members and the switched-off features:');
  const fresh = render({ needsPath: true, yourPath: null, pathPanel: null, pathTools: dash.featuredFor(null), checklist: null, pinned: [], coach: [], feedPeek: [], following: false, pathNews: [] });
  ok('no path yet: "pick your path" leads the page', !fresh.startsWith('ERR') && fresh.includes('Start here: pick your path') && at(fresh, 'pick your path') < at(fresh, 'class="dash"'));
  ok('...and empty cards stay away', !fresh.includes('Active quests') && !fresh.includes('Nudges') && !fresh.includes('News for your path'));
  ok('...but Got paid and finding people are there', fresh.includes('Got paid?') && fresh.includes('Find members'));
  const flagsOn = Object.assign({}, FLAGS, { ladder: true, sprints: true, analytics: true });
  const weeks = Array.from({ length: 8 }, (_, i) => ({ label: 'W' + i, tasksDone: i, xp: i * 10 }));
  const full = render({ flags: flagsOn, sprint: { sprint_number: 2, theme: 'Land two clients', goal: 'Two signed', start_date: '2026-11-01', end_date: '2026-11-07', tasks_done: 1, tasks_total: 3, velocity_pct: 33 }, tasks: [{ id: 't1', title: 'Email Jo', priority: 'high', status: 'todo' }],
    ladder: { next: { level: 3, title: 'Earner', emoji: '💰' }, blocker: 'xp', xpNeeded: 160, doneCount: 2, needMin: 2, quests: [], unlocks: [] },
    analytics: { weeks, maxTasks: 7, maxXp: 70, totalDone: 28, totalXp: 280, openTasks: 4 } });
  ok('with every feature on it still renders', !full.startsWith('ERR'), full.startsWith('ERR') ? full.slice(0, 300) : undefined);
  const fullMain = full.slice(at(full, 'class="dash-main"'), at(full, 'class="dash-side"'));
  ok('the sprint sits with the work, above your path, the next rung with the glances', fullMain.includes('Sprint 2: Land two clients') && at(fullMain, 'Sprint 2') < at(fullMain, 'dashboard</h2>') && full.slice(at(full, 'class="dash-side"')).includes('Next rung'));
  ok('quests no longer repeat the sprint that sits right below them', !full.includes('Tasks ↓'));
  ok('the stat strip comes back when there is more than one number', full.includes('class="stat-row"'));
  ok('progress charts fold away until opened', /<details class="card analytics">/.test(full));

  console.log('\nStyles:');
  const css = read('public/css/style.css');
  ok('two columns, one on a phone', /\.dash \{ display: grid; grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\)/.test(css) && /@media \(max-width: 900px\) \{ \.dash \{ grid-template-columns: 1fr/.test(css));
  ok('the stylesheet version was bumped', read('views/partials/head.ejs').includes('style.css?v=20'));

  if (process.env.DASH_OUT) {
    const shell = h => h.replace('href="/css/style.css?v=20"', 'href="' + path.join(ROOT, 'public/css/style.css') + '"');
    fs.writeFileSync(path.join(process.env.DASH_OUT, 'dash.html'), shell(html));
    fs.writeFileSync(path.join(process.env.DASH_OUT, 'dash-new.html'), shell(fresh));
    fs.writeFileSync(path.join(process.env.DASH_OUT, 'dash-full.html'), shell(full));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
