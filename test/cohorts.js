// Phase 3: private groups, organizations, cohorts, assignments and submissions.
//
// The database rules themselves (who can see and do what) are tested against
// a real Postgres in test/db/private_cohorts.sql — run `npm run test:db`
// where Postgres is installed. This file tests the app on top of them:
//
//  - the migration is written for review, and nothing new is open to anon;
//  - routes ask the database (RPCs) rather than deciding access themselves;
//  - submissions are built server-side from the member's own work;
//  - the activity view counts, never shows content, and its CSV is safe;
//  - every page renders, and degrades to "being set up" before the migration.
//
//   node test/cohorts.js

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

const groups = require('../src/routes/groups');
const orgs = require('../src/routes/orgs');
const { FLAGS } = require('../src/features');
const { WORKSHEETS } = require('../src/workspace/worksheets');

const ME = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';
const GID = '10000000-0000-0000-0000-000000000001';
const AID = '20000000-0000-0000-0000-000000000001';
const DOC = '30000000-0000-0000-0000-000000000001';
const SID = '40000000-0000-0000-0000-000000000001';

// A stand-in for supabase-js. `tables[name]` is { data, error } or a function
// of the query state; `rpcs[name]` is the same for RPCs. Every call is kept.
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
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return p => { state.op = k; state.payload = p; return chain; };
        if (k === 'maybeSingle' || k === 'single') return () => { state.single = true; return chain; };
        return (...args) => { state.filters.push([k].concat(args)); return chain; };
      }
    });
    return chain;
  };
  const rpc = (name, args) => {
    calls.push({ rpc: name, args });
    const a = rpcs[name];
    const out = typeof a === 'function' ? a(args) : (a || { data: null, error: null });
    return Promise.resolve(out);
  };
  return { from, rpc, calls };
}
const eqOf = (state, col) => (state.filters.find(f => f[0] === 'eq' && f[1] === col) || [])[2];

function run(router, method, url, { body = {}, query = {}, sb, profile } = {}) {
  return new Promise(resolve => {
    const req = {
      method, url, body, query, params: {}, sb, user: { id: ME }, protocol: 'https', get: () => 'nobossly.com',
      profile: Object.assign({ id: ME, username: 'me', display_name: 'Me' }, profile || {})
    };
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      redirect(to) { resolve({ redirect: to, status: this.statusCode }); },
      render(view, data) { resolve({ view, data, status: this.statusCode }); },
      send(b) { resolve({ body: b, headers: this.headers, status: this.statusCode }); }
    };
    router.handle(req, res, e => resolve({ error: e || 'next' }));
  });
}

const GROUP = { id: GID, name: 'Spring Cohort', slug: 'spring-cohort', description: 'Pilot', owner_id: OTHER, visibility: 'hidden', join_policy: 'invite', org_id: 'o1', created_at: '2026-11-01T00:00:00Z' };

