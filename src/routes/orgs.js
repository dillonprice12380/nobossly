// Organizations: accelerators, incubators and programs that run private
// cohorts (Phase 3). Behind FLAGS.orgs. NoBossly admins create organizations;
// an organization's owner adds its admins and staff; any of them create
// cohorts, make invite links, and see each cohort's activity — counts and
// dates, never message content.
const router = require('express').Router();
const crypto = require('crypto');
const pi = require('../personal_info_filter');
const { quiet } = require('../db');
const { notReady } = require('./groups');

const enc = encodeURIComponent;
const KINDS = { accelerator: 'Accelerator', incubator: 'Incubator', nonprofit: 'Nonprofit', university: 'University', other: 'Other' };
const ORG_ROLES = { owner: 'Owner', admin: 'Admin', staff: 'Staff' };
const QUIET_DAYS = 10;
const slugify = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const back = (res, to, err) => res.redirect(to + (err ? (to.includes('?') ? '&' : '?') + 'err=' + enc(err) : ''));
const notFound = res => res.status(404).render('error', { title: 'Not found', message: 'That organization does not exist, or you are not on its team.' });
const isAdmin = req => !!(req.profile && req.profile.is_admin);

async function loadOrg(req) {
  const { data: org, error } = await req.sb.from('organizations').select('*').eq('slug', req.params.org).maybeSingle();
  if (error || !org) return { org: null, error };
  const { data: me } = await req.sb.from('org_admins').select('role').eq('org_id', org.id).eq('user_id', req.user.id).maybeSingle();
  return { org, myRole: me ? me.role : (isAdmin(req) ? 'owner' : null) };
}

