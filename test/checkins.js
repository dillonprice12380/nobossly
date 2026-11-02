// Weekly check-in threads and replies in groups.
//
// The database side (only the server can post a check-in, once per group per
// day; replies stay one level deep in the same group) is tested against
// Postgres in test/db/group_checkins.sql — `npm run test:db`.
//
//   node test/checkins.js

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

const checkins = require('../src/checkins');
const groups = require('../src/routes/groups');
const { FLAGS } = require('../src/features');

(async () => {
  console.log('When a check-in is due (New York time):');
  const d = iso => checkins.due(new Date(iso));
  ok('Monday 08:59 New York (EST): not yet', d('2026-11-09T13:59:00Z') === null);
  ok('Monday 09:00 New York (EST): Monday', JSON.stringify(d('2026-11-09T14:00:00Z')) === '{"kind":"monday","day":"2026-11-09"}');
  ok('Monday 23:30 New York is still Monday, though it is Tuesday in UTC', JSON.stringify(d('2026-11-10T04:30:00Z')) === '{"kind":"monday","day":"2026-11-09"}');
  ok('Friday 09:00 New York in summer (EDT): Friday', JSON.stringify(d('2026-07-10T13:00:00Z')) === '{"kind":"friday","day":"2026-07-10"}');
  ok('Friday 08:00 New York in summer: not yet', d('2026-07-10T12:00:00Z') === null);
  ok('Wednesday: nothing', d('2026-11-11T15:00:00Z') === null);
  ok('Sunday: nothing', d('2026-11-08T15:00:00Z') === null);

  console.log('\nThe timer:');
  const calls = [];
  const sc = { rpc: (n, a) => { calls.push([n, a]); return Promise.resolve({ data: 3, error: null }); } };
  const quiet = { log: () => {}, error: () => {} };
  ok('when due, it asks the database to post', (await checkins.run(sc, new Date('2026-11-09T15:00:00Z'), quiet)) === 3 && calls[0][0] === 'post_weekly_checkins' && calls[0][1].p_kind === 'monday' && calls[0][1].p_day === '2026-11-09');
  ok('when not due, it does nothing', (await checkins.run(sc, new Date('2026-11-11T15:00:00Z'), quiet)) === null && calls.length === 1);
  let logged = 0;
  const missing = { rpc: () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.post_weekly_checkins' } }) };
  await checkins.run(missing, new Date('2026-11-09T15:00:00Z'), { log: () => {}, error: () => { logged++; } });
  ok('before the migration it stays quiet', logged === 0);
  const broken = { rpc: () => Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement' } }) };
  await checkins.run(broken, new Date('2026-11-09T15:00:00Z'), { log: () => {}, error: () => { logged++; } });
  ok('a real error is reported', logged === 1);
  ok('the server runs it with the service key, every 15 minutes', /checkins\.run\(sc\)/.test(read('server.js')) && /15 \* 60 \* 1000/.test(read('server.js')));

  console.log('\nThreads:');
  const now = new Date('2026-11-12T12:00:00Z');
  const posts = [
    { id: 'c1', kind: 'checkin', user_id: null, body: 'What are you working on this week?', created_at: '2026-11-09T14:00:00Z' },
    { id: 'c0', kind: 'checkin', user_id: null, body: 'What went well this week?', created_at: '2026-10-30T13:00:00Z' },
    { id: 'p1', kind: 'post', user_id: 'u1', body: 'Hello', created_at: '2026-11-10T10:00:00Z' },
    { id: 'r2', kind: 'post', user_id: 'u2', body: 'Second reply', parent_id: 'c1', created_at: '2026-11-09T16:00:00Z' },
    { id: 'r1', kind: 'post', user_id: 'u1', body: 'First reply', parent_id: 'c1', created_at: '2026-11-09T15:00:00Z' }
  ];
  ok('the newest check-in from the last week is pinned', checkins.pinned(posts, now).id === 'c1');
  ok('an older one is not', checkins.pinned(posts.filter(p => p.id !== 'c1'), now) === null);
  const t = checkins.threads(posts);
  ok('top-level posts newest first; replies grouped under them, oldest first', t.top.map(p => p.id).join() === 'p1,c1,c0' && t.replies.c1.map(p => p.id).join() === 'r1,r2');

  console.log('\nThe group page:');
  const V = f => path.join(ROOT, 'views', f);
  const base = {
    title: 'T', user: { id: 'u1' }, profile: { id: 'u1', username: 'me' }, plan: 'paid', currentPath: '/groups', canonicalUrl: 'x',
    unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
    isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null,
    affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
  };
  const G = { id: 'g', name: 'Builders', slug: 'builders', visibility: 'public', org_id: null, checkin_monday: true, checkin_friday: false, created_at: now.toISOString() };
  const ctx = { role: 'owner', isMember: true, isLeader: true, isManager: true, canModerate: true, isAdmin: false };
  const pin = checkins.pinned(posts, now);
  const rest = checkins.threads(posts.filter(p => p.id !== pin.id));
  let html;
  try {
    html = ejs.render(read('views/groups/show.ejs'), Object.assign({}, base, {
      group: G, ctx, org: null, members: [{ user_id: 'u1', role: 'owner' }], requests: [], posts: rest.top, replies: t.replies, pin, threaded: true,
      pmap: { u1: { username: 'ana', display_name: 'Ana' }, u2: { username: 'ben', display_name: 'Ben' } }, invites: [], myStatus: 'active', canSeePosts: true,
      assignmentCount: 0, ROLE_LABEL: { owner: 'Owner' }, VISIBILITY: groups.VISIBILITY, origin: 'https://nobossly.com'
    }), { filename: V('groups/show.ejs') });
  } catch (e) { html = 'ERR ' + e.message; }
  ok('the check-in is pinned at the top, from NoBossly', html.indexOf("This week's check-in") > -1 && html.indexOf("This week's check-in") < html.indexOf('Hello') && html.includes('<strong>NoBossly</strong>'), html.startsWith('ERR') ? html.slice(0, 200) : undefined);
  ok('replies show under it, in order, with a reply box', html.indexOf('First reply') < html.indexOf('Second reply') && html.includes('name="parent_id" value="c1"'));
  ok('a check-in can be deleted by the owner but not reported', !html.includes('/report?type=group_post&id=c1'));
  ok('settings show the two check-in switches as they are', /name="checkin_monday" value="1" checked/.test(html) && /name="checkin_friday" value="1" >/.test(html));

  console.log('\nRoutes:');
  function fakeSb(tables = {}, rpcs = {}) {
    const calls = [];
    const from = table => {
      const st = { table, op: 'select', payload: null };
      calls.push(st);
      const chain = new Proxy({}, { get(_, k) {
        if (k === 'then') { const a = tables[table]; let out = typeof a === 'function' ? a(st) : (a || { data: [], error: null }); if (st.single && Array.isArray(out.data)) out = { data: out.data[0] || null, error: out.error }; return (r, j) => Promise.resolve(out).then(r, j); }
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return p => { st.op = k; st.payload = p; return chain; };
        if (k === 'maybeSingle') return () => { st.single = true; return chain; };
        return () => chain;
      } });
      return chain;
    };
    return { from, rpc: (n, a) => { calls.push({ rpc: n, args: a }); const r = rpcs[n]; return Promise.resolve(typeof r === 'function' ? r(a) : (r || { data: null, error: null })); }, calls };
  }
  const run = (method, url, body, sb) => new Promise(resolve => {
    const req = { method, url, body, query: {}, params: {}, sb, user: { id: 'u1' }, profile: { id: 'u1' }, protocol: 'https', get: () => 'x' };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, redirect(to) { resolve({ redirect: to }); }, render(v, d) { resolve({ view: v, data: d }); } };
    groups.handle(req, res, e => resolve({ error: e }));
  });
  const PARENT = '70000000-0000-0000-0000-000000000001';
  const sb = fakeSb({ groups: { data: [{ id: 'g' }], error: null } });
  const r = await run('POST', '/builders/post', { body: 'Shipping the pricing page', parent_id: PARENT }, sb);
  const ins = sb.calls.find(c => c.table === 'group_posts' && c.op === 'insert');
  ok('a reply is saved with its parent, as the member', ins && ins.payload.parent_id === PARENT && ins.payload.user_id === 'u1' && r.redirect === '/groups/builders#p-' + PARENT);
  const sb2 = fakeSb({ groups: { data: [{ id: 'g' }], error: null } });
  await run('POST', '/builders/post', { body: 'Hi', parent_id: 'nope' }, sb2);
  ok('a malformed parent is ignored (a normal post)', !('parent_id' in sb2.calls.find(c => c.op === 'insert').payload));
  const sb3 = fakeSb({ groups: { data: [Object.assign({}, G)], error: null } }, { group_role: { data: 'owner', error: null } });
  await run('POST', '/builders/settings', { name: 'Builders', checkin_monday: '1' }, sb3);
  const upd = sb3.calls.find(c => c.table === 'groups' && c.op === 'update');
  ok('settings save each switch', upd && upd.payload.checkin_monday === true && upd.payload.checkin_friday === false);
  const sb4 = fakeSb({ groups: { data: [{ id: 'g', slug: 'b', name: 'B', visibility: 'public', org_id: null }], error: null } }, { group_role: { data: 'owner', error: null } });
  await run('POST', '/b/settings', { name: 'Bees', checkin_monday: '1' }, sb4);
  ok('before the migration, settings leave the switches alone', !('checkin_monday' in sb4.calls.find(c => c.op === 'update').payload));

  console.log('\nThe migration:');
  const sql = read('migrations/2026-11-02_group_checkins.sql');
  ok('it is written for review', /^-- NOT APPLIED, written for review\./.test(sql));
  ok('only the server can run the job', /revoke all on function public\.post_weekly_checkins\(text, date\) from public, anon, authenticated;/.test(sql) && /grant execute on function public\.post_weekly_checkins\(text, date\) to service_role;/.test(sql));
  ok('one check-in per group per day', /create unique index if not exists group_posts_checkin_once/.test(sql));
  ok('a member post always has its author; a check-in never does', /kind = 'post' and user_id is not null/.test(sql) && /kind = 'checkin' and user_id is null/.test(sql));

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