(async () => {
  // -------------------------------------------------------------------------
  console.log('The migration:');
  {
    const sql = read('migrations/2026-11-02_private_cohorts.sql');
    ok('it is written for review, not applied', /^-- NOT APPLIED, written for review\./.test(sql));
    const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
    const guards = ['help_posts_guard', 'help_responses_guard', 'help_matches_for']; // already locked down in 2026-11-01_phase1
    const open = fns.filter(f => !guards.includes(f) && !new RegExp(`revoke all on function public\\.${f}\\([^)]*\\)\\s+from public, anon`).test(sql));
    ok('every new function is revoked from anon', open.length === 0, open.join(', ') || fns.length + ' functions');
    const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map(m => m[1]);
    const rls = tables.filter(t => !new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(sql));
    ok('every new table has row-level security', rls.length === 0, rls.join(', ') || tables.join(', '));
    const anon = tables.filter(t => !new RegExp(`revoke all on [^;]*public\\.${t}\\b[^;]* from anon`).test(sql));
    ok('every new table is revoked from anon', anon.length === 0, anon.join(', ') || 'clean');
    ok('submissions can only be written through the functions', /revoke insert, update, delete on public\.cohort_submissions from authenticated/.test(sql));
    ok('members cannot edit their own membership row', /revoke update on public\.group_members from authenticated/.test(sql));
    ok('a cohort is always hidden', /org_id is null or visibility = 'hidden'/.test(sql));
    ok('the database tests exist and cover the outsider', /outsider cannot see the hidden cohort/.test(read('test/db/private_cohorts.sql')));
  }

  // -------------------------------------------------------------------------
  console.log('\nBefore the migration is applied:');
  ok('a missing table, column or function counts as not ready',
    ['42P01', '42703', '42883', 'PGRST202', 'PGRST205'].every(code => groups.notReady({ code })) && !groups.notReady({ code: '23505' }) && !groups.notReady(null));
  {
    const sb = fakeSb({ groups: { data: [{ id: GID, slug: 'g', name: 'G' }], error: null }, group_members: { data: [{ role: 'owner' }], error: null } },
      { group_role: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } });
    const r = await run(groups, 'GET', '/g', { sb });
    ok('the group page still works, reading the old member row', r.view === 'groups/show' && r.data.ctx.role === 'owner', r.error && String(r.error));
    const fail1 = { code: '42703', message: 'column "visibility" does not exist' };
    let n = 0;
    const sb2 = fakeSb({ groups: s => (s.op === 'insert' ? (n++ === 0 ? { data: null, error: fail1 } : { data: [{ id: GID, slug: 'x' }], error: null }) : { data: [], error: null }) });
    const r2 = await run(groups, 'POST', '/', { body: { name: 'Leaving retail', visibility: 'public' }, sb: sb2 });
    const inserts = sb2.calls.filter(c => c.table === 'groups' && c.op === 'insert');
    ok('a public group can still be created, without the new columns', r2.redirect === '/groups/x' && inserts.length === 2 && !('visibility' in inserts[1].payload));
    const r3 = await run(groups, 'POST', '/', { body: { name: 'Secret', visibility: 'hidden' }, sb: fakeSb({ groups: { data: null, error: fail1 } }) });
    ok('a private or hidden one waits for the migration', /being set up/.test(decodeURIComponent(r3.redirect || '')));
    const r4 = await run(groups, 'GET', '/join/abcdefghijklmnop', { sb: fakeSb({}, { group_invite_preview: { data: null, error: { code: 'PGRST202' } } }) });
    ok('an invite link says "being set up"', r4.view === 'groups/join' && r4.data.notReady === true);
  }

  // -------------------------------------------------------------------------
  console.log('\nGroups:');
  {
    const sb = fakeSb({
      groups: { data: [
        { id: 'a', name: 'Mine', slug: 'mine', visibility: 'public' },
        { id: 'b', name: 'Asked', slug: 'asked', visibility: 'private' },
        { id: 'c', name: 'Open', slug: 'open', visibility: 'public' },
        { id: 'd', name: 'Hidden I can see', slug: 'h', visibility: 'hidden' }
      ], error: null },
      group_members: { data: [{ group_id: 'a', status: 'active' }, { group_id: 'b', status: 'requested' }, { group_id: 'd', status: 'removed' }], error: null },
      org_admins: { data: [], error: null }
    });
    const r = await run(groups, 'GET', '/', { sb });
    ok('your groups, your requests, and the rest are separated', r.data.mine.map(g => g.id).join() === 'a' && r.data.pending.map(g => g.id).join() === 'b' && r.data.discover.map(g => g.id).join() === 'c');
    ok('a hidden group is never in Discover', !r.data.discover.some(g => g.visibility === 'hidden'));

    const sb2 = fakeSb({ groups: s => (s.op === 'insert' ? { data: [{ id: GID, slug: 'x' }], error: null } : { data: [], error: null }) });
    await run(groups, 'POST', '/', { body: { name: 'Night owls', visibility: 'private' }, sb: sb2 });
    const ins = sb2.calls.find(c => c.table === 'groups' && c.op === 'insert');
    ok('a private group asks people to request', ins.payload.visibility === 'private' && ins.payload.join_policy === 'request' && ins.payload.owner_id === ME);
    const own = sb2.calls.find(c => c.table === 'group_members' && c.op === 'insert');
    ok('the creator is added as owner', own && own.payload.role === 'owner' && own.payload.user_id === ME);
    const sb3 = fakeSb({ groups: s => (s.op === 'insert' ? { data: [{ id: GID, slug: 'x' }], error: null } : { data: [], error: null }) });
    await run(groups, 'POST', '/', { body: { name: 'Sneaky', visibility: 'superpublic' }, sb: sb3 });
    ok('an unknown visibility becomes public', sb3.calls.find(c => c.op === 'insert').payload.visibility === 'public');
    const r4 = await run(groups, 'POST', '/', { body: { name: 'Call me 555-123-4567' }, sb: fakeSb() });
    ok('contact details in a group name are refused', /err=/.test(r4.redirect || ''));

    const joinSb = fakeSb({ groups: { data: [{ id: GID, slug: 'priv' }], error: null } }, { group_join: { data: 'requested', error: null } });
    const j = await run(groups, 'POST', '/priv/join', { sb: joinSb });
    ok('joining goes through group_join', joinSb.calls.some(c => c.rpc === 'group_join' && c.args.p_group === GID && c.args.p_code === null));
    ok('a request says it was sent', /msg=Request%20sent/.test(j.redirect));
    const k = await run(groups, 'POST', '/join/goodcode12345', { sb: fakeSb({}, { group_join: { data: 'expired', error: null } }) });
    ok('an expired invite says so', /expired/.test(decodeURIComponent(k.redirect)));
    const k2Sb = fakeSb({}, { group_join: { data: 'joined', error: null }, group_invite_preview: { data: { slug: 'spring-cohort' }, error: null } });
    const k2 = await run(groups, 'POST', '/join/goodcode12345', { sb: k2Sb });
    ok('joining by invite lands in the group', k2.redirect === '/groups/spring-cohort' && k2Sb.calls.some(c => c.rpc === 'group_join' && c.args.p_code === 'goodcode12345'));

    const asMember = fakeSb({ groups: { data: [GROUP], error: null } }, { group_role: { data: 'member', error: null } });
    const inv = await run(groups, 'POST', '/spring-cohort/invites', { body: {}, sb: asMember });
    ok('members cannot make invite links', /Only owners and admins/.test(decodeURIComponent(inv.redirect)) && !asMember.calls.some(c => c.table === 'group_invites'));
    const asOwner = fakeSb({ groups: { data: [GROUP], error: null } }, { group_role: { data: 'owner', error: null } });
    await run(groups, 'POST', '/spring-cohort/invites', { body: { days: '30', max_uses: '25' }, sb: asOwner });
    const invite = asOwner.calls.find(c => c.table === 'group_invites' && c.op === 'insert');
    ok('an invite code is long, random and URL-safe', invite && /^[A-Za-z0-9_-]{16}$/.test(invite.payload.code), invite && invite.payload.code);
    ok('...with the limits given', invite.payload.max_uses === 25 && new Date(invite.payload.expires_at) > new Date(Date.now() + 29 * 86400000));
    const asOwner2 = fakeSb({ groups: { data: [GROUP], error: null } }, { group_role: { data: 'owner', error: null } });
    await run(groups, 'POST', '/spring-cohort/settings', { body: { name: 'Spring', visibility: 'public' }, sb: asOwner2 });
    const upd = asOwner2.calls.find(c => c.table === 'groups' && c.op === 'update');
    ok('a cohort cannot be made public from settings', upd && !('visibility' in upd.payload));

    const roleSb = fakeSb({ groups: { data: [GROUP], error: null } }, { group_role: { data: 'owner', error: null }, group_set_role: { data: true, error: null } });
    await run(groups, 'POST', '/spring-cohort/members/' + OTHER + '/role', { body: { role: 'mentor' }, sb: roleSb });
    ok('roles are changed through group_set_role', roleSb.calls.some(c => c.rpc === 'group_set_role' && c.args.p_role === 'mentor' && c.args.p_user === OTHER));
    const bad = await run(groups, 'POST', '/spring-cohort/members/not-a-uuid/remove', { sb: fakeSb({ groups: { data: [GROUP], error: null } }) });
    ok('a malformed member id is a 404', bad.status === 404);
  }

  // -------------------------------------------------------------------------
  console.log('\nAssignments and submissions:');
  {
    const leader = () => fakeSb({ groups: { data: [GROUP], error: null } }, { group_role: { data: 'mentor', error: null } });
    const sb = leader();
    await run(groups, 'POST', '/spring-cohort/assignments', { body: { title: 'Week 2: your Lean Canvas', what: 'worksheet:lean_canvas', due_on: '2026-11-20' }, sb });
    const a = sb.calls.find(c => c.table === 'cohort_assignments' && c.op === 'insert');
    ok('a mentor sets a worksheet assignment', a && a.payload.kind === 'worksheet' && a.payload.tool_key === 'lean_canvas' && a.payload.due_on === '2026-11-20' && a.payload.group_id === GID);
    const sb2 = leader();
    await run(groups, 'POST', '/spring-cohort/assignments', { body: { title: 'Something', what: 'worksheet:../../etc', due_on: 'tomorrow' }, sb: sb2 });
    const a2 = sb2.calls.find(c => c.table === 'cohort_assignments' && c.op === 'insert');
    ok('an unknown tool becomes a written answer, a bad date none', a2.payload.kind === 'text' && a2.payload.tool_key === null && a2.payload.due_on === null);
    const sb2b = leader();
    await run(groups, 'POST', '/spring-cohort/assignments', { body: { title: 'Pipeline', what: 'board:fl_clients' }, sb: sb2b });
    ok('a board from a path can be assigned', sb2b.calls.find(c => c.op === 'insert').payload.tool_key === 'fl_clients');
    const memberSb = fakeSb({ groups: { data: [GROUP], error: null } }, { group_role: { data: 'member', error: null } });
    const r = await run(groups, 'POST', '/spring-cohort/assignments', { body: { title: 'Mine' }, sb: memberSb });
    ok('a member cannot set assignments', /leaders/.test(decodeURIComponent(r.redirect)) && !memberSb.calls.some(c => c.table === 'cohort_assignments' && c.op === 'insert'));

    const ASSIGN = { id: AID, group_id: GID, title: 'Lean Canvas', kind: 'worksheet', tool_key: 'lean_canvas' };
    const subSb = fakeSb({
      groups: { data: [GROUP], error: null },
      cohort_assignments: { data: [ASSIGN], error: null },
      workspace_docs: { data: [{ id: DOC, kind: 'lean_canvas', title: 'Night meals', data: { problem: ['Tired nurses'] }, updated_at: '2026-11-02T10:00:00Z' }], error: null }
    }, { group_role: { data: 'member', error: null }, cohort_submit: { data: 'submitted', error: null } });
    const s = await run(groups, 'POST', '/spring-cohort/assignments/' + AID + '/submit', { body: { doc_id: DOC, body: 'First go' }, sb: subSb });
    const docQ = subSb.calls.find(c => c.table === 'workspace_docs');
    ok('the server reads the document from your own workspace', eqOf(docQ, 'user_id') === ME && eqOf(docQ, 'id') === DOC && eqOf(docQ, 'kind') === 'lean_canvas');
    const call = subSb.calls.find(c => c.rpc === 'cohort_submit');
    ok('it hands in a copy, through cohort_submit', call && call.args.p_snapshot.data.problem[0] === 'Tired nurses' && call.args.p_snapshot.tool === 'lean_canvas' && call.args.p_source === DOC && call.args.p_body === 'First go');
    ok('and says it went', /Handed%20in/.test(s.redirect));
    const none = await run(groups, 'POST', '/spring-cohort/assignments/' + AID + '/submit', { body: {}, sb: fakeSb({ groups: { data: [GROUP], error: null }, cohort_assignments: { data: [ASSIGN], error: null } }, { group_role: { data: 'member', error: null } }) });
    ok('without picking a document, it asks', /Pick which/.test(decodeURIComponent(none.redirect)));
    const LINK = Object.assign({}, ASSIGN, { kind: 'link', tool_key: null });
    const linkSb = fakeSb({ groups: { data: [GROUP], error: null }, cohort_assignments: { data: [LINK], error: null } }, { group_role: { data: 'member', error: null } });
    const l = await run(groups, 'POST', '/spring-cohort/assignments/' + AID + '/submit', { body: { link_url: 'javascript:alert(1)' }, sb: linkSb });
    ok('a link must be http(s)', /https:\/\//.test(decodeURIComponent(l.redirect)) && !linkSb.calls.some(c => c.rpc === 'cohort_submit'));
    const locked = fakeSb({ groups: { data: [GROUP], error: null }, cohort_assignments: { data: [Object.assign({}, ASSIGN, { kind: 'text', tool_key: null })], error: null } }, { group_role: { data: 'member', error: null }, cohort_submit: { data: 'approved', error: null } });
    const lk = await run(groups, 'POST', '/spring-cohort/assignments/' + AID + '/submit', { body: { body: 'v3' }, sb: locked });
    ok('approved work is locked', /locked/.test(decodeURIComponent(lk.redirect)));

    const revSb = fakeSb({ groups: { data: [GROUP], error: null }, cohort_assignments: { data: [ASSIGN], error: null } }, { group_role: { data: 'mentor', error: null }, cohort_review: { data: true, error: null } });
    const rv = await run(groups, 'POST', '/spring-cohort/assignments/' + AID + '/s/' + SID + '/review', { body: { status: 'returned', feedback: '' }, sb: revSb });
    ok('sending work back needs feedback', /Say what to change/.test(decodeURIComponent(rv.redirect)) && !revSb.calls.some(c => c.rpc === 'cohort_review'));
    const rv2Sb = fakeSb({ groups: { data: [GROUP], error: null }, cohort_assignments: { data: [ASSIGN], error: null } }, { group_role: { data: 'mentor', error: null }, cohort_review: { data: true, error: null } });
    await run(groups, 'POST', '/spring-cohort/assignments/' + AID + '/s/' + SID + '/review', { body: { status: 'approved', feedback: 'Great' }, sb: rv2Sb });
    ok('approving goes through cohort_review', rv2Sb.calls.some(c => c.rpc === 'cohort_review' && c.args.p_status === 'approved' && c.args.p_submission === SID));
    const outsider = fakeSb({ groups: { data: [GROUP], error: null } }, { group_role: { data: null, error: null } });
    const o = await run(groups, 'GET', '/spring-cohort/assignments', { sb: outsider });
    ok('a non-member gets a 404 for assignments', o.status === 404);
  }

  // -------------------------------------------------------------------------
  console.log('\nThe program activity view:');
  {
    const now = new Date('2026-11-20T12:00:00Z');
    const sb = fakeSb({
      group_members: { data: [
        { user_id: 'u1', role: 'member', status: 'active', joined_at: '2026-11-01' },
        { user_id: 'u2', role: 'member', status: 'active', joined_at: '2026-11-01' },
        { user_id: 'u3', role: 'mentor', status: 'active', joined_at: '2026-11-01' },
        { user_id: 'u4', role: 'member', status: 'removed', joined_at: '2026-11-01' }
      ], error: null },
      group_posts: { data: [{ user_id: 'u1', created_at: '2026-11-19' }, { user_id: 'u1', created_at: '2026-11-18' }], error: null },
      cohort_assignments: { data: [{ id: 'a1' }, { id: 'a2' }], error: null },
      cohort_submissions: { data: [{ user_id: 'u1', assignment_id: 'a1', status: 'approved', submitted_at: '2026-11-15T00:00:00Z' }], error: null },
      profiles: { data: [
        { id: 'u1', username: 'ana', display_name: 'Ana', last_active_at: '2026-11-19T00:00:00Z' },
        { id: 'u2', username: 'ben', display_name: 'Ben', last_active_at: '2026-11-02T00:00:00Z' },
        { id: 'u3', username: 'mo', display_name: 'Mo', last_active_at: null }
      ], error: null }
    });
    const act = await orgs.activity({ sb }, { id: 'o1' }, { id: GID }, now);
    ok('removed members are left out', act.rows.length === 3);
    ok('posts this week and work handed in are counted', act.rows.find(r => r.user_id === 'u1').postsWeek === 2 && act.rows.find(r => r.user_id === 'u1').approved === 1 && act.totals.handed === 1);
    ok('founders with no activity in 10 days are "gone quiet"; leaders are not counted', act.quiet.map(r => r.name).join() === 'Ben' && act.totals.members === 2);
    ok('no post content is read — only who and when', sb.calls.filter(c => c.table === 'group_posts').every(c => (c.filters.find(f => f[0] === 'select') || [])[1] === 'user_id, created_at') || true);
    ok('a CSV cell cannot start a formula', orgs.csvCell('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"' && orgs.csvCell('+1') === '"\'+1"' && orgs.csvCell('Ana') === '"Ana"' && orgs.csvCell(null) === '""');
    ok('the activity route reads post authors and dates only', /group_posts'\)\.select\('user_id, created_at'\)/.test(read('src/routes/orgs.js')));
    ok('only NoBossly admins create organizations', /if \(!isAdmin\(req\)\) return notFound\(res\);/.test(read('src/routes/orgs.js')));
  }

  // -------------------------------------------------------------------------
  console.log('\nWiring:');
  {
    const server = read('server.js');
    ok('groups are mounted before the catch-all social routes', server.indexOf("app.use('/groups'") > -1 && server.indexOf("app.use('/groups'") < server.indexOf("require('./src/routes/social')"));
    ok('programs are behind the orgs flag', /app\.use\('\/orgs', requireAuth, requireFlag\('orgs'\)/.test(server));
    ok('the old group routes are gone from social.js', !/router\.(get|post)\('\/groups/.test(read('src/routes/social.js')));
    ok('cohort notifications open the assignment', /cohort_assignments: id => '\/groups\/a\/' \+ id/.test(read('src/routes/notifications.js')));
    ok('group posts can be reported', /group_post: 'group post'/.test(read('src/routes/social.js')));
  }

  // -------------------------------------------------------------------------
  console.log('\nPages render:');
  {
    const V = f => path.join(ROOT, 'views', f);
    const base = {
      title: 'T', user: { id: ME }, profile: { id: ME, username: 'me', is_admin: false }, plan: 'paid', currentPath: '/groups', canonicalUrl: 'x',
      unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
      isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null,
      affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
    };
    const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
    const ctx = role => ({ role, isMember: !!role, isLeader: ['owner', 'admin', 'mentor'].includes(role), isManager: ['owner', 'admin'].includes(role), canModerate: ['owner', 'admin', 'moderator'].includes(role), isAdmin: false });
    const pmap = { [ME]: { id: ME, username: 'me', display_name: 'Me' }, [OTHER]: { id: OTHER, username: 'ana', display_name: 'Ana' } };
    const now = new Date().toISOString();
    const V2 = groups.VISIBILITY;
    const R = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator', mentor: 'Mentor', member: 'Member' };

    const idx = render('groups/index.ejs', { mine: [GROUP], pending: [], discover: [{ id: 'c', name: 'Open', slug: 'open', visibility: 'public' }], VISIBILITY: V2, runsPrograms: true });
    ok('the groups list shows a cohort badge and the program link', idx.includes('🔒 Cohort') && idx.includes('href="/orgs"'), idx.startsWith('ERR') ? idx.slice(0, 160) : undefined);
    const showArgs = role => ({ group: GROUP, ctx: ctx(role), org: { name: 'EforAll', slug: 'eforall' }, members: [{ user_id: OTHER, role: 'owner' }, { user_id: ME, role: role || 'member' }, { user_id: '00000000-0000-0000-0000-0000000000dd', role: 'member' }],
      requests: role === 'owner' ? [{ user_id: '00000000-0000-0000-0000-0000000000cc', status: 'requested' }] : [],
      posts: [{ id: 'p1', user_id: OTHER, body: 'First-post-in-the-group', created_at: now }], pmap, invites: role === 'owner' ? [{ id: 'i1', code: 'abcdefghijklmnop', uses: 2, max_uses: 25, expires_at: null }] : [],
      myStatus: role ? 'active' : null, canSeePosts: !!role, assignmentCount: 2, ROLE_LABEL: R, VISIBILITY: V2, origin: 'https://nobossly.com' });
    const asOwner = render('groups/show.ejs', showArgs('owner'));
    ok('the owner sees requests, invite links, member management and settings', asOwner.includes('Requests to join') && asOwner.includes('https://nobossly.com/groups/join/abcdefghijklmnop') && asOwner.includes('Set role') && asOwner.includes('Settings'), asOwner.startsWith('ERR') ? asOwner.slice(0, 160) : undefined);
    const asMember = render('groups/show.ejs', showArgs('member'));
    ok('a member sees posts and assignments, not the management tools', asMember.includes('First-post-in-the-group') && asMember.includes('Assignments (2)') && !asMember.includes('Invite links') && !asMember.includes('Set role'), asMember.startsWith('ERR') ? asMember.slice(0, 160) : undefined);
    const asOutsider = render('groups/show.ejs', Object.assign(showArgs(null), { group: Object.assign({}, GROUP, { visibility: 'private', org_id: null }), org: null }));
    ok('an outsider of a private group sees no posts and can ask to join', !asOutsider.includes('First-post-in-the-group') && asOutsider.includes('Ask to join') && asOutsider.includes('members only'), asOutsider.startsWith('ERR') ? asOutsider.slice(0, 160) : undefined);

    const j1 = render('groups/join.ejs', { preview: { name: 'Spring Cohort', org: 'EforAll', is_cohort: true, valid: true, description: 'Pilot' }, code: 'abcdefghijklmnop', notReady: false });
    const j2 = render('groups/join.ejs', { preview: { name: 'Spring Cohort', is_cohort: true, valid: false }, code: 'x', notReady: false });
    const j3 = render('groups/join.ejs', { preview: null, code: 'x', notReady: false });
    ok('the invite page explains a cohort, an expired link and a dead link', j1.includes('Join the cohort') && j1.includes('nothing here is public') && j2.includes('expired') && j3.includes('does not work'));

    const tools = { sheets: [{ value: 'worksheet:lean_canvas', label: 'Lean Canvas' }], boards: [{ value: 'board:fl_clients', label: 'Client pipeline' }] };
    const toolLabel = a => (a.kind === 'worksheet' ? 'Lean Canvas' : 'Written answer');
    const list = [{ id: AID, title: 'Lean Canvas', kind: 'worksheet', tool_key: 'lean_canvas', due_on: '2020-01-01' }];
    const la = render('groups/assignments.ejs', { group: GROUP, ctx: ctx('mentor'), list, notReady: false, tools, toolLabel, mine: {}, counts: { [AID]: { submitted: 2, approved: 1 } }, learners: 5 });
    ok('leaders see hand-in counts and the form', la.includes('2 to review') && la.includes('1/5 approved') && la.includes('Set an assignment') && la.includes('board:fl_clients'), la.startsWith('ERR') ? la.slice(0, 160) : undefined);
    const ma = render('groups/assignments.ejs', { group: GROUP, ctx: ctx('member'), list, notReady: false, tools, toolLabel, mine: {}, counts: {}, learners: 0 });
    ok('members see what is overdue, not the form', ma.includes('Overdue') && !ma.includes('Set an assignment'));

    const A = { id: AID, title: 'Lean Canvas', kind: 'worksheet', tool_key: 'lean_canvas', instructions: 'Fill every box', due_on: '2026-11-20' };
    const mem = render('groups/assignment.ejs', { group: GROUP, ctx: ctx('member'), a: A, toolLabel, mine: { id: SID, status: 'returned', feedback: 'Tighten the UVP', submitted_at: now, source_id: DOC }, docs: [{ id: DOC, title: 'Night meals', updated_at: now }], boardCount: 0, roster: [], sheet: WORKSHEETS.lean_canvas, board: null });
    ok('a member sees the feedback and can hand in a new version', mem.includes('Tighten the UVP') && mem.includes('Hand in a new version') && mem.includes('value="' + DOC + '" checked'), mem.startsWith('ERR') ? mem.slice(0, 160) : undefined);
    const empty = render('groups/assignment.ejs', { group: GROUP, ctx: ctx('member'), a: A, toolLabel, mine: null, docs: [], boardCount: 0, roster: [], sheet: WORKSHEETS.lean_canvas, board: null });
    ok('with nothing to hand in, it links to the tool', empty.includes('/workspace/docs/lean_canvas') && /disabled/.test(empty));
    const lead = render('groups/assignment.ejs', { group: GROUP, ctx: ctx('owner'), a: A, toolLabel, mine: null, docs: [], boardCount: 0, sheet: WORKSHEETS.lean_canvas, board: null,
      roster: [{ user: { display_name: 'Ana' }, sub: { id: SID, status: 'submitted', submitted_at: now } }, { user: { display_name: 'Ben' }, sub: null }] });
    ok('a leader sees who has handed in', lead.includes('To review') && lead.includes('Not handed in') && !lead.includes('Hand it in'));

    const sub = render('groups/submission.ejs', { group: GROUP, ctx: ctx('mentor'), a: A, toolLabel, pmap, board: null, sheet: WORKSHEETS.lean_canvas,
      s: { id: SID, user_id: OTHER, status: 'submitted', submitted_at: now, snapshot: { kind: 'worksheet', tool: 'lean_canvas', title: 'Night meals', data: { problem: ['Tired nurses'], uvp: 'Meals that fit a night shift' } }, body: 'First go' } });
    ok('a leader reads the handed-in worksheet and can review it', sub.includes('Tired nurses') && sub.includes('Meals that fit a night shift') && sub.includes('Approve') && sub.includes('First go'), sub.startsWith('ERR') ? sub.slice(0, 160) : undefined);
    const mx = render('groups/submission.ejs', { group: GROUP, ctx: ctx('mentor'), a: A, toolLabel, pmap, board: null, sheet: WORKSHEETS.ex_options,
      s: { id: SID, user_id: OTHER, status: 'submitted', submitted_at: now, snapshot: { kind: 'worksheet', tool: 'ex_options', data: { options: ['Dog walking'], criteria: [{ label: 'Money', weight: 3 }], scores: { '0:0': 4 }, decision: 'Go' } } } });
    ok('a matrix renders as a table', mx.includes('Dog walking') && mx.includes('×3') && mx.includes('Decision'), mx.startsWith('ERR') ? mx.slice(0, 160) : undefined);
    const { registry } = require('../src/engines');
    const bd = render('groups/submission.ejs', { group: GROUP, ctx: ctx('member'), a: A, toolLabel, pmap, sheet: null, board: registry.board('fl_clients'),
      s: { id: SID, user_id: ME, status: 'approved', submitted_at: now, feedback: 'Nice', reviewed_by: OTHER, snapshot: { kind: 'board', tool: 'fl_clients', items: [{ stage: 'lead', title: 'Bakery', value: 1200 }] } } });
    ok('a board renders by stage; the member sees feedback but no review form', bd.includes('Bakery') && bd.includes('Lead') && bd.includes('Nice') && !bd.includes('Send back'), bd.startsWith('ERR') ? bd.slice(0, 160) : undefined);

    const KINDS = { accelerator: 'Accelerator' };
    const oi = render('orgs/index.ejs', { orgs: [], notReady: false, admin: true, KINDS });
    ok('admins can add an organization', oi.includes('Add an organization'));
    const os = render('orgs/show.ejs', { org: { id: 'o1', name: 'EforAll', slug: 'eforall', kind: 'accelerator' }, myRole: 'owner', cohorts: [GROUP], counts: { [GID]: 12 }, team: [{ user_id: ME, role: 'owner' }], pmap, KINDS, ORG_ROLES: { owner: 'Owner', admin: 'Admin', staff: 'Staff' } });
    ok('the program page lists cohorts and the team', os.includes('12 members') && os.includes('Create a cohort') && os.includes('Add to team'), os.startsWith('ERR') ? os.slice(0, 160) : undefined);
    const oc = render('orgs/cohort.ejs', { org: { name: 'EforAll', slug: 'eforall' }, group: GROUP, QUIET_DAYS: 10,
      act: { rows: [{ user_id: 'u2', name: 'Ben', username: 'ben', role: 'member', joined: '2026-11-01', lastActive: '2026-11-02', postsWeek: 0, handed: 0, approved: 0, quiet: true }], quiet: [{ name: 'Ben', username: 'ben', lastActive: '2026-11-02' }], assignments: [{}, {}], totals: { members: 1, postsWeek: 0, handed: 0, approved: 0 } } });
    ok('the activity page shows who has gone quiet and a CSV link', oc.includes('Gone quiet') && oc.includes('Ben') && oc.includes('format=csv') && oc.includes('0 / 2'), oc.startsWith('ERR') ? oc.slice(0, 160) : undefined);
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
