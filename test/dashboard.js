// The dashboard overview (views/dashboard.ejs): onboarding on top, then two
// columns, the work on the left and quick glances on the right. A workspace,
// not a coach: nothing on it tells a member what to do next.
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
const dashData = require('../src/dashboard_data');
const dashLayout = require('../src/dashboard_layout');
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
    { label: 'Set up your dashboard', done: true, href: '/choose-path/setup', cta: 'Set up' },
    { label: 'Log a number or add a card to a board', done: true, href: '/workspace', cta: 'Open workspace' },
    { label: 'Introduce yourself to the community', done: true, href: '/community/c/introductions', cta: 'Say hello' },
    { label: 'Ask or answer a question in Q&A', done: false, href: '/community', cta: 'Open Q&A' },
    { label: 'Follow three members', done: false, href: '/members', cta: 'Find people' }
  ] };
  const pinned = [{ id: 'a1', challenge_id: 'c1', duration_days: 7, due_date: '2026-11-09', challenge: { title: 'Send three cold pitches', emoji: '📨', xp_reward: 50, requires_proof: false } }];
  const coach = [
    { message: 'Your pipeline has a lead with no follow-up for 5 days.', cta_href: '/workspace', cta_label: 'Follow up' },
    { message: 'You logged income last month but not this month.', cta_href: '/budget', cta_label: 'Log it' },
    { message: 'Three members on your path posted wins this week.', cta_href: '/feed', cta_label: 'See' },
    { message: 'A fourth nudge that should not show.', cta_href: '/x', cta_label: 'X' }
  ];
  // Money and the week ahead, from fakes shaped like the real tables.
  const moneyReq = { user: { id: 'me' }, sb: fakeSb({
    revenue_entries: [
      { id: 'r1', amount: 1200, entry_date: '2026-11-02', source: 'Acme', is_recurring: true },
      { id: 'r2', amount: 450.5, entry_date: '2026-11-04', source: 'Sale', is_recurring: false },
      { id: 'r3', amount: 2000, entry_date: '2026-10-12', source: 'Acme', is_recurring: true }
    ],
    expenses: [], payment_connections: { status: 'active', last_synced_at: '2026-11-05T12:00:00Z' }, premium_tool_data: []
  }) };
  moneyReq.sb.from = (orig => t => (t === 'payment_connections' ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'active', last_synced_at: '2026-11-05T12:00:00Z' }, error: null }) }) }) }) } : orig(t)))(moneyReq.sb.from);
  const money = await dashData.moneyGlance(moneyReq, now);
  const upcoming = await dashData.upcoming(fakeSb({
    pipeline_items: [
      { id: 'p1', board: 'fl_clients', stage: 'proposal', title: 'Send the Acme proposal', due_on: '2026-11-07' },
      { id: 'p2', board: 'fl_clients', stage: 'paid', title: 'Already paid, not shown', due_on: '2026-11-06' },
      { id: 'p3', board: 'fl_clients', stage: 'lead', title: 'Too far out', due_on: '2026-11-30' }
    ],
    tasks: [{ id: 't1', title: 'Invoice Bloom Studio', due_date: '2026-11-03', status: 'todo' }, { id: 't2', title: 'Done already', due_date: '2026-11-06', status: 'done' }],
    checklist_progress: []
  }), 'me', { pinned: [{ due_date: '2026-11-09', challenge: { title: 'Send three cold pitches' } }], now });
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
    checklist, sprintSuggestions: [], feedPeek, following: true, rungTitle: () => '',
    layout: dashLayout.resolve(null, FLAGS), money, upcoming, whenLabel: d => dashData.whenLabel(d, now)
  };
  const render = data => { try { return ejs.render(read('views/dashboard.ejs'), Object.assign({}, base, data), { filename: path.join(ROOT, 'views/dashboard.ejs') }); } catch (e) { return 'ERR ' + e.message; } };
  const at = (html, s) => html.indexOf(s);

  console.log('The overview, as members see it today:');
  const html = render({});
  const topHtml = html.slice(at(html, 'class="dash-top'), at(html, 'class="dash-main"'));
  ok('it renders', !html.startsWith('ERR'), html.startsWith('ERR') ? html.slice(0, 300) : undefined);
  const main = html.slice(at(html, 'class="dash-main"'), at(html, 'class="dash-side"'));
  const side = html.slice(at(html, 'class="dash-side"'));
  ok('onboarding comes before the columns', at(html, 'Your first week') > 0 && at(html, 'Your first week') < at(html, 'class="dash"'));
  ok('the checklist only lists what is left', !html.includes('Set up your dashboard</span>') && html.includes('Ask or answer a question in Q&amp;A') && html.includes('3 of 5 done'));
  ok('the work is on the left: your challenges, your path, tools', ['Your challenges', 'Your freelancer dashboard', 'Your tools'].every(s => main.includes(s)), ['Your challenges', 'Your freelancer dashboard', 'Your tools'].map(s => at(main, s)).join(','));
  ok('...in that order', at(main, 'Your challenges') < at(main, 'Your freelancer dashboard') && at(main, 'Your freelancer dashboard') < at(main, 'Your tools'));
  ok('glances are on the right: Got paid, news, your people', ['Got paid?', 'News for your path', 'Your people'].every(s => side.includes(s)) && at(side, 'Got paid?') < at(side, 'News for your path') && at(side, 'News for your path') < at(side, 'Your people'));
  ok('no coaching: no nudges, no "Next:" step, no quests', !html.includes('Nudges') && !html.includes('Three members on your path') && !/Next:/.test(html) && !/\bquests?\b/i.test(html.replace(/\/quests/g, '')));
  ok('no lone "tasks done" tile when the ladder and sprints are off', !html.includes('class="stat-row"'));
  ok('money and the week ahead run across the top', topHtml.includes('Money in November') && topHtml.includes('Coming up this week') && at(topHtml, 'Money in') < at(topHtml, 'Coming up'));
  ok('money: this month, the recurring part, tax to put aside, last month', ['$1,651', '$1,200', '2 payments', 'Last month $2,000', '$350 to go to match it', 'Stripe syncing'].every(x => topHtml.includes(x)), ['$1,651', '$1,200', 'Last month $2,000', '$350 to go'].map(x => topHtml.includes(x)).join(','));
  ok('...with the tax share worked out from the rate', money.rate > 0 && topHtml.includes('$' + Math.round(1650.5 * money.rate / 100).toLocaleString('en-US') + '</span><span class="muted small">to put aside for tax'));
  ok('coming up: overdue first, then by day, done cards and done tasks left out', upcoming.items.map(i => i.title).join(' | ') === 'Invoice Bloom Studio | Send the Acme proposal | Send three cold pitches', upcoming.items.map(i => i.title).join(' | '));
  ok('...labelled late, by weekday, and linked to the card', topHtml.includes('2 days late') && topHtml.includes('Sat 7') && topHtml.includes('href="/workspace/boards/fl_clients/p1"') && topHtml.includes('Mon 9'));
  ok('Got paid still logs to the income log', side.includes('action="/budget/income"') && side.includes('name="from" value="dashboard"'));

  console.log('\nNew members and the switched-off features:');
  const fresh = render({ needsPath: true, yourPath: null, pathPanel: null, pathTools: dash.featuredFor(null), checklist: null, pinned: [], coach: [], feedPeek: [], following: false, pathNews: [] });
  ok('no path yet: "pick your path" leads the page', !fresh.startsWith('ERR') && fresh.includes('Start here: pick your path') && at(fresh, 'pick your path') < at(fresh, 'class="dash"'));
  ok('...and empty cards stay away', !fresh.includes('Your challenges') && !fresh.includes('News for your path'));
  ok('...but Got paid and finding people are there', fresh.includes('Got paid?') && fresh.includes('Find members'));
  const flagsOn = Object.assign({}, FLAGS, { ladder: true, sprints: true, analytics: true });
  const weeks = Array.from({ length: 8 }, (_, i) => ({ label: 'W' + i, tasksDone: i, xp: i * 10 }));
  const full = render({ flags: flagsOn, layout: dashLayout.resolve(null, flagsOn), sprint: { sprint_number: 2, theme: 'Land two clients', goal: 'Two signed', start_date: '2026-11-01', end_date: '2026-11-07', tasks_done: 1, tasks_total: 3, velocity_pct: 33 }, tasks: [{ id: 't1', title: 'Email Jo', priority: 'high', status: 'todo' }],
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
  ok('two columns, one on a phone, in the phone order', /\.dash \{ display: grid; grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\)/.test(css) && /@media \(max-width: 900px\) \{\s*\.dash \{ display: flex; flex-direction: column; \}\s*\.dash-top, \.dash-main, \.dash-side \{ display: contents; \}\s*\.dash-sec \{ order: var\(--m-order/.test(css));
  ok('the stylesheet version was bumped', read('views/partials/head.ejs').includes('style.css?v=21'));

  console.log('\nYour own layout:');
  const flags = FLAGS;
  const L = dashLayout.resolve(null, flags);
  ok('the standard order: money, the week; challenges, path, tools; paid, news, people', L.top.join() === 'money,upcoming' && L.main.join() === 'challenges,path,tools' && L.side.join() === 'paid,news,people', [L.top, L.main, L.side].map(a => a.join()).join(' / '));
  ok('switched-off features are not offered', !L.all.some(s => s.key === 'sprint' || s.key === 'ladder'));
  ok('a phone shows the top, then Got paid, then the work, then the rest', L.mobile.join() === 'money,upcoming,paid,challenges,path,tools,news,people', L.mobile.join());
  let st = dashLayout.apply(null, { action: 'up', key: 'tools' }, flags);
  st = dashLayout.apply(st, { action: 'up', key: 'tools' }, flags);
  st = dashLayout.apply(st, { action: 'hide', key: 'news' }, flags);
  st = dashLayout.apply(st, { action: 'down', key: 'upcoming' }, flags);   // already last in its column: no change
  const L2 = dashLayout.resolve(st, flags);
  ok('moving up skips a switched-off section and stays in its column', L2.main.join() === 'tools,challenges,path', L2.main.join());
  ok('hidden sections leave the page but stay on the customize list', !L2.side.includes('news') && L2.all.find(s => s.key === 'news').shown === false);
  ok('moving past the end does nothing', L2.top.join() === 'money,upcoming');
  ok('reset clears it; nonsense is refused', dashLayout.apply(st, { action: 'reset' }, flags) === null && dashLayout.apply(st, { action: 'up', key: 'nope' }, flags) === undefined && dashLayout.apply(st, { action: 'up', key: 'ladder' }, flags) === undefined);
  const junk = dashLayout.resolve({ order: ['people', 'people', 'bogus', 'money'], hidden: ['bogus'] }, flags);
  ok('junk in the stored value is cleaned; missing sections come back in place', junk.side.join() === 'people,paid,news' && junk.top.join() === 'money,upcoming', [junk.top, junk.main, junk.side].map(a => a.join()).join(' / '));
  const custom = render({ layout: L2 });
  const cMain = custom.slice(at(custom, 'class="dash-main"'), at(custom, 'class="dash-side"'));
  ok('the dashboard follows the member\'s order', at(cMain, 'Your tools') < at(cMain, 'Your challenges') && !custom.includes('News for your path'));
  ok('each section carries its phone position', custom.includes('dash-sec-paid" style="--m-order:3"') && custom.includes('dash-sec-money" style="--m-order:1"'));
  ok('there is a way to customize it', custom.includes('href="/dashboard/customize"'));
  const onlyTop = render({ layout: dashLayout.resolve({ hidden: ['upcoming'] }, flags) });
  ok('one top card spans the width', onlyTop.includes('class="dash-top one"') && !onlyTop.includes('Coming up this week'));
  const noData = render({ money: { month: '2026-11', thisMonth: 0, lastMonth: 0, payments: 0, recurring: 0, rate: 30, setAside: 0, empty: true, stripe: null }, upcoming: { items: [], more: 0, total: 0 } });
  ok('an empty income log points at the three ways to fill it', noData.includes('href="/budget/import"') && noData.includes('href="/budget/connect/stripe"'));
  ok('an empty week says so', noData.includes('Nothing dated in the next seven days'));

  const page = (data) => { try { return ejs.render(read('views/dashboard_customize.ejs'), Object.assign({}, base, data), { filename: path.join(ROOT, 'views/dashboard_customize.ejs') }); } catch (e) { return 'ERR ' + e.message; } };
  const cz = page({ layout: L2, cols: { top: 'Across the top', main: 'Left column', side: 'Right column' }, ready: true, msg: null });
  ok('the customize page renders every column with up, down and hide', !cz.startsWith('ERR') && ['Across the top', 'Left column', 'Right column'].every(x => cz.includes(x)) && (cz.match(/name="action" value="up"/g) || []).length === L2.all.length, cz.startsWith('ERR') ? cz.slice(0, 300) : undefined);
  ok('...hidden ones can be shown again, and the layout reset', cz.includes('value="show"') && cz.includes('value="reset"'));
  const czOff = page({ layout: L, cols: { top: 'a', main: 'b', side: 'c' }, ready: false, msg: null });
  ok('before the migration runs, the buttons are off and it says so', czOff.includes('being switched on') && !czOff.includes('value="reset"') && /value="hide"><button class="btn btn-ghost btn-sm" disabled>/.test(czOff));

  if (process.env.DASH_OUT) {
    fs.writeFileSync(path.join(process.env.DASH_OUT, 'dash-custom.html'), cz.replace('href="/css/style.css?v=21"', 'href="' + path.join(ROOT, 'public/css/style.css') + '"'));
    const shell = h => h.replace('href="/css/style.css?v=21"', 'href="' + path.join(ROOT, 'public/css/style.css') + '"');
    fs.writeFileSync(path.join(process.env.DASH_OUT, 'dash.html'), shell(html));
    fs.writeFileSync(path.join(process.env.DASH_OUT, 'dash-new.html'), shell(fresh));
    fs.writeFileSync(path.join(process.env.DASH_OUT, 'dash-full.html'), shell(full));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
