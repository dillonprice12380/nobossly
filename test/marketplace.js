// The marketplace: programs and courses from approved providers.
//
// The database rules (who may publish, apply, accept, read lessons) are tested
// against a real Postgres in test/db/marketplace.sql — `npm run test:db`.
// This file tests the app on top of them:
//
//  - input cleaning, prices, video embeds and filters (src/marketplace.js);
//  - routes ask the database (RPCs and RLS) and degrade before the migration;
//  - provider content is cleaned, links are safe, video embeds are allow-listed;
//  - every page renders; login can send you back to what you were applying to;
//  - the migration is written for review and opens nothing else to anon.
//
//   node test/marketplace.js

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

const mk = require('../src/marketplace');
const rt = require('../src/workspace/richtext');
const { FLAGS } = require('../src/features');

const ME = '00000000-0000-0000-0000-0000000000aa';
const LID = '20000000-0000-0000-0000-000000000001';
const LESSON = '40000000-0000-0000-0000-000000000001';
const LESSON2 = '40000000-0000-0000-0000-000000000002';
const EID = '50000000-0000-0000-0000-000000000001';
const NO_FN = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.marketplace_listings' } };

function fakeSb(tables = {}, rpcs = {}) {
  const calls = [];
  const from = table => {
    const state = { table, op: 'select', payload: null, filters: [] };
    calls.push(state);
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = tables[table];
          let out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          if (state.single && Array.isArray(out.data)) out = { data: out.data[0] || null, error: out.error };
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p, o) => { state.op = k; state.payload = p; state.opts = o; return chain; };
        if (k === 'maybeSingle' || k === 'single') return () => { state.single = true; return chain; };
        return (...args) => { state.filters.push([k].concat(args)); return chain; };
      }
    });
    return chain;
  };
  const rpc = (name, args) => {
    calls.push({ rpc: name, args });
    const a = rpcs[name];
    return Promise.resolve(typeof a === 'function' ? a(args) : (a || { data: null, error: null }));
  };
  return { from, rpc, calls };
}

function run(router, method, url, { body = {}, sb, user = { id: ME }, profile, headers = {}, mount = '' } = {}) {
  return new Promise(resolve => {
    const q = {};
    new URL('http://x' + url).searchParams.forEach((v, k) => { q[k] = v; });
    const req = {
      method, url, originalUrl: mount + url, body, query: q, params: {}, sb, user, headers,
      get: h => headers[h] || headers[String(h).toLowerCase()],
      profile: user ? Object.assign({ id: ME, username: 'mo', display_name: 'Mo', path: 'freelancer' }, profile || {}) : null
    };
    const res = {
      statusCode: 200, headers: {}, locals: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      end() { resolve({ status: this.statusCode, ended: true }); },
      redirect(a, b) { resolve({ redirect: b || a, status: b ? a : 302 }); },
      render(view, data) { resolve({ view, data, status: this.statusCode }); }
    };
    router.handle(req, res, e => resolve({ error: e || 'next' }));
  });
}

const PAGE = {
  id: LID, slug: 'start-here', kind: 'course', title: 'Start Here', summary: 'A self-paced course for month one.',
  description: '<p>Learn <b>fast</b>. <a href="https://example.com/x">Reading</a></p><script>bad()</script>',
  paths: ['freelancer'], format: 'online', location: null, price_cents: null, price_note: null, external_url: null,
  join_mode: 'enroll', questions: [], starts_on: null, ends_on: null, apply_by: null, status: 'published', seats_left: null, has_cohort: false,
  org: { name: 'Launch Lab', slug: 'launch-lab', kind: 'educator', tagline: 'We teach', about: 'About us', website_url: 'https://launchlab.example' },
  outline: [{ title: 'Week 1', lessons: [{ title: 'Pick a problem', minutes: 10 }, { title: 'Talk to people', minutes: null }] }],
  mine: null, team: false
};
const PROGRAM = Object.assign({}, PAGE, { slug: 'spring', kind: 'program', title: 'Spring Program', join_mode: 'apply', questions: ['What are you building?', 'Hours a week?'], price_cents: 45000, price_note: 'scholarships', external_url: 'https://launchlab.example/pay', has_cohort: true, outline: [] });

