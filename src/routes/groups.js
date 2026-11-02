// Groups and cohorts (Phase 3 — migrations/2026-11-02_private_cohorts.sql).
//
//   public  + open     anyone joins
//   private + request  listed; owners, admins and moderators approve requests
//   hidden  + invite   not listed; invite link only — every cohort is one
//
// The database decides who may see and do what (row policies plus group_join,
// group_decide_request, group_set_role, group_remove_member, cohort_submit,
// cohort_review). This file asks it and shows the result; nothing here widens
// access. Until the migration is applied, pages say "being set up" instead of
// failing (groups had no rows when this was written).
const router = require('express').Router();
const crypto = require('crypto');
const pi = require('../personal_info_filter');
const { quiet } = require('../db');
const { WORKSHEETS } = require('../workspace/worksheets');
const { registry } = require('../engines');
require('../path_dashboards'); // registers every path's boards and worksheets

const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugify = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'group';

// The migration is not applied yet: a missing table, column or function.
const notReady = err => !!err && (['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(err.code)
  || /does not exist|Could not find the (table|function)|schema cache/i.test(err.message || ''));
const SETTING_UP = 'Private groups and cohorts are being set up — try again shortly.';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator', mentor: 'Mentor', member: 'Member' };
const LEADERS = ['owner', 'admin', 'mentor'];
const MANAGERS = ['owner', 'admin'];
const VISIBILITY = {
  public: { label: 'Public', help: 'Anyone on NoBossly can see it and join.', join: 'open' },
  private: { label: 'Private', help: 'Listed, but only members see posts. People ask to join and you approve them.', join: 'request' },
  hidden: { label: 'Hidden', help: 'Not listed anywhere. People join with an invite link.', join: 'invite' }
};
const JOIN_MESSAGES = {
  joined: null, already: null,
  requested: 'Request sent — you will be let in once someone approves it.',
  invalid: 'That group cannot be joined that way.',
  expired: 'That invite link has expired. Ask for a new one.',
  full: 'That invite link has been used up. Ask for a new one.',
  removed: 'You were removed from this group. Ask for a new invite if that was a mistake.'
};

const back = (res, to, err) => res.redirect(to + (err ? (to.includes('?') ? '&' : '?') + 'err=' + enc(err) : ''));

// The group by slug, as this member is allowed to see it, plus their role.
async function load(req, slug) {
  const { data: group, error } = await req.sb.from('groups').select('*').eq('slug', slug).maybeSingle();
  if (error || !group) return { group: null, error };
  const { data: role, error: rerr } = await req.sb.rpc('group_role', { p_group: group.id });
  let r = role || null;
  if (rerr && notReady(rerr)) {
    // Before the migration: every member row counts, owner or member.
    const { data: row } = await req.sb.from('group_members').select('role').eq('group_id', group.id).eq('user_id', req.user.id).maybeSingle();
    r = row ? row.role : null;
  }
  return {
    group, role: r,
    isMember: !!r, isLeader: LEADERS.includes(r), isManager: MANAGERS.includes(r),
    canModerate: ['owner', 'admin', 'moderator'].includes(r),
    isAdmin: !!(req.profile && req.profile.is_admin)
  };
}

const notFound = res => res.status(404).render('error', { title: 'Not found', message: 'That group does not exist, or you do not have access to it.' });

async function profilesFor(req, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const { data } = await req.sb.from('profiles').select('id, username, display_name, avatar_url, last_active_at').in('id', uniq);
  const map = {}; (data || []).forEach(p => { map[p.id] = p; });
  return map;
}

// ---------------------------------------------------------------------------
// List and create

router.get('/', async (req, res, next) => {
  try {
    const [{ data: groups, error }, { data: rows }] = await Promise.all([
      req.sb.from('groups').select('*').order('created_at', { ascending: false }).limit(200),
      req.sb.from('group_members').select('*').eq('user_id', req.user.id)
    ]);
    if (error) throw error;
    const status = {}; (rows || []).forEach(m => { status[m.group_id] = m.status || 'active'; });
    const all = groups || [];
    const mine = all.filter(g => status[g.id] === 'active');
    const pending = all.filter(g => status[g.id] === 'requested');
    const discover = all.filter(g => !status[g.id] || ['left'].includes(status[g.id])).filter(g => (g.visibility || 'public') !== 'hidden');
    // Program teams get a way back to their organization.
    const { data: orgRows } = await req.sb.from('org_admins').select('org_id').eq('user_id', req.user.id);
    const runsPrograms = !!(orgRows && orgRows.length) || !!(req.profile && req.profile.is_admin);
    res.render('groups/index', { title: 'Groups', mine, pending, discover, VISIBILITY, runsPrograms, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const description = String(req.body.description || '').trim().slice(0, 600);
    if (name.length < 2) return back(res, '/groups', 'Give the group a name.');
    const found = pi.check(name + '\n' + description);
    if (found) return pi.refuse(req, res, '/groups', found, 'group');
    const visibility = VISIBILITY[req.body.visibility] ? req.body.visibility : 'public';
    const slug = slugify(name) + '-' + crypto.randomBytes(2).toString('hex');
    const row = { name, slug, description: description || null, owner_id: req.user.id };
    let { data: g, error } = await req.sb.from('groups').insert(Object.assign({ visibility, join_policy: VISIBILITY[visibility].join }, row)).select('id, slug').maybeSingle();
    if (error && notReady(error)) {
      if (visibility !== 'public') return back(res, '/groups', SETTING_UP);
      ({ data: g, error } = await req.sb.from('groups').insert(row).select('id, slug').maybeSingle());
    }
    if (error || !g) throw error || new Error('group insert returned nothing');
    let { error: merr } = await req.sb.from('group_members').insert({ group_id: g.id, user_id: req.user.id, role: 'owner', status: 'active' });
    if (merr && notReady(merr)) ({ error: merr } = await req.sb.from('group_members').insert({ group_id: g.id, user_id: req.user.id, role: 'owner' }));
    if (merr) throw merr;
    res.redirect('/groups/' + g.slug);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Invite links

router.get('/join/:code', async (req, res, next) => {
  try {
    const { data: preview, error } = await req.sb.rpc('group_invite_preview', { p_code: String(req.params.code).slice(0, 40) });
    if (error && notReady(error)) return res.render('groups/join', { title: 'Join', preview: null, code: req.params.code, notReady: true });
    if (error) throw error;
    if (preview && preview.member) return res.redirect('/groups/' + preview.slug);
    res.render('groups/join', { title: preview ? 'Join ' + preview.name : 'Invite', preview: preview || null, code: req.params.code, notReady: false });
  } catch (e) { next(e); }
});

router.post('/join/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code).slice(0, 40);
    const { data: result, error } = await req.sb.rpc('group_join', { p_group: null, p_code: code });
    if (error) return back(res, '/groups/join/' + enc(code), notReady(error) ? SETTING_UP : 'Could not join. Please try again.');
    if (result === 'joined' || result === 'already') {
      const { data: preview } = await req.sb.rpc('group_invite_preview', { p_code: code });
      return res.redirect(preview ? '/groups/' + preview.slug : '/groups');
    }
    back(res, '/groups/join/' + enc(code), JOIN_MESSAGES[result] || JOIN_MESSAGES.invalid);
  } catch (e) { next(e); }
});

// A notification about an assignment lands here and is sent to its group.
router.get('/a/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return notFound(res);
    const { data: a } = await req.sb.from('cohort_assignments').select('id, group_id').eq('id', req.params.id).maybeSingle();
    if (!a) return notFound(res);
    const { data: g } = await req.sb.from('groups').select('slug').eq('id', a.group_id).maybeSingle();
    if (!g) return notFound(res);
    res.redirect('/groups/' + g.slug + '/assignments/' + a.id);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// The group page

router.get('/:slug', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group) return notFound(res);
    const g = ctx.group;
    const canSeePosts = ctx.isMember || ctx.isAdmin || (g.visibility || 'public') === 'public';
    const [{ data: members }, { data: posts }, { data: invites }, { data: org }, { count: assignmentCount }] = await Promise.all([
      req.sb.from('group_members').select('*').eq('group_id', g.id).order('joined_at'),
      canSeePosts ? req.sb.from('group_posts').select('*').eq('group_id', g.id).order('created_at', { ascending: false }).limit(100) : { data: [] },
      ctx.isManager ? req.sb.from('group_invites').select('*').eq('group_id', g.id).order('created_at', { ascending: false }) : { data: [] },
      g.org_id ? req.sb.from('organizations').select('id, name, slug').eq('id', g.org_id).maybeSingle() : { data: null },
      ctx.isMember ? req.sb.from('cohort_assignments').select('id', { count: 'exact', head: true }).eq('group_id', g.id) : { count: 0 }
    ]);
    const rows = members || [];
    const active = rows.filter(m => (m.status || 'active') === 'active');
    const requests = ctx.canModerate ? rows.filter(m => m.status === 'requested') : [];
    const mine = rows.find(m => m.user_id === req.user.id);
    const pmap = await profilesFor(req, rows.map(m => m.user_id).concat((posts || []).map(p => p.user_id)));
    res.render('groups/show', {
      title: g.name, group: g, ctx, org: org || null, members: active, requests, posts: posts || [], pmap,
      invites: invites || [], myStatus: mine ? (mine.status || 'active') : null, canSeePosts,
      assignmentCount: assignmentCount || 0, ROLE_LABEL, VISIBILITY, origin: req.protocol + '://' + req.get('host'),
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/:slug/join', async (req, res, next) => {
  try {
    const { data: g } = await req.sb.from('groups').select('id, slug').eq('slug', req.params.slug).maybeSingle();
    if (!g) return notFound(res);
    const { data: result, error } = await req.sb.rpc('group_join', { p_group: g.id, p_code: null });
    if (error && notReady(error)) {
      // Before the migration every group is public and open.
      await req.sb.from('group_members').upsert({ group_id: g.id, user_id: req.user.id }, { onConflict: 'group_id,user_id' }).then(...quiet('group_members.join'));
      return res.redirect('/groups/' + g.slug);
    }
    if (error) throw error;
    const m = JOIN_MESSAGES[result];
    res.redirect('/groups/' + g.slug + (m ? '?' + (result === 'requested' ? 'msg=' : 'err=') + enc(m) : ''));
  } catch (e) { next(e); }
});

router.post('/:slug/leave', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group) return notFound(res);
    if (ctx.role === 'owner') return back(res, '/groups/' + ctx.group.slug, 'Owners cannot leave their own group. Delete it, or ask NoBossly to transfer it.');
    await req.sb.from('group_members').delete().eq('group_id', ctx.group.id).eq('user_id', req.user.id).then(...quiet('group_members.leave'));
    res.redirect('/groups');
  } catch (e) { next(e); }
});

router.post('/:slug/post', async (req, res, next) => {
  try {
    const to = '/groups/' + req.params.slug;
    const body = String(req.body.body || '').trim().slice(0, 3000);
    if (!body) return res.redirect(to);
    const found = pi.check(body);
    if (found) return pi.refuse(req, res, to, found, 'group_post');
    const { data: g } = await req.sb.from('groups').select('id').eq('slug', req.params.slug).maybeSingle();
    if (!g) return notFound(res);
    const { error } = await req.sb.from('group_posts').insert({ group_id: g.id, user_id: req.user.id, body });
    back(res, to, error ? 'Only members can post here.' : null);
  } catch (e) { next(e); }
});

router.post('/:slug/posts/:id/delete', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return notFound(res);
    await req.sb.from('group_posts').delete().eq('id', req.params.id).then(...quiet('group_posts.delete'));
    res.redirect('/groups/' + req.params.slug);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Running a group: requests, roles, removals, invites, settings

router.post('/:slug/requests/:uid', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group || !UUID.test(req.params.uid)) return notFound(res);
    const approve = req.body.approve === '1';
    const { data: ok } = await req.sb.rpc('group_decide_request', { p_group: ctx.group.id, p_user: req.params.uid, p_approve: approve });
    back(res, '/groups/' + ctx.group.slug, ok ? null : 'Could not update that request.');
  } catch (e) { next(e); }
});

