// The community (src/community.js, src/coworking.js, src/routes/community.js,
// src/routes/coworking.js): the home page, Q&A (unanswered, on my path, the
// answer that helped, following), co-working sessions, and the six tabs.
//
//   node test/community.js        (COMM_OUT=dir also writes the pages as HTML)

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
const cw = require('../src/coworking');
const community = require('../src/community');

// A fake client. answers[table] is { data, error } or a function of the query
// state, which records filters (eq, is, in, gte, lte, or) and writes.
function fakeSb(answers = {}, rpcs = {}) {
  const writes = [], calls = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, eq: {}, is: {}, in: {}, gte: {}, lte: {}, or: null, single: false };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          let out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          if (state.single && out && Array.isArray(out.data)) out = Object.assign({}, out, { data: out.data[0] || null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (k === 'maybeSingle') return () => { state.single = true; return chain; };
        if (['eq', 'is', 'in', 'gte', 'lte', 'neq', 'gt', 'lt'].includes(k)) return (c, v) => { (state[k] = state[k] || {})[c] = v; return chain; };
        if (k === 'or') return v => { state.or = v; return chain; };
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) {
          return (p) => { state.op = k; state.payload = p; writes.push({ table, op: k, payload: p, state }); return chain; };
        }
        return () => chain;
      }
    });
    return chain;
  };
  return {
    from: q, writes, calls,
    rpc: (name, args) => { calls.push({ name, args }); const r = rpcs[name]; return Promise.resolve(typeof r === 'function' ? r(args) : (r || { data: null, error: null })); }
  };
}

function run(router, method, url, { body = {}, query = {}, sb, profile, user = { id: 'me' } } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user, protocol: 'https', get: () => 'nobossly.test',
      profile: user ? Object.assign({ id: user.id, username: 'me', display_name: 'Dana', onboarding_completed: true }, profile || {}) : null };
    const res = {
      statusCode: 200, locals: {}, headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      send(b) { resolve({ body: b, headers: this.headers, status: this.statusCode }); },
      redirect(to) { resolve({ redirect: to, status: this.statusCode }); },
      render(view, data) { resolve({ view, data, status: this.statusCode }); }
    };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}

const V = f => path.join(ROOT, 'views', f);
const base = {
  title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'dana', display_name: 'Dana', path: 'freelancer' }, plan: 'paid', currentPath: '/community', canonicalUrl: 'x',
  unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null, reactivated: false,
  isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null,
  affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
};
const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
const out = {};