router.get('/', async (req, res, next) => {
  try {
    const { data: rows, error } = await req.sb.from('org_admins').select('org_id, role').eq('user_id', req.user.id);
    if (error && notReady(error)) return res.render('orgs/index', { title: 'Programs', orgs: [], notReady: true, admin: isAdmin(req), KINDS, msg: null });
    if (error) throw error;
    let orgs = [];
    if (isAdmin(req)) ({ data: orgs } = await req.sb.from('organizations').select('*').order('name'));
    else if ((rows || []).length) ({ data: orgs } = await req.sb.from('organizations').select('*').in('id', rows.map(r => r.org_id)).order('name'));
    if (!isAdmin(req) && (orgs || []).length === 1) return res.redirect('/orgs/' + orgs[0].slug);
    res.render('orgs/index', { title: 'Programs', orgs: orgs || [], notReady: false, admin: isAdmin(req), KINDS, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

// NoBossly admins only (the policy enforces it too).
router.post('/', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return notFound(res);
    const name = String(req.body.name || '').trim().slice(0, 120);
    const slug = slugify(req.body.slug || name);
    if (name.length < 2 || slug.length < 2) return back(res, '/orgs', 'Give the organization a name.');
    const kind = KINDS[req.body.kind] ? req.body.kind : 'accelerator';
    const website = /^https?:\/\/\S+$/i.test(String(req.body.website_url || '')) ? req.body.website_url : null;
    const { data: org, error } = await req.sb.from('organizations').insert({ name, slug, kind, website_url: website, created_by: req.user.id }).select('id, slug').maybeSingle();
    if (error) return back(res, '/orgs', error.code === '23505' ? 'That web address is taken — try another.' : 'Could not create it.');
    const owner = String(req.body.owner || '').trim().replace(/^@/, '').toLowerCase();
    if (owner) {
      const { data: p } = await req.sb.from('profiles').select('id').eq('username', owner).maybeSingle();
      if (p) await req.sb.from('org_admins').insert({ org_id: org.id, user_id: p.id, role: 'owner' }).then(...quiet('org_admins.owner'));
    }
    res.redirect('/orgs/' + org.slug);
  } catch (e) { next(e); }
});

router.get('/:org', async (req, res, next) => {
  try {
    const { org, myRole } = await loadOrg(req);
    if (!org || !myRole) return notFound(res);
    const [{ data: cohorts }, { data: team }] = await Promise.all([
      req.sb.from('groups').select('*').eq('org_id', org.id).order('created_at', { ascending: false }),
      req.sb.from('org_admins').select('user_id, role, created_at').eq('org_id', org.id).order('created_at')
    ]);
    const ids = (cohorts || []).map(c => c.id);
    const counts = {};
    if (ids.length) {
      const { data: m } = await req.sb.from('group_members').select('group_id, status').in('group_id', ids);
      (m || []).forEach(r => { if ((r.status || 'active') === 'active') counts[r.group_id] = (counts[r.group_id] || 0) + 1; });
    }
    const { data: people } = (team || []).length ? await req.sb.from('profiles').select('id, username, display_name').in('id', team.map(t => t.user_id)) : { data: [] };
    const pmap = {}; (people || []).forEach(p => { pmap[p.id] = p; });
    res.render('orgs/show', { title: org.name, org, myRole, cohorts: cohorts || [], counts, team: team || [], pmap, KINDS, ORG_ROLES, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/:org/cohorts', async (req, res, next) => {
  try {
    const { org, myRole } = await loadOrg(req);
    if (!org || !myRole) return notFound(res);
    const to = '/orgs/' + org.slug;
    const name = String(req.body.name || '').trim().slice(0, 80);
    const description = String(req.body.description || '').trim().slice(0, 600);
    if (name.length < 2) return back(res, to, 'Give the cohort a name.');
    const found = pi.check(name + '\n' + description);
    if (found) return pi.refuse(req, res, to, found, 'cohort');
    const slug = (org.slug + '-' + slugify(name)).slice(0, 52) + '-' + crypto.randomBytes(2).toString('hex');
    const { data: gid, error } = await req.sb.rpc('cohort_create', { p_org: org.id, p_name: name, p_slug: slug, p_description: description || null });
    if (error || !gid) return back(res, to, 'Could not create the cohort.');
    // Every cohort starts with an invite link, valid for 30 days.
    await req.sb.from('group_invites').insert({ group_id: gid, created_by: req.user.id, code: crypto.randomBytes(12).toString('base64url'),
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }).then(...quiet('group_invites.first'));
    res.redirect('/groups/' + slug + '#invites');
  } catch (e) { next(e); }
});

router.post('/:org/team', async (req, res, next) => {
  try {
    const { org, myRole } = await loadOrg(req);
    if (!org || !myRole) return notFound(res);
    const to = '/orgs/' + org.slug;
    if (myRole !== 'owner') return back(res, to, 'Only the organization\'s owner can change the team.');
    const username = String(req.body.username || '').trim().replace(/^@/, '').toLowerCase();
    const role = ORG_ROLES[req.body.role] ? req.body.role : 'staff';
    const { data: p } = await req.sb.from('profiles').select('id').eq('username', username).maybeSingle();
    if (!p) return back(res, to, 'No member with that username.');
    const { error } = await req.sb.from('org_admins').upsert({ org_id: org.id, user_id: p.id, role }, { onConflict: 'org_id,user_id' });
    back(res, to, error ? 'Could not add them.' : null);
  } catch (e) { next(e); }
});

router.post('/:org/team/:uid/remove', async (req, res, next) => {
  try {
    const { org, myRole } = await loadOrg(req);
    if (!org || !myRole) return notFound(res);
    if (myRole !== 'owner' || req.params.uid === req.user.id) return back(res, '/orgs/' + org.slug, 'You cannot remove that person.');
    await req.sb.from('org_admins').delete().eq('org_id', org.id).eq('user_id', req.params.uid).then(...quiet('org_admins.remove'));
    res.redirect('/orgs/' + org.slug);
  } catch (e) { next(e); }
});

// A cohort's activity: who is active, who has gone quiet, and work handed in.
// Counts and dates only — never the content of posts or messages.
async function activity(req, org, group, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const [{ data: members }, { data: posts }, { data: assignments }, { data: subs }] = await Promise.all([
    req.sb.from('group_members').select('user_id, role, status, joined_at').eq('group_id', group.id),
    req.sb.from('group_posts').select('user_id, created_at').eq('group_id', group.id).gte('created_at', weekAgo).limit(5000),
    req.sb.from('cohort_assignments').select('id, title, due_on').eq('group_id', group.id),
    req.sb.from('cohort_submissions').select('user_id, assignment_id, status, submitted_at').eq('group_id', group.id)
  ]);
  const active = (members || []).filter(m => (m.status || 'active') === 'active');
  const { data: people } = active.length ? await req.sb.from('profiles').select('id, username, display_name, last_active_at').in('id', active.map(m => m.user_id)) : { data: [] };
  const pmap = {}; (people || []).forEach(p => { pmap[p.id] = p; });
  const postsBy = {}; (posts || []).forEach(p => { postsBy[p.user_id] = (postsBy[p.user_id] || 0) + 1; });
  const subsBy = {}; (subs || []).forEach(s => { const x = subsBy[s.user_id] = subsBy[s.user_id] || { handed: 0, approved: 0, last: null }; x.handed++; if (s.status === 'approved') x.approved++; if (!x.last || s.submitted_at > x.last) x.last = s.submitted_at; });
  const quietBefore = now.getTime() - QUIET_DAYS * 86400000;
  const rows = active.map(m => {
    const p = pmap[m.user_id] || {};
    const last = [p.last_active_at, (subsBy[m.user_id] || {}).last].filter(Boolean).sort().pop() || null;
    return {
      user_id: m.user_id, name: p.display_name || p.username || 'a member', username: p.username || '', role: m.role,
      joined: m.joined_at, lastActive: last, postsWeek: postsBy[m.user_id] || 0,
      handed: (subsBy[m.user_id] || {}).handed || 0, approved: (subsBy[m.user_id] || {}).approved || 0,
      quiet: !last || new Date(last).getTime() < quietBefore
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const learners = rows.filter(r => !['owner', 'admin', 'mentor'].includes(r.role));
  return {
    rows, learners, quiet: learners.filter(r => r.quiet),
    assignments: assignments || [],
    totals: { members: learners.length, postsWeek: (posts || []).length, handed: (subs || []).length, approved: (subs || []).filter(s => s.status === 'approved').length }
  };
}

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
};

router.get('/:org/cohorts/:group', async (req, res, next) => {
  try {
    const { org, myRole } = await loadOrg(req);
    if (!org || !myRole) return notFound(res);
    const { data: group } = await req.sb.from('groups').select('*').eq('slug', req.params.group).eq('org_id', org.id).maybeSingle();
    if (!group) return notFound(res);
    const act = await activity(req, org, group);
    if (req.query.format === 'csv') {
      const day = d => (d ? String(d).slice(0, 10) : '');
      const lines = [['Name', 'Username', 'Role', 'Joined', 'Last active', 'Posts (7 days)', 'Assignments handed in', 'Approved', 'Gone quiet'].map(csvCell).join(',')]
        .concat(act.rows.map(r => [r.name, r.username, r.role, day(r.joined), day(r.lastActive), r.postsWeek, r.handed, r.approved, r.quiet ? 'yes' : 'no'].map(csvCell).join(',')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + group.slug + '-activity-' + new Date().toISOString().slice(0, 10) + '.csv"');
      return res.send('﻿' + lines.join('\r\n') + '\r\n');
    }
    res.render('orgs/cohort', { title: group.name + ' — activity', org, group, act, QUIET_DAYS });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.activity = activity;
module.exports.csvCell = csvCell;