router.post('/:slug/members/:uid/role', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group || !UUID.test(req.params.uid)) return notFound(res);
    const { data: ok } = await req.sb.rpc('group_set_role', { p_group: ctx.group.id, p_user: req.params.uid, p_role: String(req.body.role || '') });
    back(res, '/groups/' + ctx.group.slug, ok ? null : 'You cannot give that role.');
  } catch (e) { next(e); }
});

router.post('/:slug/members/:uid/remove', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group || !UUID.test(req.params.uid)) return notFound(res);
    const { data: ok } = await req.sb.rpc('group_remove_member', { p_group: ctx.group.id, p_user: req.params.uid });
    back(res, '/groups/' + ctx.group.slug, ok ? null : 'You cannot remove that member.');
  } catch (e) { next(e); }
});

router.post('/:slug/invites', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group) return notFound(res);
    if (!ctx.isManager) return back(res, '/groups/' + ctx.group.slug, 'Only owners and admins can make invite links.');
    const days = parseInt(req.body.days, 10);
    const uses = parseInt(req.body.max_uses, 10);
    const { error } = await req.sb.from('group_invites').insert({
      group_id: ctx.group.id, created_by: req.user.id,
      code: crypto.randomBytes(12).toString('base64url'),
      max_uses: uses >= 1 && uses <= 1000 ? uses : null,
      expires_at: days >= 1 && days <= 365 ? new Date(Date.now() + days * 86400000).toISOString() : null
    });
    back(res, '/groups/' + ctx.group.slug + '#invites', error ? (notReady(error) ? SETTING_UP : 'Could not make an invite link.') : null);
  } catch (e) { next(e); }
});

