// NoBossly is a workspace and a community, not an incubator or a self-directed
// accelerator (2026-11-08). Nothing a member sees should hand down a
// curriculum: no curated quests to accept, no "next step", no coaching nudges.
// Programs that DO teach (accelerators, courses) run on NoBossly through the
// marketplace and private cohorts; that is the line.
//
//   node test/positioning.js

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
const COACHING = /\b(quests?|electives?|next (real )?step|fit test|playbooks?|step-by-step|curriculum|nudges?)\b/i;
const visible = html => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function fakeSb(rows = {}, counts = {}) {
  const chain = table => {
    const q = new Proxy({}, { get(_, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: rows[table] || [], count: counts[table] || 0, error: null }).then(res, rej);
      if (prop === 'maybeSingle') return () => Promise.resolve({ data: (rows[table] || [])[0] || null, error: null });
      return () => q;
    } });
    return q;
  };
  return { from: t => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) };
}

const base = {
  title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me' }, plan: 'free', currentPath: '/quests', canonicalUrl: 'x',
  unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
  isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null,
  affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
};
const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: path.join(ROOT, 'views', f) }); } catch (e) { return 'ERR ' + e.message; } };

function run(router, method, url, body, sb) {
  return new Promise(resolve => {
    const req = { method, url, body: body || {}, query: {}, params: {}, sb, user: { id: 'me' }, profile: { id: 'me', username: 'me', current_level: 1 } };
    const res = { locals: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, redirect(t) { resolve({ redirect: t }); }, render(v, d) { resolve({ view: v, data: d }); }, json(d) { resolve({ json: d }); } };
    router.handle(req, res, e => resolve({ error: e || 'next' }));
  });
}

(async () => {
  console.log('Challenges are community challenges:');
  {
    const router = require('../src/routes/challenges');
    const soon = new Date(Date.now() + 3 * 86400000).toISOString();
    const later = new Date(Date.now() + 10 * 86400000).toISOString();
    const rows = {
      challenges: [
        { id: 'w1', slug: 'weekly-cohort-2026-11-09', title: 'Weekly challenge — week of Nov 9', description: 'Pick one goal of your own for this week.', emoji: '🗓', is_cohort: true, is_active: true, starts_at: soon, ends_at: later, requires_proof: true },
        { id: 'q1', slug: 'validate', title: 'Validate your idea', description: 'Talk to five customers.', emoji: '🔬', is_cohort: false, is_active: true },
        { id: 'q2', slug: 'first100', title: 'Earn Your First $100', description: '...', emoji: '💵', is_cohort: false, is_active: true }
      ],
      challenge_acceptances: [{ challenge_id: 'q2', status: 'active', due_date: '2026-11-30' }],
      user_custom_challenges: [], cohort_waitlist: []
    };
    const page = await run(router, 'GET', '/', null, fakeSb(rows));
    ok('/quests renders the challenges page', page.view === 'challenges', page.error && String(page.error));
    const html = page.view ? render('challenges.ejs', page.data) : 'ERR';
    const text = visible(html);
    ok('the weekly community challenge is listed, with a Join button', html.includes('Weekly challenge — week of Nov 9') && html.includes('action="/quests/w1/accept"'));
    ok('the curated library is gone: nothing new to accept', !html.includes('Validate your idea') && !html.includes('action="/quests/q1/accept"') && !html.includes('Core quests') && !html.includes('Electives'));
    ok('a challenge a member already has open stays, so they can finish or leave it', html.includes('Earn Your First $100') && html.includes('action="/quests/q2/finish"') && html.includes('action="/quests/q2/abandon"'));
    ok('the page reads as community, not coaching', !COACHING.test(text), (text.match(COACHING) || [])[0]);

    const curated = await run(router, 'POST', '/q1/accept', {}, fakeSb({ challenges: [rows.challenges[1]] }));
    ok('accepting a curated quest is refused', /retired/.test(decodeURIComponent(curated.redirect || '')), curated.redirect);
    const elective = await run(router, 'POST', '/tailored/t1/accept', {}, fakeSb());
    const reopen = await run(router, 'POST', '/custom/c1/accept', {}, fakeSb());
    ok('...and so are electives, new or re-opened', /retired/.test(decodeURIComponent(elective.redirect || '')) && /retired/.test(decodeURIComponent(reopen.redirect || '')));
    const weekly = await run(router, 'POST', '/w1/accept', {}, fakeSb({ challenges: [rows.challenges[0]] }));
    ok('joining the weekly challenge still works', weekly.redirect === '/quests', weekly.redirect || String(weekly.error));
  }

  console.log('\nThe weekly challenge words (migration):');
  {
    const sql = read('migrations/2026-11-08_weekly_challenge_wording.sql');
    ok('the migration is marked as applied', /^-- Applied live 2026-11-08/.test(sql));
    const fn = sql.slice(sql.indexOf('create or replace function'), sql.indexOf('$function$;'));
    ok('new weeks no longer talk about sprints or tell members how to work', !/sprint|break it into tasks|check in as you go/i.test(fn) && /Pick one goal of your own/.test(fn));
    ok('the weeks already listed are reworded too', /update challenges[\s\S]*Weekly challenge — week of/.test(sql));
  }

  console.log('\nThe first week:');
  {
    const { firstWeek } = require('../src/first_week');
    const fw = await firstWeek(fakeSb({ forum_categories: [{ id: 'intro' }] }), { id: 'me' }, { created_at: new Date().toISOString(), path_answers: {} });
    const labels = fw.steps.map(s => s.label).join(' | ');
    ok('five steps into the workspace and the community', fw.steps.length === 5 && /dashboard/.test(labels) && /board/.test(labels) && /Introduce yourself/.test(labels) && /Q&A/.test(labels) && /Follow three/.test(labels), labels);
    ok('none of them is a quest, a sprint or a check-in', !/\bquests?\b|sprint|check-in/i.test(labels));
    ok('none points at a switched-off feature', fw.steps.every(s => !/#sprint|\/dashboard\/checkin|\/quests/.test(s.href)));
  }

  console.log('\nThe dashboard:');
  {
    const route = read('src/routes/dashboard.js');
    ok('the coaching rules are no longer read', !/getGuidance/.test(route) && !/coach/.test(read('views/dashboard.ejs')));
    const dash = require('../src/path_dashboards');
    const panel = await dash.panelFor(fakeSb(), 'me', { path: 'freelancer', path_answers: { stage: 'Some regular clients' } });
    ok('the path panel hands down no next step', !('next' in panel.stage) && !('checklists' in panel));
    const html = render('partials/path_panel.ejs', { panel, pathInfo: { label: 'Freelancer', emoji: '💻' } });
    ok('...and says none', !html.startsWith('ERR') && !/Next:/.test(html) && html.includes('Where you are:'));
  }

  console.log('\nEmails:');
  {
    const mail = read('src/mailer.js');
    const t = mail.slice(mail.indexOf('const TEMPLATES'), mail.indexOf('const TEMPLATES') + 4000);
    ok('welcome, pick-your-path and come-back emails coach nobody', !/next steps? to take|do the next thing|take one step|the steps and tools/i.test(t));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
