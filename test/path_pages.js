// The path pages (src/path_pages.js, src/routes/paths_public.js,
// src/routes/choose_path.js, views/path_landing.ejs, views/paths_index.ejs,
// views/choose_path.ejs): each path's page shows its real dashboard, the money
// and community every member gets, and that path's community; /paths compares
// them side by side; switching path keeps a member's answers.
//
//   node test/path_pages.js        (PATH_OUT=dir also writes the pages as HTML)

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
const paths = require('../src/paths');
const pages = require('../src/path_pages');
const { FLAGS } = require('../src/features');

const base = { title: 'Paths', user: null, profile: null, plan: 'free', currentPath: '/paths', canonicalUrl: 'https://nobossly.com/paths', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
const render = (view, data) => { try { return ejs.render(read('views/' + view), Object.assign({}, base, data), { filename: path.join(ROOT, 'views', view) }); } catch (e) { return 'ERR ' + e.message; } };
const visible = html => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const COACHING = /\b(quests?|electives?|next (real )?step|fit test|playbooks?|step-by-step|curriculum|nudges?)\b/i;

function run(router, method, url, { body = {}, query = {}, sb, profile } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user: { id: 'me' },
      profile: Object.assign({ id: 'me', username: 'me', onboarding_completed: true }, profile || {}) };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
      redirect(to) { resolve({ redirect: to }); }, render(view, data) { resolve({ view, data }); } };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}
function fakeSb(rpc) {
  const writes = [];
  const from = (table) => {
    const chain = new Proxy({}, { get(_, k) {
      if (k === 'then') return (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
      if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p) => { writes.push({ table, op: k, payload: p }); return chain; };
      return () => chain;
    } });
    return chain;
  };
  const calls = [];
  return { from, writes, calls, rpc: (name, args) => { calls.push({ name, args }); return Promise.resolve(rpc ? rpc(name, args) : { data: null, error: null }); } };
}