router.post('/:slug/invites/:id/delete', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return notFound(res);
    await req.sb.from('group_invites').delete().eq('id', req.params.id).then(...quiet('group_invites.delete'));
    res.redirect('/groups/' + req.params.slug + '#invites');
  } catch (e) { next(e); }
});

router.post('/:slug/settings', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group) return notFound(res);
    const to = '/groups/' + ctx.group.slug;
    if (!ctx.isManager) return back(res, to, 'Only owners and admins can change settings.');
    const name = String(req.body.name || '').trim().slice(0, 80);
    const description = String(req.body.description || '').trim().slice(0, 600);
    if (name.length < 2) return back(res, to, 'Give the group a name.');
    const found = pi.check(name + '\n' + description);
    if (found) return pi.refuse(req, res, to, found, 'group');
    const patch = { name, description: description || null };
    // A cohort stays hidden; other groups may change how people get in.
    if (!ctx.group.org_id && VISIBILITY[req.body.visibility]) {
      patch.visibility = req.body.visibility;
      patch.join_policy = VISIBILITY[req.body.visibility].join;
    }
    const { error } = await req.sb.from('groups').update(patch).eq('id', ctx.group.id);
    back(res, to, error ? 'Could not save the settings.' : null);
  } catch (e) { next(e); }
});