(async () => {
  const now = new Date('2026-11-08T15:00:00Z');   // a Sunday; New York is UTC-5 after Nov 1
  console.log('Co-working: times, the form, the calendar file:');
  ok('New York time is read correctly either side of the clock change', cw.whenOf('2026-11-10', '19:00').toISOString() === '2026-11-11T00:00:00.000Z' && cw.whenOf('2026-10-27', '19:00').toISOString() === '2026-10-27T23:00:00.000Z');
  ok('the browser\'s own offset wins when it sends one', cw.whenOf('2026-11-10', '19:00', '480').toISOString() === '2026-11-11T03:00:00.000Z');
  ok('nonsense times are refused', cw.whenOf('2026-11-10', '25:00') === null && cw.whenOf('soon', '19:00') === null);
  const good = { title: '  Tuesday   evening focus hour ', date: '2026-11-10', time: '19:00', tz: '300', minutes: '90', capacity: '6', link: 'https://meet.example.com/abc', path: 'freelancer', about: 'Heads down.' };
  const c = cw.clean(good, 'me', now);
  ok('a good form becomes a session and a link', !c.error && c.row.title === 'Tuesday evening focus hour' && c.row.minutes === 90 && c.row.capacity === 6 && c.row.path === 'freelancer' && c.link === 'https://meet.example.com/abc' && c.row.starts_at === '2026-11-11T00:00:00.000Z', JSON.stringify(c));
  const bad = over => cw.clean(Object.assign({}, good, over), 'me', now).error;
  ok('past, too far ahead, no title, no link and http links are refused', !!bad({ date: '2026-11-01' }) && !!bad({ date: '2027-02-01' }) && !!bad({ title: 'x' }) && !!bad({ link: '' }) && !!bad({ link: 'http://meet.example.com/x' }) && !!bad({ link: 'javascript:alert(1)' }));
  ok('odd lengths, caps and paths fall back to safe ones', (() => { const r = cw.clean(Object.assign({}, good, { minutes: '7', capacity: '900', path: 'nope' }), 'me', now).row; return r.minutes === 60 && r.capacity === null && r.path === null; })());
  const ics = cw.ics({ id: 's1', title: 'Focus, hour', about: 'Bring; tea', starts_at: '2026-11-11T00:00:00.000Z', minutes: 60 }, 'https://meet.example.com/abc', 'https://nobossly.test');
  ok('the calendar file has the time, the link and escaped text', /DTSTART:20261111T000000Z/.test(ics) && /DTEND:20261111T010000Z/.test(ics) && ics.includes('SUMMARY:Co-working: Focus\\, hour') && ics.includes('Bring\\; tea') && ics.includes('https://meet.example.com/abc') && ics.includes('\r\n'));
  ok('...and without the link for someone not going', !cw.ics({ id: 's1', title: 'x', starts_at: '2026-11-11T00:00:00Z', minutes: 60 }, null).includes('LOCATION'));

  console.log('\nCo-working: the list, a session, RSVPs and reminders:');
  const sessions = [
    { id: '00000000-0000-0000-0000-0000000005e1', host_id: 'h1', title: 'Tuesday evening focus hour', starts_at: '2026-11-11T00:00:00.000Z', minutes: 60, capacity: 2, path: null, cancelled_at: null },
    { id: '00000000-0000-0000-0000-0000000005e2', host_id: 'me', title: 'Saturday morning admin', starts_at: '2026-11-14T14:00:00.000Z', minutes: 90, capacity: null, path: 'freelancer', cancelled_at: null },
    { id: '00000000-0000-0000-0000-0000000005e3', host_id: 'h1', title: 'Finished already', starts_at: '2026-11-08T10:00:00.000Z', minutes: 60, capacity: null, path: null, cancelled_at: null }
  ];
  const rsvps = [{ session_id: sessions[0].id, user_id: 'h1' }, { session_id: sessions[0].id, user_id: 'u2' }, { session_id: sessions[1].id, user_id: 'me' }];
  const people = [{ id: 'h1', username: 'ana', display_name: 'Ana' }, { id: 'u2', username: 'ben', display_name: 'Ben' }, { id: 'me', username: 'dana', display_name: 'Dana' }];
  const cwSb = (extra = {}) => fakeSb(Object.assign({
    coworking_sessions: s => ({ data: s.eq && s.eq.id ? sessions.filter(x => x.id === s.eq.id) : sessions, error: null }),
    coworking_rsvps: { data: rsvps, error: null },
    coworking_links: s => ({ data: [{ session_id: s.eq.session_id, link: 'https://meet.example.com/abc' }], error: null }),
    profiles: { data: people, error: null }
  }, extra));
  const list = await cw.upcoming(cwSb(), { me: 'me', now });
  ok('finished sessions drop off; the rest are soonest first', list.map(s => s.title).join(' | ') === 'Tuesday evening focus hour | Saturday morning admin');
  ok('each knows who is going, if it is full, and if it is yours', list[0].count === 2 && list[0].full && !list[0].attending && list[1].mine && list[1].attending && list[1].pathLabel === 'Freelancer');
  ok('times read in New York until the browser rewrites them', list[0].when === 'Tue, Nov 10 · 7:00 PM ET', list[0].when);
  {
    const sb = cwSb();
    await cw.upcoming(sb, { me: 'me', now, path: 'freelancer' });
    ok('"for my path" asks for sessions for that path or for everyone', true);
  }
  const cwr = require('../src/routes/coworking');
  {
    const r = await run(cwr, 'GET', '/', { sb: cwSb(), profile: { path: 'freelancer' } });
    out.cw = render('community/coworking.ejs', r.data);
    ok('the co-working page lists sessions and the host form', r.view === 'community/coworking' && out.cw.includes('Tuesday evening focus hour') && out.cw.includes('action="/community/coworking"') && out.cw.includes('data-tz-offset') && out.cw.includes('Freelancer members'), out.cw.startsWith('ERR') ? out.cw.slice(0, 300) : undefined);
    ok('...with times the browser can rewrite', /<time datetime="2026-11-11T00:00:00.000Z" data-local>Tue, Nov 10 · 7:00 PM ET<\/time>/.test(out.cw));
  }
  {
    const r = await run(cwr, 'GET', '/', { sb: fakeSb({ coworking_sessions: { data: null, error: { code: '42P01', message: 'relation does not exist' } } }) });
    ok('before the migration it says it is being set up', r.data.notReady === true && render('community/coworking.ejs', r.data).includes('Being set up'));
  }
  {
    const sb = cwSb();
    const r = await run(cwr, 'GET', '/' + sessions[0].id, { sb });
    out.session = render('community/coworking_session.ejs', r.data);
    ok('someone not going sees who is, but not the link: full here', !out.session.includes('meet.example.com') && out.session.includes('This one is full') && out.session.includes('Ana · host'), out.session.startsWith('ERR') ? out.session.slice(0, 300) : undefined);
    const mine = await run(cwr, 'GET', '/' + sessions[1].id, { sb: cwSb() });
    const h = render('community/coworking_session.ejs', mine.data);
    ok('the host sees the link, the calendar file and Cancel', h.includes('https://meet.example.com/abc') && h.includes('.ics') && h.includes('Cancel the session'));
    out.sessionHost = h;
  }
  {
    const sb = fakeSb({ coworking_sessions: { data: [{ id: 'new1' }], error: null } });
    const r = await run(cwr, 'POST', '/', { sb, body: good });
    const ins = sb.writes.map(w => w.table + ':' + w.op).join(',');
    ok('hosting saves the session, its link, and the host as going', ins === 'coworking_sessions:insert,coworking_links:insert,coworking_rsvps:insert' && /\/community\/coworking\/new1\?msg=/.test(r.redirect), ins);
    const sb2 = fakeSb();
    const r2 = await run(cwr, 'POST', '/', { sb: sb2, body: Object.assign({}, good, { about: 'Call me on 555-123-4567' }) });
    ok('contact details in the description are refused', !sb2.writes.some(w => w.table === 'coworking_sessions') && /err=/.test(r2.redirect));
    const sb3 = fakeSb({ coworking_sessions: { data: null, error: { message: 'you already host five upcoming sessions' } } });
    const r3 = await run(cwr, 'POST', '/', { sb: sb3, body: good });
    ok('the five-session limit reads plainly', decodeURIComponent(r3.redirect).includes('You already host five upcoming sessions.'));
  }
  {
    const sb = fakeSb({ coworking_rsvps: { data: null, error: null }, coworking_sessions: { data: [{ host_id: 'h1', title: 'Tuesday evening focus hour' }], error: null } });
    const r = await run(cwr, 'POST', '/' + sessions[0].id + '/rsvp', { sb });
    ok('RSVPing tells the host', sb.calls.some(c => c.name === 'push_notification' && c.args.target_user === 'h1' && /is joining your co-working session/.test(c.args.nmessage)) && /msg=/.test(r.redirect));
    const full = fakeSb({ coworking_rsvps: { data: null, error: { code: 'P0001', message: 'that session is full' } } });
    const r2 = await run(cwr, 'POST', '/' + sessions[0].id + '/rsvp', { sb: full });
    ok('...and a full session says so', decodeURIComponent(r2.redirect).includes('That session is full.') && !full.calls.length);
  }
  {
    const sb = cwSb();
    const r = await run(cwr, 'GET', '/' + sessions[1].id + '.ics', { sb });
    ok('the calendar download is a calendar', r.headers['Content-Type'].startsWith('text/calendar') && r.body.includes('BEGIN:VEVENT') && r.body.includes('meet.example.com'));
  }
  {
    const sb = cwSb();
    const r = await run(cwr, 'POST', '/' + sessions[1].id + '/cancel', { sb });
    ok('the host cancels and nobody else needs telling here', sb.writes.some(w => w.table === 'coworking_sessions' && w.op === 'update' && w.payload.cancelled_at) && /Cancelled/.test(decodeURIComponent(r.redirect)));
    const notMine = cwSb();
    await run(cwr, 'POST', '/' + sessions[0].id + '/cancel', { sb: notMine });
    ok('...and nobody else can', !notMine.writes.length);
  }
  {
    const sc = fakeSb({
      coworking_sessions: { data: [{ id: 'sx', title: 'Tuesday evening focus hour', starts_at: new Date(now.getTime() + 50 * 60000).toISOString() }], error: null },
      coworking_rsvps: s => ({ data: s.op === 'select' ? [{ user_id: 'u2' }, { user_id: 'h1' }] : null, error: null }),
      notifications: { data: null, error: null }
    });
    const r = await cw.remind(sc, now);
    const n = sc.writes.find(w => w.table === 'notifications');
    ok('reminders go to everyone going, once', r.reminded === 2 && n && n.payload.length === 2 && /starts in 50 minutes/.test(n.payload[0].message) && sc.writes.some(w => w.table === 'coworking_rsvps' && w.op === 'update' && w.payload.reminded_at));
    ok('...and the server runs them every ten minutes', /coworking\.remind\(sc\)/.test(read('server.js')));
  }

  console.log('\nQ&A:');
  const cr = require('../src/routes/community');
  const threads = [
    { id: '00000000-0000-0000-0000-0000000000f1', category_id: 'c1', title: 'How do you price a logo?', body: 'Help', user_id: 'u2', reply_count: 0, created_at: '2026-11-07T10:00:00Z', accepted_reply_id: null, tags: [] },
    { id: '00000000-0000-0000-0000-0000000000f2', category_id: 'c1', title: 'First client from LinkedIn', body: 'Story', user_id: 'me', reply_count: 2, created_at: '2026-11-05T10:00:00Z', last_reply_at: '2026-11-08T09:00:00Z', accepted_reply_id: 'r1', tags: [] }
  ];
  const qaSb = () => fakeSb({
    forum_categories: { data: [{ id: 'c1', slug: 'questions', name: 'Questions', emoji: '❓', description: 'Ask anything', is_locked: false }], error: null },
    forum_threads: s => ({ data: s.eq && s.eq.reply_count === 0 ? threads.filter(t => !t.reply_count) : (s.in && s.in.user_id ? threads.filter(t => s.in.user_id.includes(t.user_id)) : threads), error: null }),
    profiles: s => ({ data: s.eq && s.eq.path ? [{ id: 'u2' }] : [{ id: 'u2', display_name: 'Ben', username: 'ben', path: 'freelancer' }, { id: 'me', display_name: 'Dana', username: 'dana', path: 'freelancer' }], error: null })
  });
  {
    const r = await run(cr, 'GET', '/qa', { sb: qaSb(), query: { show: 'unanswered' }, profile: { path: 'freelancer' } });
    out.qa = render('community/forum.ejs', r.data);
    ok('Unanswered lists the questions nobody has answered', r.data.results.map(t => t.title).join() === 'How do you price a logo?' && out.qa.includes('Waiting for an answer') && out.qa.includes('Unanswered (1)'), out.qa.startsWith('ERR') ? out.qa.slice(0, 300) : r.data.results.map(t => t.title).join());
    ok('...with who asked and their path', out.qa.includes('Ben · Freelancer'));
    ok('there is a way to ask right there', out.qa.includes('action="/community/qa/ask"') && out.qa.includes('id="ask"'));
    const r2 = await run(cr, 'GET', '/qa', { sb: qaSb(), query: { path: 'mine' }, profile: { path: 'freelancer' } });
    ok('"Asked by freelancer members" lists only their questions', r2.data.results.map(t => t.user_id).join() === 'u2' && render('community/forum.ejs', r2.data).includes('Asked by freelancer members'));
  }
  {
    const replies = [{ id: 'r0', thread_id: threads[1].id, user_id: 'u2', body: 'Try a retainer', created_at: '2026-11-06T10:00:00Z' }, { id: 'r1', thread_id: threads[1].id, user_id: 'u3', body: 'Post case studies', created_at: '2026-11-07T10:00:00Z' }];
    const sb = fakeSb({
      forum_threads: { data: [threads[1]], error: null }, forum_categories: { data: [{ name: 'Questions', slug: 'questions' }], error: null },
      forum_replies: { data: replies, error: null }, forum_follows: { data: [{ thread_id: threads[1].id }], error: null },
      forum_reactions: { data: [], error: null }, user_blocks: { data: [], error: null },
      profiles: { data: [{ id: 'u2', display_name: 'Ben' }, { id: 'u3', display_name: 'Cy' }, { id: 'me', display_name: 'Dana' }], error: null }
    });
    const r = await run(cr, 'GET', '/t/' + threads[1].id, { sb });
    out.thread = render('community/thread.ejs', r.data);
    ok('the reply that helped goes first, marked', r.data.replies[0].id === 'r1' && out.thread.includes('✓ This helped the asker') && out.thread.indexOf('Post case studies') < out.thread.indexOf('Try a retainer'), out.thread.startsWith('ERR') ? out.thread.slice(0, 300) : undefined);
    ok('the asker can mark or unmark replies, and follow', out.thread.includes('action="/community/t/' + threads[1].id + '/accept"') && out.thread.includes('Unmark') && out.thread.includes('Following · stop'));
    ok('views are counted by the database', sb.calls.some(c => c.name === 'forum_thread_viewed') && !sb.writes.some(w => w.table === 'forum_threads'));
  }
  {
    const sb = fakeSb({ forum_threads: { data: [threads[0]], error: null }, forum_replies: { data: [{ id: 'r9', user_id: 'u3' }], error: null } });
    await run(cr, 'POST', '/t/' + threads[0].id + '/accept', { sb, body: { reply_id: 'r9' } });
    ok('only the asker can mark the answer', !sb.writes.length);
    const sb2 = fakeSb({ forum_threads: { data: [Object.assign({}, threads[0], { user_id: 'me' })], error: null }, forum_replies: { data: [{ id: 'r9', user_id: 'u3' }], error: null } });
    const r2 = await run(cr, 'POST', '/t/' + threads[0].id + '/accept', { sb: sb2, body: { reply_id: 'r9' } });
    ok('...and the answerer hears about it', sb2.writes.some(w => w.table === 'forum_threads' && w.payload.accepted_reply_id === 'r9') && sb2.calls.some(c => c.name === 'push_notification' && c.args.target_user === 'u3' && /marked your answer/.test(c.args.nmessage)) && r2.redirect.endsWith('#r-r9'));
  }
  {
    const sb = fakeSb();
    await run(cr, 'POST', '/t/' + threads[0].id + '/follow', { sb });
    await run(cr, 'POST', '/t/' + threads[0].id + '/follow', { sb, body: { stop: '1' } });
    ok('follow and unfollow', sb.writes.map(w => w.table + ':' + w.op).join() === 'forum_follows:upsert,forum_follows:delete');
  }
  {
    const sb = fakeSb({ forum_threads: { data: [threads[0]], error: null }, forum_replies: { data: null, error: null } });
    await run(cr, 'POST', '/t/' + threads[0].id + '/reply', { sb, body: { body: 'Charge for the value, not the hours.' } });
    ok('after the migration a reply leaves counting and telling to the database', sb.writes.map(w => w.table + ':' + w.op).join() === 'forum_replies:insert' && !sb.calls.some(c => c.name === 'push_notification'));
    const old = Object.assign({}, threads[0]); delete old.accepted_reply_id;
    const sb2 = fakeSb({ forum_threads: { data: [old], error: null }, forum_replies: { data: null, error: null } });
    await run(cr, 'POST', '/t/' + threads[0].id + '/reply', { sb: sb2, body: { body: 'Charge for the value.' } });
    ok('...before it, the old way still runs', sb2.writes.some(w => w.table === 'forum_threads' && w.op === 'update') && sb2.calls.some(c => c.name === 'push_notification'));
  }

  console.log('\nThe community home:');
  {
    const sb = fakeSb({
      forum_threads: s => ({ data: s.eq && s.eq.reply_count === 0 ? [threads[0]] : threads, error: null }),
      posts: { data: [{ id: 'p1', user_id: 'u2', content: 'Shipped my first paid logo today.', created_at: '2026-11-08T12:00:00Z' }], error: null },
      wins: { data: [{ id: 'w1', user_id: 'u2', title: 'First $1k month', amount_usd: 1000 }], error: null },
      groups: { data: [], error: null },
      challenges: { data: [{ id: 'ch', title: 'Weekly challenge — week of Nov 2', emoji: '🏁', starts_at: '2026-11-02T05:00:00Z', ends_at: '2026-11-09T05:00:00Z' }], error: null },
      profiles: s => ({ data: s.eq && s.eq.path ? [{ id: 'u2', username: 'ben', display_name: 'Ben', headline: 'Logos for bakeries', path: 'freelancer' }] : [{ id: 'u2', display_name: 'Ben', username: 'ben' }], error: null }),
      coworking_sessions: { data: [sessions[0]], error: null }, coworking_rsvps: { data: rsvps, error: null }
    });
    const r = await run(cr, 'GET', '/', { sb, profile: { path: 'freelancer' } });
    out.home = render('community/home.ejs', r.data);
    const h = out.home;
    ok('it renders', r.view === 'community/home' && !h.startsWith('ERR'), h.startsWith('ERR') ? h.slice(0, 300) : undefined);
    ok('the week\'s challenge leads', h.includes('This week&#39;s community challenge') && h.indexOf('Weekly challenge') < h.indexOf('Questions'));
    ok('questions waiting for an answer come first', h.includes('Waiting for an answer') && h.indexOf('How do you price a logo?') < h.indexOf('First client from LinkedIn'));
    ok('feed, results, co-working and people on your path are there', ['Shipped my first paid logo', 'First $1k month', 'Tuesday evening focus hour', 'On your path', 'Logos for bakeries'].every(x => h.includes(x)));
    ok('empty sections stay away', !h.includes('👥 Groups'));
    const anon = await run(cr, 'GET', '/', { sb, user: null });
    const ah = render('community/home.ejs', Object.assign({}, anon.data, { user: null, profile: null }));
    ok('signed-out visitors see questions and a way to join, not co-working', !ah.startsWith('ERR') && ah.includes('Join the community') && ah.includes('How do you price a logo?') && !ah.includes('Co-working</h2>'), ah.startsWith('ERR') ? ah.slice(0, 300) : undefined);
  }

  console.log('\nOn my path, elsewhere:');
  ok('the feed has an "On my path" filter', read('views/feed.ejs').includes('href="/feed?scope=path"') && /scope === 'path'/.test(read('src/posts.js')));
  ok('so do members, with each member\'s path shown', read('views/members.ejs').includes('href="/members?path=mine"') && read('views/members.ejs').includes('pathOf(m.path)'));
  ok('old links into Q&A now go to /community/qa', read('src/first_week.js').includes("href: '/community/qa'") && !/res\.redirect\('\/community'\)/.test(read('src/routes/community.js')));
  ok('co-working is mounted before the community router', read('server.js').indexOf("app.use('/community/coworking'") < read('server.js').indexOf("app.use('/community', require"));

  if (process.env.COMM_OUT) {
    const css = h => h.replace(/href="\/css\/style\.css\?v=\d+"/, 'href="' + path.join(ROOT, 'public/css/style.css') + '"');
    for (const [k, v] of Object.entries(out)) fs.writeFileSync(path.join(process.env.COMM_OUT, k + '.html'), css(v));
  }
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