(async () => {
  console.log('\nWords:');
  ok('"a freelancer", "an online store"', pages.withArticle('Freelancer') === 'a freelancer' && pages.withArticle('Online store') === 'an online store');
  ok('the exploring path has its own button words', pages.wordsFor(paths.get('exploring')).cta === 'Start free, still figuring it out' && pages.wordsFor(paths.get('exploring')).noun === 'exploring');
  ok('...and a coach or consultant reads right', pages.wordsFor(paths.get('consultant')).cta === 'Start free as a coach or consultant');

  console.log('\nWhat each path is:');
  const list = pages.compare();
  ok('the comparison has every marketed path and no other', list.length === paths.MARKETED.length && list.every(p => paths.get(p.slug).marketing));
  ok('...each with numbers and tools from its dashboard config', list.every(p => p.numbers.length && p.tools.length));
  ok('...and the kinds of work it covers, without "Something else"', list.find(p => p.slug === 'freelancer').kinds.includes('Design and brand') && list.every(p => !p.kinds.some(k => /something else/i.test(k))));
  ok('"choose your path" offers every path, marketed or not', pages.choices().length === paths.PATHS.length && pages.choices().some(p => p.slug === 'physical_product'));

  console.log('\nThe community on a path:');
  ok('nothing readable gives null', pages.shape(null) === null && pages.shape('x') === null);
  const small = pages.shape({ members: 3, questions: 2, replied: 1, recent: [{ id: 't1', title: 'How do you price a logo?', replies: 2, answered: true }, { id: null, title: 'no id' }], sessions: 1, next_session_at: '2026-11-13T18:00:00Z' });
  ok('a small number is not shown as a number', small.members === 3 && small.showCount === false);
  ok('...and a big one is', pages.shape({ members: pages.SHOW_COUNT_FROM }).showCount === true);
  ok('questions need an id and a title', small.recent.length === 1 && small.recent[0].answered === true);
  ok('the next session is a date', small.nextSessionAt instanceof Date && small.sessions === 1);
  pages.clearCache();
  const sb = fakeSb(() => ({ data: { members: 12, questions: 4, replied: 3, recent: [], sessions: 0 }, error: null }));
  const c1 = await pages.community(sb, 'freelancer', 1000);
  const c2 = await pages.community(sb, 'freelancer', 2000);
  ok('it is read through path_community()', sb.calls.length === 1 && sb.calls[0].name === 'path_community' && sb.calls[0].args.p_path === 'freelancer' && c1.members === 12);
  ok('...and cached for a few minutes', c2 === c1 && sb.calls.length === 1);
  await pages.community(sb, 'freelancer', 1000 + 6 * 60 * 1000);
  ok('...then read again', sb.calls.length === 2);
  ok('a made-up path is not read at all', (await pages.community(sb, 'nope')) === null && sb.calls.length === 2);
  pages.clearCache();
  ok('before the migration (an error) it is null, not a crash', (await pages.community(fakeSb(() => ({ data: null, error: { message: 'function does not exist' } })), 'creator')) === null);
  pages.clearCache();
  ok('...and a thrown error too', (await pages.community({ rpc: () => { throw new Error('down'); } }, 'creator')) === null);

  console.log('\nA path page:');
  const def = paths.get('freelancer');
  const people = pages.shape({ members: 24, questions: 3, replied: 2, recent: [{ id: 'aaaa-1', title: 'How do you price a logo?', replies: 2, answered: true }, { id: 'aaaa-2', title: 'Invoicing late payers', replies: 0 }], sessions: 2, next_session_at: '2026-11-13T18:00:00Z' });
  const html = render('path_landing.ejs', pages.landingLocals(def, people));
  const text = visible(html);
  ok('it renders', !html.startsWith('ERR'), html.startsWith('ERR') ? html.slice(0, 300) : undefined);
  ok('the button reads "Start free as a freelancer" and keeps the path', html.includes('Start free as a freelancer →') && html.includes('href="/signup?path=freelancer"'));
  ok('the dashboard preview has its numbers, boards and tools', ['Billable income', 'Client pipeline', 'Invoices', 'Proposal &amp; quote'].every(s => html.includes(s)) && html.includes('Your freelancer dashboard'));
  ok('...and no stage list or checklist templates', !html.includes('Checklist templates') && !html.includes('Where you are'));
  ok('...it says it is what a new member sees, not made-up numbers', text.includes('before they have logged anything') && !/\$\d/.test(html.slice(html.indexOf('pl-frame'), html.indexOf('pl-kinds'))));
  ok('the kinds of freelancer it covers', html.includes('Design and brand') && html.includes('What it covers'));
  ok('money and community every member gets, with real screenshots', html.includes('src="/img/home/money.jpg"') && html.includes('src="/img/home/community.jpg"') && (html.match(/loading="lazy"/g) || []).length >= 2);
  ok('the community: a count once it is big enough', text.includes('24 members are on this path'));
  ok('...recent questions link to the thread', html.includes('href="/community/t/aaaa-1"') && text.includes('How do you price a logo?') && text.includes('Answered') && text.includes('0 replies'));
  ok('...co-working coming up', text.includes('2 sessions coming up, the next on Fri, Nov 13'));
  const quiet = render('path_landing.ejs', pages.landingLocals(def, pages.shape({ members: 2, recent: [], sessions: 0 })));
  ok('a young path says so instead of "2 members"', visible(quiet).includes('just getting started') && !visible(quiet).includes('2 members'));
  ok('...and invites the first question', visible(quiet).includes('Ask the first one') && visible(quiet).includes('None booked right now'));
  const none = render('path_landing.ejs', pages.landingLocals(def, null));
  ok('without the community data the page still renders', !none.startsWith('ERR') && visible(none).includes('just getting started'));
  ok('its own share image and canonical URL', html.includes('content="https://nobossly.com/img/paths/freelancer.jpg"') && html.includes('<link rel="canonical" href="https://nobossly.com/paths/freelancer">'));
  const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
  let parsed = null; try { parsed = JSON.parse(ld); } catch (_) {}
  ok('breadcrumbs for search', parsed && parsed[0]['@type'] === 'BreadcrumbList' && parsed[0].itemListElement.length === 3);
  ok('it reads as a workspace and a community, not a program', !COACHING.test(text), (text.match(COACHING) || [])[0]);
  for (const p of paths.MARKETED) {
    const h = render('path_landing.ejs', pages.landingLocals(p, null));
    if (h.startsWith('ERR') || /as an? still|Start free as a [aeiou]/i.test(h) || !h.includes(pages.wordsFor(p).cta)) { ok(p.slug + ' renders with the right button', false, h.slice(0, 200)); }
    const img = path.join(ROOT, 'public/img/paths', p.slug + '.jpg');
    if (!fs.existsSync(img) || fs.statSync(img).size > 150 * 1024) ok(p.slug + ' has a share image under 150KB', false);
  }
  ok('every path page renders with the right button and has a share image', true);
  ok('the exploring page says "Start free, still figuring it out"', render('path_landing.ejs', pages.landingLocals(paths.get('exploring'), null)).includes('Start free, still figuring it out'));

  console.log('\n/paths:');
  const idx = render('paths_index.ejs', pages.indexLocals());
  const itext = visible(idx);
  ok('it renders', !idx.startsWith('ERR'), idx.startsWith('ERR') ? idx.slice(0, 300) : undefined);
  ok('a column per path, side by side', list.every(p => idx.includes('<th scope="col" class="c-' + p.slug + '">')) && ['What it is', 'Your numbers', 'Boards', 'Tools up front', 'Covers'].every(s => idx.includes('<th scope="row" class="cmp-row-h">' + s)));
  ok('...each with a way to start and to read more', list.every(p => idx.includes('href="/signup?path=' + p.slug + '"') && idx.includes('href="/paths/' + p.slug + '"')));
  ok('untick a path to hide its column (no JavaScript)', list.every(p => idx.includes('id="cmp-' + p.slug + '" checked') && idx.includes('.cmp:has(#cmp-' + p.slug + ':not(:checked)) .c-' + p.slug + ' { display: none; }')));
  ok('...the boxes stay off-screen and the chips show focus', /\.cmp-box \{ position: absolute; opacity: 0;[^}]*width: 1px/.test(idx) && idx.includes('.cmp-box:focus-visible + .cmp-chip'));
  ok('the table scrolls inside itself, not the page', /\.cmp-scroll \{ overflow-x: auto/.test(idx) && idx.includes('role="region"'));
  ok('"Still deciding?" without coaching words', itext.includes('Still figuring it out') && itext.includes('never picks for you') && !COACHING.test(itext) && !/small two-week experiments to narrow it down/.test(itext), (itext.match(COACHING) || [])[0]);
  let ild = null; try { ild = JSON.parse((idx.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1]); } catch (_) {}
  ok('a list of paths for search', ild && ild[0]['@type'] === 'ItemList' && ild[0].itemListElement.length === list.length);

  console.log('\nChoosing a path:');
  const choose = require('../src/routes/choose_path');
  const g = await run(choose, 'GET', '/', { profile: { path: 'creator', saved_paths: { freelancer: { subpath: 'design', answers: { stage: 'x' } } } } });
  ok('the page knows the path, the saved ones and that answers are kept', g.view === 'choose_path' && g.data.current === 'creator' && g.data.saved.join() === 'freelancer' && g.data.keepsAnswers === true);
  const cp = render('choose_path.ejs', g.data);
  const ctext = visible(cp);
  ok('it renders', !cp.startsWith('ERR'), cp.startsWith('ERR') ? cp.slice(0, 300) : undefined);
  ok('a card per path, the current one checked', pages.choices().every(p => cp.includes('id="cp-' + p.slug + '"')) && /id="cp-creator" checked/.test(cp));
  ok('a preview of what each puts first', pages.choices().every(p => cp.includes('cp-panel-' + p.slug)) && cp.includes('#cp-freelancer:checked ~ .cp-panels .cp-panel-freelancer { display: block; }'));
  ok('...cards show focus and the radios do not stretch the page', cp.includes('#cp-freelancer:focus-visible ~ .cp-grid') && /\.cp-radio \{ position: absolute; opacity: 0;[^}]*width: 1px/.test(cp));
  ok('it says switching keeps everything', ctext.includes('You are on 🎬 Content creator') && ctext.includes('Switching keeps everything you have logged') && ctext.includes('switching back brings them back'));
  ok('...and marks the paths with saved answers', ctext.includes('Your answers are saved') && ctext.includes('Your path now'));
  const fresh = render('choose_path.ejs', (await run(choose, 'GET', '/', { profile: { path: null } })).data);
  ok('a new member is asked what they are building, nothing checked', !fresh.startsWith('ERR') && visible(fresh).includes('What are you building?') && !/type="radio"[^>]*checked/.test(fresh) && visible(fresh).includes('Use this path'));
  const before = render('choose_path.ejs', (await run(choose, 'GET', '/', { profile: { path: 'creator' } })).data);
  ok('before the migration it does not promise saved answers', visible(before).includes('asks its own few setup questions') && !visible(before).includes('switching back brings them back'));

  console.log('\nSwitching:');
  const prof = { path: 'creator', subpath: 'podcast', path_answers: { stage: 'Posting occasionally', platform: 'Podcast' }, saved_paths: { freelancer: { subpath: 'design', answers: { stage: 'Some regular clients' } } } };
  const sp = pages.switchPatch(prof, 'freelancer');
  ok('the old path\'s answers are put aside', sp.saved_paths.creator && sp.saved_paths.creator.subpath === 'podcast' && sp.saved_paths.creator.answers.platform === 'Podcast');
  ok('...and the new path\'s come back', sp.subpath === 'design' && sp.path_answers.stage === 'Some regular clients' && !('freelancer' in sp.saved_paths));
  const sp2 = pages.switchPatch({ path: 'creator', subpath: null, path_answers: {}, saved_paths: null }, 'software');
  ok('a path never set up starts fresh, nothing empty is saved', sp2.subpath === null && JSON.stringify(sp2.path_answers) === '{}' && JSON.stringify(sp2.saved_paths) === '{}');
  const sp3 = pages.switchPatch({ path: 'creator', subpath: 'podcast', path_answers: {}, saved_paths: { freelancer: { subpath: 'not-a-subpath', answers: [] } } }, 'freelancer');
  ok('a saved subpath that no longer exists is dropped', sp3.subpath === null && JSON.stringify(sp3.path_answers) === '{}');
  ok('choosing the same path changes nothing', JSON.stringify(pages.switchPatch(prof, 'creator')) === '{}');
  ok('before the migration it starts again, as it did', JSON.stringify(pages.switchPatch({ path: 'creator', subpath: 'x', path_answers: { a: 1 } }, 'freelancer')) === '{"subpath":null,"path_answers":{}}');
  {
    const s = fakeSb();
    const r = await run(choose, 'POST', '/', { sb: s, profile: prof, body: { path: 'freelancer' } });
    const w = s.writes.find(x => x.table === 'profiles');
    ok('the route saves the switch in one write', !!w && w.payload.path === 'freelancer' && w.payload.subpath === 'design' && w.payload.saved_paths.creator.subpath === 'podcast' && r.redirect === '/choose-path/setup', JSON.stringify(w && w.payload));
  }
  {
    const s = fakeSb();
    await run(choose, 'POST', '/setup', { sb: s, profile: { path: 'freelancer', subpath: 'design', path_answers: {}, saved_paths: { creator: {} } }, body: { subpath: 'design', stage: 'Some regular clients' } });
    const w = s.writes.find(x => x.table === 'profiles');
    ok('setup leaves the saved answers alone', !!w && !('saved_paths' in w.payload));
  }

  console.log('\nThe migration:');
  const sql = read('migrations/2026-11-10_path_pages.sql');
  ok('it is marked as applied, and saved_paths is in the live snapshot', /^-- Applied live/.test(sql) && !require('./schema-pending.json').migrations['2026-11-10_path_pages.sql'] && require('./schema-snapshot.json').columns.profiles.includes('saved_paths'));
  ok('path_community is read-only, security definer, open to visitors', /returns jsonb language plpgsql stable security definer set search_path to 'public'/.test(sql) && /grant execute on function public.path_community\(text\) to anon, authenticated/.test(sql));
  ok('...and returns no names or member ids', !/username|display_name|'user_id'|host_id/.test(sql.slice(sql.indexOf('jsonb_build_object'), sql.indexOf('into out'))));

  if (process.env.PATH_OUT) {
    const fix = h => h.replace(/href="\/css\/([a-z]+)\.css\?v=\d+"/g, (m, n) => 'href="' + path.join(ROOT, 'public/css/' + n + '.css') + '"').replace(/src="\/img\//g, 'src="' + path.join(ROOT, 'public/img') + '/');
    fs.writeFileSync(path.join(process.env.PATH_OUT, 'path.html'), fix(html));
    fs.writeFileSync(path.join(process.env.PATH_OUT, 'paths.html'), fix(idx));
    fs.writeFileSync(path.join(process.env.PATH_OUT, 'choose.html'), fix(render('choose_path.ejs', Object.assign({}, g.data, { user: { id: 'me' }, profile: { id: 'me', username: 'me', path: 'creator' } }))));
  }
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