(async () => {
  console.log('Cleaning what providers type:');
  {
    const good = mk.cleanListing({ title: 'Spring Program', summary: 'Twelve weeks with mentors.', price: '$1,200.50', external_url: 'https://x.example/pay', paths: ['freelancer', 'nope'], questions: ['One?', '', 'Two?'], format: 'hybrid', location: 'Boston', capacity: '25', starts_on: '2027-03-01', ends_on: '2027-05-31', description: '<p onclick="x">Hi <a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a></p>' });
    ok('a full listing cleans', !good.error && good.row.price_cents === 120050 && good.row.capacity === 25, JSON.stringify(good.error));
    ok('...unknown paths and blank questions are dropped', JSON.stringify(good.row.paths) === '["freelancer"]' && JSON.stringify(good.row.questions) === '["One?","Two?"]');
    ok('...the description keeps safe links and loses scripts and javascript: links', /href="https:\/\/ok\.example" rel="noopener noreferrer nofollow" target="_blank"/.test(good.row.description) && !/javascript|onclick/.test(good.row.description));
    ok('a blank price is free', mk.cleanListing({ title: 'Free one', summary: 'A free course for all.' }).row.price_cents === null);
    ok('"free" is free too', mk.cents('Free') === null && mk.cents('0') === null);
    ok('a price that is not a number is refused', !!mk.cleanListing({ title: 'Bad price', summary: 'Bad price listing here', price: 'lots' }).error);
    ok('a paid listing needs a sign-up link', /needs a link/.test(mk.cleanListing({ title: 'Paid', summary: 'A paid course here.', price: '50' }).error));
    ok('only http(s) links are accepted', /must start with/.test(mk.cleanListing({ title: 'Linky', summary: 'A course with a link.', external_url: 'javascript:alert(1)' }).error));
    ok('in person needs a place', /where it takes place/.test(mk.cleanListing({ title: 'Meetup', summary: 'An in-person course.', format: 'in_person' }).error));
    ok('an end before the start is refused', /before the start/.test(mk.cleanListing({ title: 'Dates', summary: 'A course with dates.', starts_on: '2027-03-01', ends_on: '2027-02-01' }).error));
    ok('prices read well', mk.priceLabel({ price_cents: 45000, price_note: 'per month' }) === '$450 · per month' && mk.priceLabel({ price_cents: 4999 }) === '$49.99' && mk.priceLabel({}) === 'Free');
    const lesson = mk.cleanLesson({ title: 'Lesson', video_url: 'https://youtu.be/dQw4w9WgXcQ', minutes: '12', tool_key: 'lean_canvas', body: '<p>Hi</p><img src=x onerror=alert(1)>' }, ['lean_canvas']);
    ok('a lesson cleans', !lesson.error && lesson.row.minutes === 12 && lesson.row.tool_key === 'lean_canvas' && lesson.row.body === '<p>Hi</p>');
    ok('...a video must be https', /https/.test(mk.cleanLesson({ title: 'x', video_url: 'http://youtu.be/abcdefg' }).error || ''));
    ok('...and an unknown task is dropped', mk.cleanLesson({ title: 'x', tool_key: 'nope' }, ['lean_canvas']).row.tool_key === null);
  }

  console.log('\nVideos embed only from YouTube, Vimeo and Loom:');
  {
    ok('YouTube (watch, short link, shorts) uses the no-cookie player', mk.embedOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
       && mk.embedOf('https://youtu.be/dQw4w9WgXcQ') === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' && mk.embedOf('https://youtube.com/shorts/dQw4w9WgXcQ') === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    ok('Vimeo', mk.embedOf('https://vimeo.com/123456789') === 'https://player.vimeo.com/video/123456789');
    ok('Loom', mk.embedOf('https://www.loom.com/share/abc123def456') === 'https://www.loom.com/embed/abc123def456');
    ok('anything else is a plain link, not an iframe', mk.embedOf('https://evil.example/watch?v=dQw4w9WgXcQ') === null && mk.embedOf('https://youtube.com.evil.example/watch?v=abcdefgh') === null);
    ok('ids cannot smuggle a path or script', mk.embedOf('https://www.youtube.com/watch?v=x"><script>') === null && mk.embedOf('http://youtu.be/dQw4w9WgXcQ') === null);
  }

  console.log('\nBrowsing:');
  {
    const items = [
      { slug: 'a', kind: 'course', title: 'Pricing basics', summary: 'Set your rate', org_name: 'Launch Lab', org_slug: 'launch-lab', paths: ['freelancer'], price_cents: null, format: 'online' },
      { slug: 'b', kind: 'program', title: 'Spring accelerator', summary: 'Twelve weeks', org_name: 'EforAll', org_slug: 'eforall', paths: [], price_cents: 50000, format: 'in_person' },
      { slug: 'c', kind: 'course', title: 'Shop launch', summary: 'Online stores', org_name: 'Launch Lab', org_slug: 'launch-lab', paths: ['online_store'], price_cents: 2000, format: 'online' }
    ];
    const f = q => mk.filter(items, q).shown.map(x => x.slug).join('');
    ok('by kind', f({ kind: 'course' }) === 'ac' && f({ kind: 'program' }) === 'b');
    ok('by path (listings for every path always show)', f({ path: 'freelancer' }) === 'ab');
    ok('by price', f({ price: 'free' }) === 'a' && f({ price: 'paid' }) === 'bc');
    ok('by format', f({ format: 'in_person' }) === 'b');
    ok('by words, across title, summary and provider', f({ q: 'eforall' }) === 'b' && f({ q: 'launch lab shop' }) === 'c');
    ok('by provider', f({ provider: 'launch-lab' }) === 'ac');
    ok('junk filters are ignored', f({ kind: 'x', path: 'y', price: 'z', format: 'w', provider: '<x>' }) === 'abc');
  }

  console.log('\nThe member side:');
  const programs = require('../src/routes/programs');
  {
    const sb = fakeSb({}, { marketplace_listings: { data: [{ slug: 'a', kind: 'course', title: 'T', summary: 'S', org_name: 'O', org_slug: 'o', paths: [], format: 'online' }], error: null } });
    const r = await run(programs, 'GET', '/?kind=course', { sb });
    ok('the marketplace lists what the database returns', r.view === 'programs/index' && r.data.items.length === 1 && r.data.chosen.kind === 'course');
    const nr = await run(programs, 'GET', '/', { sb: fakeSb({}, { marketplace_listings: NO_FN }) });
    ok('...and says "being set up" before the migration', nr.data.notReady === true);
    const show = await run(programs, 'GET', '/start-here', { sb: fakeSb({}, { listing_page: { data: PAGE, error: null } }) });
    ok('a listing page renders from listing_page()', show.view === 'programs/show' && show.data.l.title === 'Start Here');
    ok('...with its description cleaned (links kept, scripts gone)', show.data.desc.includes('href="https://example.com/x"') && !show.data.desc.includes('script'));
    const missing = await run(programs, 'GET', '/nope-nope', { sb: fakeSb({}, { listing_page: { data: null, error: null } }) });
    ok('an unlisted slug is a 404', missing.status === 404);
    const signedOut = await run(programs, 'POST', '/start-here/join', { sb: fakeSb(), user: null, mount: '/programs' });
    ok('joining signed out goes to log in, and back', signedOut.redirect === '/login?next=' + encodeURIComponent('/programs/start-here'));
    const enroll = fakeSb({}, { listing_page: { data: PAGE, error: null }, listing_join: { data: 'enrolled', error: null } });
    const er = await run(programs, 'POST', '/start-here/join', { sb: enroll });
    ok('enrolling in a course goes through listing_join() and opens the course', enroll.calls.some(c => c.rpc === 'listing_join' && c.args.p_listing === LID) && /^\/learn\/start-here/.test(er.redirect));
    const unanswered = fakeSb({}, { listing_page: { data: PROGRAM, error: null } });
    const ur = await run(programs, 'POST', '/spring/join', { sb: unanswered, body: { answers: ['Only one'] } });
    ok('applying needs every question answered', /err=/.test(ur.redirect) && !unanswered.calls.some(c => c.rpc === 'listing_join'));
    const apply = fakeSb({}, { listing_page: { data: PROGRAM, error: null }, listing_join: { data: 'applied', error: null } });
    const ar = await run(programs, 'POST', '/spring/join', { sb: apply, body: { answers: ['A bakery', 'Ten'] } });
    ok('...then the answers are sent in order', JSON.stringify(apply.calls.find(c => c.rpc === 'listing_join').args.p_answers) === '["A bakery","Ten"]' && /msg=/.test(ar.redirect));
    const full = await run(programs, 'POST', '/start-here/join', { sb: fakeSb({}, { listing_page: { data: PAGE, error: null }, listing_join: { data: 'full', error: null } }) });
    ok('a refusal is explained', /err=This%20is%20full/.test(full.redirect));
    const w = fakeSb({}, { listing_page: { data: PROGRAM, error: null }, listing_withdraw: { data: true, error: null } });
    await run(programs, 'POST', '/spring/withdraw', { sb: w });
    ok('withdrawing goes through listing_withdraw()', w.calls.some(c => c.rpc === 'listing_withdraw'));
    const mine = await run(programs, 'GET', '/mine', { sb: fakeSb({}, { my_listings: { data: [], error: null } }) });
    ok('"My programs" comes from my_listings()', mine.view === 'programs/mine');
    const toTeam = await run(programs, 'GET', '/enrollment/' + EID, { sb: fakeSb({
      listing_enrollments: { data: [{ user_id: 'someone-else', listing_id: LID }], error: null },
      listings: { data: [{ id: LID, slug: 'spring', org_id: 'o1' }], error: null },
      organizations: { data: [{ slug: 'launch-lab' }], error: null } }) });
    ok('a team member\'s notification opens the applicants', toTeam.redirect === '/orgs/launch-lab/listings/' + LID + '/people');
    const toMe = await run(programs, 'GET', '/enrollment/' + EID, { sb: fakeSb({
      listing_enrollments: { data: [{ user_id: ME, listing_id: LID }], error: null }, listings: { data: [{ id: LID, slug: 'spring', org_id: 'o1' }], error: null } }) });
    ok('...a member\'s opens the listing', toMe.redirect === '/programs/spring');
  }

  console.log('\nTaking a course:');
  const learn = require('../src/routes/learn');
  {
    const tables = {
      course_modules: { data: [{ id: 'm1', title: 'Week 1', position: 0 }], error: null },
      course_lessons: s => s.single ? { data: { id: LESSON, title: 'Pick a problem', body: '<p>Body</p><script>x()</script>', video_url: 'https://youtu.be/dQw4w9WgXcQ', tool_key: 'lean_canvas', minutes: 10 }, error: null }
        : { data: [{ id: LESSON, module_id: 'm1', title: 'Pick a problem' }, { id: LESSON2, module_id: 'm1', title: 'Talk to people' }], error: null },
      lesson_progress: s => ({ data: s.op === 'select' ? [{ lesson_id: LESSON }] : null, error: null })
    };
    const enrolled = Object.assign({}, PAGE, { mine: { status: 'enrolled' } });
    const locked = await run(learn, 'GET', '/start-here', { sb: fakeSb(tables, { listing_page: { data: PAGE, error: null } }) });
    ok('not enrolled: back to the listing to enroll', /^\/programs\/start-here\?err=/.test(locked.redirect));
    const c = await run(learn, 'GET', '/start-here', { sb: fakeSb(tables, { listing_page: { data: enrolled, error: null } }) });
    ok('enrolled: the outline, with progress and the next lesson', c.view === 'learn/course' && c.data.doneCount === 1 && c.data.total === 2 && c.data.nextLesson.id === LESSON2);
    const lsn = await run(learn, 'GET', '/start-here/' + LESSON, { sb: fakeSb(tables, { listing_page: { data: enrolled, error: null } }) });
    ok('a lesson renders cleaned, with its video and task', lsn.view === 'learn/lesson' && lsn.data.body === '<p>Body</p>' && /youtube-nocookie/.test(lsn.data.embed) && lsn.data.tool.key === 'lean_canvas' && lsn.data.next.id === LESSON2);
    const sb = fakeSb(tables, { listing_page: { data: enrolled, error: null } });
    const d = await run(learn, 'POST', '/start-here/' + LESSON + '/done', { sb });
    const up = sb.calls.find(x => x.table === 'lesson_progress' && x.op === 'upsert');
    ok('marking done records progress for this course, then moves on', up && up.payload.listing_id === LID && up.payload.user_id === ME && d.redirect === '/learn/start-here/' + LESSON2);
    const team = Object.assign({}, PAGE, { team: true });
    const tsb = fakeSb(tables, { listing_page: { data: team, error: null } });
    const t = await run(learn, 'POST', '/start-here/' + LESSON + '/done', { sb: tsb });
    ok('the team can preview, but records no progress', !tsb.calls.some(x => x.table === 'lesson_progress' && x.op === 'upsert') && t.redirect === '/learn/start-here');
  }

  console.log('\nBecoming a provider:');
  const providers = require('../src/routes/providers');
  {
    const tables = { provider_applications: { data: [], error: null }, org_admins: { data: [], error: null } };
    const sb = fakeSb(tables, { provider_apply: { data: 'app-1', error: null } });
    const r = await run(providers, 'POST', '/apply', { sb, body: { org_name: 'Launch Lab', kind: 'educator', offers: ['course', 'nope'], about: 'We teach people to start a business.', contact_email: 'Hi@Example.com' } });
    const call = sb.calls.find(c => c.rpc === 'provider_apply');
    ok('an application goes through provider_apply()', call && JSON.stringify(call.args.p_offers) === '["course"]' && call.args.p_email === 'hi@example.com' && /msg=/.test(r.redirect));
    const bad = fakeSb(tables, {});
    const b = await run(providers, 'POST', '/apply', { sb: bad, body: { org_name: 'X', kind: 'educator', offers: 'course', about: 'short' } });
    ok('a thin application is sent back, not sent on', b.status === 400 && !bad.calls.some(c => c.rpc));
    const out = await run(providers, 'GET', '/apply', { sb: fakeSb(), user: null });
    ok('applying needs an account (and comes back after logging in)', out.redirect === '/login?next=/providers/apply');
    const land = await run(providers, 'GET', '/', { sb: fakeSb(), user: null });
    ok('the providers page is public', land.view === 'providers/landing');
  }

  console.log('\nThe provider console:');
  const consoleR = require('../src/routes/org_listings');
  {
    const ORG = { id: 'o1', name: 'Launch Lab', slug: 'launch-lab', provider: true };
    const team = (extra = {}, rpcs = {}) => fakeSb(Object.assign({ organizations: { data: [ORG], error: null }, org_admins: { data: [{ role: 'owner' }], error: null } }, extra), rpcs);
    const outsider = await run(consoleR, 'GET', '/launch-lab/listings', { sb: fakeSb({ organizations: { data: [], error: null } }) });
    ok('not on the team: 404', outsider.status === 404);
    const notMine = await run(consoleR, 'GET', '/launch-lab/listings', { sb: fakeSb({ organizations: { data: [ORG], error: null }, org_admins: { data: [], error: null } }) });
    ok('an organization you can see but are not on: 404', notMine.status === 404);
    const list = await run(consoleR, 'GET', '/launch-lab/listings', { sb: team({ listings: { data: [{ id: LID, kind: 'course', title: 'T', status: 'draft', updated_at: '2026-11-03' }], error: null }, listing_enrollments: { data: [{ listing_id: LID, status: 'applied' }], error: null } }) });
    ok('the console lists listings with waiting applicants', list.view === 'orgs/listings' && list.data.counts[LID].applied === 1);
    const csb = team({ listings: s => ({ data: s.op === 'insert' ? { id: LID } : [], error: null }) });
    const created = await run(consoleR, 'POST', '/launch-lab/listings', { sb: csb, body: { kind: 'course', title: 'Your first ten customers', summary: 'Find and keep your first ten.' } });
    const ins = csb.calls.find(c => c.table === 'listings' && c.op === 'insert');
    ok('a new listing starts as a draft for this organization', ins && ins.payload.org_id === 'o1' && !ins.payload.status && ins.payload.slug === 'your-first-ten-customers' && created.redirect.startsWith('/orgs/launch-lab/listings/' + LID));
    const mineSlug = team({ listings: s => ({ data: s.op === 'insert' ? { id: LID } : [], error: null }) });
    await run(consoleR, 'POST', '/launch-lab/listings', { sb: mineSlug, body: { kind: 'course', title: 'Mine', summary: 'A course called Mine.' } });
    ok('a title cannot take over /programs/mine', mineSlug.calls.find(c => c.op === 'insert').payload.slug === 'mine-course');
    const L = { id: LID, org_id: 'o1', kind: 'course', title: 'T', slug: 'start-here', status: 'draft', join_mode: 'enroll' };
    const pub = team({ listings: { data: [L], error: null }, course_lessons: { data: null, count: 0, error: null } });
    const p = await run(consoleR, 'POST', '/launch-lab/listings/' + LID + '/status', { sb: pub, body: { status: 'published' } });
    ok('a course needs a lesson before it can be published', /err=Add%20at%20least%20one%20lesson/.test(p.redirect) && !pub.calls.some(c => c.op === 'update'));
    const save = team({ listings: { data: [L], error: null } });
    const s = await run(consoleR, 'POST', '/launch-lab/listings/' + LID, { sb: save, body: { title: 'Title two', summary: 'A short summary here.', cohort: 'not-a-uuid', description: '<p>Hi<script>x</script></p>' } });
    const upd = save.calls.find(c => c.op === 'update');
    ok('saving cleans the description and keeps only a real cohort id', upd && upd.payload.description === '<p>Hi</p>' && upd.payload.group_id === null && /msg=Saved/.test(s.redirect));
    const dec = team({ listings: { data: [L], error: null } }, { listing_decide: { data: 'enrolled', error: null } });
    await run(consoleR, 'POST', '/launch-lab/listings/' + LID + '/people/' + EID, { sb: dec, body: { action: 'accept', note: 'Welcome' } });
    ok('accepting goes through listing_decide()', dec.calls.some(c => c.rpc === 'listing_decide' && c.args.p_action === 'accept' && c.args.p_note === 'Welcome'));
    const lsb = team({ listings: { data: [L], error: null }, course_lessons: { data: null, error: null } });
    const auto = await run(consoleR, 'POST', '/launch-lab/listings/' + LID + '/lessons/' + LESSON, { sb: lsb, body: { title: 'L', body: '<p>x</p>' }, headers: { 'X-Autosave': '1' } });
    ok('a lesson autosaves (204), cleaned', auto.status === 204 && lsb.calls.find(c => c.op === 'update').payload.body === '<p>x</p>');
    ok('no route writes enrollments or applications directly', !/from\('(listing_enrollments|provider_applications)'\)\.(insert|update|upsert|delete)/.test(read('src/routes/org_listings.js') + read('src/routes/programs.js') + read('src/routes/providers.js') + read('src/routes/admin.js')));
  }

  console.log('\nLogging in can send you back:');
  {
    const auth = read('src/routes/auth.js');
    ok('login keeps a safe "next" path only', /const nextOf = v => \{ const p = relativePath\(v\)/.test(auth) && /res\.redirect\(next \|\| '\/dashboard'\)/.test(auth));
    const { relativePath } = require('../src/safe_back');
    ok('...an outside URL is never followed', relativePath('https://evil.example') === null && relativePath('//evil.example') === null && relativePath('/programs/x') === '/programs/x');
  }

  console.log('\nThe pages render:');
  {
    const V = f => path.join(ROOT, 'views', f);
    const base = {
      title: 'T', user: { id: ME }, profile: { id: ME, username: 'mo', is_admin: true }, plan: 'paid', currentPath: '/programs', canonicalUrl: 'x',
      unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
      isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, richHtml: rt.clean,
      affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
    };
    const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message.split('\n').slice(-2).join(' '); } };
    const pages = {
      'programs/index.ejs': { mk, items: [{ slug: 'a', kind: 'course', title: 'Pricing basics', summary: 'Set your rate', org_name: 'Launch Lab', paths: [], price_cents: null, format: 'online', lessons: 4 }], total: 1, chosen: { kind: '', path: '', price: '', format: '', q: '', provider: '' }, myPath: 'freelancer', notReady: false },
      'programs/show.ejs': { mk, l: PROGRAM, desc: '<p>Hi</p>', signedIn: true },
      'programs/mine.ejs': { mk, items: [{ status: 'enrolled', slug: 'a', kind: 'course', title: 'C', org_name: 'O', lessons: 4, done: 1 }], notReady: false },
      'learn/course.ejs': { mk, l: PAGE, modules: [{ id: 'm1', title: 'Week 1', lessons: [{ id: LESSON, title: 'Pick' }] }], done: new Set([LESSON]), total: 1, doneCount: 1, nextLesson: null, preview: false },
      'learn/lesson.ejs': { mk, l: PAGE, modules: [{ id: 'm1', title: 'Week 1', lessons: [{ id: LESSON, title: 'Pick' }] }], done: new Set(), lesson: { id: LESSON, title: 'Pick', minutes: 5, video_url: 'https://youtu.be/dQw4w9WgXcQ' }, body: '<p>Body</p>', embed: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', tool: { key: 'lean_canvas', def: require('../src/workspace/worksheets').WORKSHEETS.lean_canvas }, prev: null, next: null, isDone: false, position: 1, total: 1, preview: false },
      'providers/landing.ejs': { mk, apps: [], orgs: [], notReady: false },
      'providers/apply.ejs': { mk, apps: [{ id: 'a', org_name: 'Launch Lab', status: 'pending', created_at: '2026-11-03' }], orgs: [], notReady: false, form: {} },
      'admin/providers.ejs': { mk, apps: [{ id: 'a', user_id: ME, org_name: 'Launch Lab', kind: 'educator', offers: ['course'], about: 'About', status: 'pending', created_at: '2026-11-03' }], orgs: [{ id: 'o1', name: 'EforAll', slug: 'eforall', kind: 'accelerator', provider: false }], pmap: { [ME]: { username: 'mo' } }, notReady: false },
      'orgs/listings.ejs': { mk, org: { name: 'Launch Lab', slug: 'launch-lab', provider: false }, myRole: 'owner', listings: [{ id: LID, kind: 'course', title: 'T', status: 'draft', updated_at: '2026-11-03', join_mode: 'enroll' }], counts: {}, notReady: false },
      'orgs/listing_new.ejs': { mk, org: { slug: 'launch-lab' }, kind: 'program' },
      'orgs/listing_edit.ejs': { mk, org: { slug: 'launch-lab', provider: true }, myRole: 'owner', l: Object.assign({}, PROGRAM, { org_id: 'o1', description: '<p>Desc <a href="https://ok.example">link</a></p>', group_id: null, capacity: null }), cohorts: [{ id: 'g1', name: 'Spring' }], lessons: 0 },
      'orgs/listing_people.ejs': { mk, org: { slug: 'launch-lab' }, l: Object.assign({}, PROGRAM, { id: LID }), rows: [{ id: EID, user_id: ME, status: 'applied', answers: [{ q: 'What?', a: 'A bakery' }], created_at: '2026-11-03' }, { id: 'e2', user_id: 'u2', status: 'enrolled', answers: [], created_at: '2026-11-03' }], pmap: { [ME]: { username: 'mo', path: 'freelancer' } }, done: {}, lessons: 0, paths: require('../src/paths') },
      'orgs/curriculum.ejs': { mk, org: { slug: 'launch-lab' }, l: Object.assign({}, PAGE, { id: LID }), modules: [{ id: 'm1', title: 'Week 1', lessons: [{ id: LESSON, title: 'Pick', minutes: 5, video_url: 'x' }] }] },
      'orgs/lesson_edit.ejs': { mk, org: { slug: 'launch-lab' }, l: Object.assign({}, PAGE, { id: LID }), lesson: { id: LESSON, title: 'Pick', body: '<p>B</p>', video_url: 'https://example.com/v' }, tools: require('../src/routes/org_listings').TOOLS, embed: null }
    };
    for (const [f, data] of Object.entries(pages)) {
      const html = render(f, data);
      ok(`${f} renders`, !html.startsWith('ERR') && html.length > 500, html.startsWith('ERR') ? html : undefined);
    }
    const show = render('programs/show.ejs', pages['programs/show.ejs']);
    ok('a paid program says payment is the provider\'s, and asks its questions', show.includes('Payment is handled by Launch Lab') && show.includes('What are you building?') && show.includes('name="answers"'));
    const out = render('programs/show.ejs', Object.assign({}, pages['programs/show.ejs'], { signedIn: false, user: null }));
    ok('signed out, it offers to log in and come back', out.includes('/login?next=' + encodeURIComponent('/programs/spring')));
    const lesson = render('learn/lesson.ejs', pages['learn/lesson.ejs']);
    ok('a lesson embeds only the allow-listed player', /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ"/.test(lesson) && lesson.includes('/workspace/docs/lean_canvas'));
    const edit = render('orgs/listing_edit.ejs', pages['orgs/listing_edit.ejs']);
    ok('the listing editor keeps the description\'s links for editing', edit.includes('data-rt-links') && edit.includes('href=&#34;https://ok.example&#34;'));
  }

  console.log('\nNavigation and notifications:');
  {
    const appnav = read('views/partials/appnav.ejs');
    ok('"Programs & courses" is a Community page', /key: 'programs', href: '\/programs', label: 'Programs & courses'/.test(appnav) && /match: \['\/community', '\/feed', '\/groups', '\/programs', '\/learn'/.test(appnav));
    ok('the account menu has My programs and For providers', /href="\/programs\/mine"/.test(read('views/partials/head.ejs')) && /href="\/providers"/.test(read('views/partials/head.ejs')));
    ok('the organization page links to the provider console', read('views/orgs/show.ejs').includes('/listings">Open the provider console'));
    const n = read('src/routes/notifications.js');
    ok('notifications about applications lead somewhere useful', n.includes("listing_enrollments: id => '/programs/enrollment/' + id") && n.includes("provider_applications: id => '/providers/application/' + id"));
    ok('the marketplace is behind its own flag, on', FLAGS.marketplace === true && /app\.use\('\/programs', requireFlag\('marketplace'\)/.test(read('server.js')));
    ok('courses need an account to open', /app\.use\('\/learn', requireAuth, requireFlag\('marketplace'\)/.test(read('server.js')));
    ok('the admin has a providers page', /<a href="\/admin\/providers">/.test(read('views/admin/nav.ejs')));
  }

  console.log('\nThe migration:');
  {
    const sql = read('migrations/2026-11-03_marketplace.sql');
    ok('it is marked as applied', /^-- Applied live 2026-11-03/.test(sql));
    const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
    const open = fns.filter(f => !new RegExp(`revoke all on function public\\.${f}\\([^)]*\\)\\s+from public`).test(sql));
    ok('every function has its default access revoked', open.length === 0, open.join(', ') || fns.length + ' functions');
    const anonFns = [...sql.matchAll(/grant execute on function public\.(\w+)\([^)]*\)\s+to anon/g)].map(m => m[1]).sort();
    ok('anon can only browse and open listing pages', JSON.stringify(anonFns) === '["listing_page","marketplace_listings"]', anonFns.join(', '));
    const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map(m => m[1]);
    ok('every new table has row-level security', tables.every(t => new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(sql)), tables.join(', '));
    ok('the only table anon can read is published listings', /grant select on public\.listings to anon/.test(sql) && /create policy listings_select_anon on public\.listings for select to anon\s+using \(status in \('published','closed'\)\)/.test(sql));
    ok('applications and enrollments are written only through functions', /revoke insert, update, delete on public\.provider_applications, public\.listing_enrollments from authenticated/.test(sql));
    ok('only approved providers publish', /This organization is not approved to publish yet/.test(sql));
    ok('the database tests cover it', /signed-out visitors can browse/.test(read('test/db/marketplace.sql')) && /marketplace/.test(read('test/db/run.sh')));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