router.post('/:slug/delete', async (req, res, next) => {
  try {
    const { data: g } = await req.sb.from('groups').select('id').eq('slug', req.params.slug).maybeSingle();
    if (g) await req.sb.from('groups').delete().eq('id', g.id).then(...quiet('groups.delete'));
    res.redirect('/groups');
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Assignments and submissions

// What a leader can ask for: any worksheet, any board, written text, or a link.
function assignable() {
  const sheets = Object.entries(WORKSHEETS).map(([k, w]) => ({ value: 'worksheet:' + k, label: (w.emoji || '') + ' ' + w.label }));
  const boards = registry.all().boards.map(b => ({ value: 'board:' + b.key, label: (b.emoji || '🗂️') + ' ' + b.label + ' (board)' }));
  sheets.sort((a, b) => a.label.localeCompare(b.label));
  boards.sort((a, b) => a.label.localeCompare(b.label));
  return { sheets, boards };
}
const toolLabel = a => (a.kind === 'worksheet' ? ((WORKSHEETS[a.tool_key] || {}).label || a.tool_key)
  : a.kind === 'board' ? ((registry.board(a.tool_key) || {}).label || a.tool_key)
  : a.kind === 'link' ? 'A link' : 'Written answer');

router.get('/:slug/assignments', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group || !(ctx.isMember || ctx.isAdmin)) return notFound(res);
    const g = ctx.group;
    const [{ data: list, error }, { data: subs }, { data: members }] = await Promise.all([
      req.sb.from('cohort_assignments').select('*').eq('group_id', g.id).order('position').order('due_on', { nullsFirst: false }).order('created_at'),
      req.sb.from('cohort_submissions').select('id, assignment_id, user_id, status').eq('group_id', g.id),
      ctx.isLeader ? req.sb.from('group_members').select('user_id, role, status').eq('group_id', g.id) : { data: [] }
    ]);
    if (error && notReady(error)) return res.render('groups/assignments', { title: 'Assignments — ' + g.name, group: g, ctx, list: [], notReady: true, tools: assignable(), toolLabel, mine: {}, counts: {}, learners: 0, msg: null });
    if (error) throw error;
    const mine = {}; const counts = {};
    (subs || []).forEach(s => {
      if (s.user_id === req.user.id) mine[s.assignment_id] = s;
      const c = counts[s.assignment_id] = counts[s.assignment_id] || { submitted: 0, returned: 0, approved: 0 };
      c[s.status] = (c[s.status] || 0) + 1;
    });
    const learners = (members || []).filter(m => (m.status || 'active') === 'active' && !LEADERS.includes(m.role)).length;
    res.render('groups/assignments', { title: 'Assignments — ' + g.name, group: g, ctx, list: list || [], notReady: false, tools: assignable(), toolLabel, mine, counts, learners, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/:slug/assignments', async (req, res, next) => {
  try {
    const ctx = await load(req, req.params.slug);
    if (!ctx.group) return notFound(res);
    const to = '/groups/' + ctx.group.slug + '/assignments';
    if (!ctx.isLeader) return back(res, to, 'Only the cohort\'s leaders can set assignments.');
    const title = String(req.body.title || '').trim().slice(0, 160);
    if (title.length < 3) return back(res, to, 'Give the assignment a title.');
    const [kind, key] = String(req.body.what || 'text:').split(':');
    let row = { kind: 'text', tool_key: null };
    if (kind === 'worksheet' && WORKSHEETS[key]) row = { kind, tool_key: key };
    else if (kind === 'board' && registry.board(key)) row = { kind, tool_key: key };
    else if (kind === 'link') row = { kind: 'link', tool_key: null };
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.due_on || '')) ? req.body.due_on : null;
    const { error } = await req.sb.from('cohort_assignments').insert(Object.assign(row, {
      group_id: ctx.group.id, title, due_on: due, created_by: req.user.id,
      instructions: String(req.body.instructions || '').trim().slice(0, 4000) || null
    }));
    back(res, to, error ? (notReady(error) ? SETTING_UP : 'Could not save the assignment.') : null);
  } catch (e) { next(e); }
});

router.post('/:slug/assignments/:aid/delete', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.aid)) return notFound(res);
    await req.sb.from('cohort_assignments').delete().eq('id', req.params.aid).then(...quiet('cohort_assignments.delete'));
    res.redirect('/groups/' + req.params.slug + '/assignments');
  } catch (e) { next(e); }
});

async function loadAssignment(req) {
  const ctx = await load(req, req.params.slug);
  if (!ctx.group || !(ctx.isMember || ctx.isAdmin) || !UUID.test(req.params.aid)) return { ctx };
  const { data: a } = await req.sb.from('cohort_assignments').select('*').eq('id', req.params.aid).eq('group_id', ctx.group.id).maybeSingle();
  return { ctx, a };
}

router.get('/:slug/assignments/:aid', async (req, res, next) => {
  try {
    const { ctx, a } = await loadAssignment(req);
    if (!a) return notFound(res);
    const g = ctx.group;
    const { data: subs } = await req.sb.from('cohort_submissions').select('id, user_id, status, title, submitted_at, reviewed_at').eq('assignment_id', a.id).order('submitted_at', { ascending: false });
    const mine = (subs || []).find(s => s.user_id === req.user.id) || null;
    let myFull = null;
    if (mine) ({ data: myFull } = await req.sb.from('cohort_submissions').select('*').eq('id', mine.id).maybeSingle());
    // What the member can hand in: their own documents of that kind, or their board.
    let docs = []; let boardCount = 0;
    if (a.kind === 'worksheet') {
      const { data } = await req.sb.from('workspace_docs').select('id, title, updated_at').eq('user_id', req.user.id).eq('kind', a.tool_key).order('updated_at', { ascending: false });
      docs = data || [];
    } else if (a.kind === 'board') {
      const { count } = await req.sb.from('pipeline_items').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('board', a.tool_key);
      boardCount = count || 0;
    }
    let roster = [];
    if (ctx.isLeader) {
      const { data: members } = await req.sb.from('group_members').select('user_id, role, status').eq('group_id', g.id);
      const learners = (members || []).filter(m => (m.status || 'active') === 'active' && !LEADERS.includes(m.role));
      const byUser = {}; (subs || []).forEach(s => { byUser[s.user_id] = s; });
      const pmap = await profilesFor(req, learners.map(m => m.user_id).concat((subs || []).map(s => s.user_id)));
      const ids = [...new Set(learners.map(m => m.user_id).concat(Object.keys(byUser)))];
      roster = ids.map(id => ({ user: pmap[id] || { id }, sub: byUser[id] || null }))
        .sort((x, y) => (x.sub ? 0 : 1) - (y.sub ? 0 : 1) || String(x.user.display_name || '').localeCompare(String(y.user.display_name || '')));
    }
    res.render('groups/assignment', {
      title: a.title + ' — ' + g.name, group: g, ctx, a, toolLabel, mine: myFull, docs, boardCount, roster,
      sheet: a.kind === 'worksheet' ? WORKSHEETS[a.tool_key] || null : null,
      board: a.kind === 'board' ? registry.board(a.tool_key) : null,
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// Hand in: the server builds the copy from the member's own work, so what a
// leader sees is exactly what the member had when they pressed the button.
router.post('/:slug/assignments/:aid/submit', async (req, res, next) => {
  try {
    const { ctx, a } = await loadAssignment(req);
    if (!a) return notFound(res);
    const to = '/groups/' + ctx.group.slug + '/assignments/' + a.id;
    const note = String(req.body.body || '').trim().slice(0, 6000) || null;
    let title = null; let snapshot = null; let source = null; let link = null;
    if (a.kind === 'worksheet') {
      if (!UUID.test(String(req.body.doc_id || ''))) return back(res, to, 'Pick which of your documents to hand in.');
      const { data: doc } = await req.sb.from('workspace_docs').select('id, kind, title, data, updated_at')
        .eq('id', req.body.doc_id).eq('user_id', req.user.id).eq('kind', a.tool_key).maybeSingle();
      if (!doc) return back(res, to, 'That document was not found in your workspace.');
      title = doc.title || null; source = doc.id;
      snapshot = { kind: 'worksheet', tool: a.tool_key, title: doc.title, data: doc.data || {}, saved_at: doc.updated_at };
    } else if (a.kind === 'board') {
      const { data: items } = await req.sb.from('pipeline_items').select('stage, title, value, due_on, data')
        .eq('user_id', req.user.id).eq('board', a.tool_key).order('stage').order('position').limit(300);
      if (!items || !items.length) return back(res, to, 'Your board is empty — add some cards first.');
      snapshot = { kind: 'board', tool: a.tool_key, items };
    } else if (a.kind === 'link') {
      link = String(req.body.link_url || '').trim().slice(0, 500);
      if (!/^https?:\/\/\S+$/i.test(link)) return back(res, to, 'Paste a full link starting with https://');
    } else if (!note) {
      return back(res, to, 'Write your answer before handing it in.');
    }
    const { data: result, error } = await req.sb.rpc('cohort_submit', {
      p_assignment: a.id, p_title: title, p_body: note, p_link: link, p_snapshot: snapshot, p_source: source
    });
    if (error) return back(res, to, notReady(error) ? SETTING_UP : 'Could not hand that in. Please try again.');
    if (result === 'approved') return back(res, to, 'This one is already approved, so it is locked.');
    if (result !== 'submitted') return back(res, to, 'Could not hand that in.');
    res.redirect(to + '?msg=' + enc('Handed in. Your leader has been told.'));
  } catch (e) { next(e); }
});

router.get('/:slug/assignments/:aid/s/:sid', async (req, res, next) => {
  try {
    const { ctx, a } = await loadAssignment(req);
    if (!a || !UUID.test(req.params.sid)) return notFound(res);
    const { data: s } = await req.sb.from('cohort_submissions').select('*').eq('id', req.params.sid).eq('assignment_id', a.id).maybeSingle();
    if (!s) return notFound(res);
    const pmap = await profilesFor(req, [s.user_id, s.reviewed_by]);
    const snap = s.snapshot || null;
    res.render('groups/submission', {
      title: (pmap[s.user_id] || {}).display_name + ' — ' + a.title, group: ctx.group, ctx, a, s, pmap, toolLabel,
      sheet: snap && snap.kind === 'worksheet' ? WORKSHEETS[snap.tool] || null : null,
      board: snap && snap.kind === 'board' ? registry.board(snap.tool) : null,
      msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/:slug/assignments/:aid/s/:sid/review', async (req, res, next) => {
  try {
    const { ctx, a } = await loadAssignment(req);
    if (!a || !UUID.test(req.params.sid)) return notFound(res);
    const to = '/groups/' + ctx.group.slug + '/assignments/' + a.id + '/s/' + req.params.sid;
    const status = req.body.status === 'approved' ? 'approved' : 'returned';
    const feedback = String(req.body.feedback || '').trim().slice(0, 3000);
    if (status === 'returned' && !feedback) return back(res, to, 'Say what to change when you send work back.');
    const { data: ok } = await req.sb.rpc('cohort_review', { p_submission: req.params.sid, p_status: status, p_feedback: feedback });
    if (!ok) return back(res, to, 'Only the cohort\'s leaders can review work.');
    res.redirect('/groups/' + ctx.group.slug + '/assignments/' + a.id + '?msg=' + enc(status === 'approved' ? 'Approved.' : 'Sent back with your feedback.'));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.notReady = notReady;
module.exports.VISIBILITY = VISIBILITY;
