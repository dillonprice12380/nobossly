// The workspace: the planning tools every member has, ordered for their path
// (src/path_dashboards), plus goals and personal milestones. The boards,
// number logs and checklists the path configs declare are mounted beside this
// (src/routes/boards.js).
//
// Everything here is private to the member. Storage: workspace_docs (from
// migrations/2026-11-01_workspace_foundations.sql) and the existing
// user_custom_milestones.
const router = require('express').Router();
const dashboards = require('../path_dashboards');
const { WORKSHEETS, clean, progress, ideaScore, pitchStats, summaryOf } = require('../workspace/worksheets');
const matrix = require('../workspace/matrix');
const paths = require('../paths');
const { quiet } = require('../db');
const mailer = require('../mailer');

const enc = encodeURIComponent;
const missing = err => !!err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|Could not find the table/i.test(err.message || ''));
const GOAL_STATUS = { active: 'Active', done: 'Done', dropped: 'Dropped' };
const MAX_VERSIONS = 10;
// A share function that is not there yet (migrations/2026-11-02_workspace_shares.sql unapplied).
const noFn = err => !!err && (missing(err) || err.code === 'PGRST202' || /Could not find the function/i.test(err.message || ''));
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Whether this member may share (in a cohort, or on a program team). False when sharing is not set up yet.
async function canShare(sb) {
  const { data, error } = await sb.rpc('can_share_docs');
  return !error && data === true;
}

// The hub: featured tools first, then the rest, then the library.
router.get('/', async (req, res, next) => {
  try {
    const slug = req.profile.path;
    const { data: docs, error } = await req.sb.from('workspace_docs')
      .select('id, kind, title, updated_at').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(200);
    const recent = {};
    (docs || []).forEach(d => { (recent[d.kind] = recent[d.kind] || []).push(d); });
    res.render('workspace/index', {
      title: 'Workspace', tools: dashboards.workspaceFor(slug), recent, notReady: missing(error),
      pathItems: dashboards.pathItemsFor(req.profile),
      pathDef: slug ? paths.get(slug) : null, needsSetup: dashboards.needsSetup(req.profile), msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------- Worksheets
const defOf = kind => WORKSHEETS[kind] || null;

// Worksheets about money (costs, prices, break-even) belong to Dashboard →
// Money in the nav, though their pages live here.
router.param('kind', (req, res, next, kind) => {
  if (dashboards.isMoney(kind)) res.locals.navSub = 'money';
  next();
});

router.get('/docs/:kind', async (req, res, next) => {
  try {
    const def = defOf(req.params.kind);
    if (!def) return res.status(404).render('error', { title: 'Not found', message: 'That tool does not exist.' });
    const { data, error } = await req.sb.from('workspace_docs').select('id, title, data, updated_at')
      .eq('user_id', req.user.id).eq('kind', req.params.kind).order('updated_at', { ascending: false });
    if (missing(error)) return res.render('workspace/doc_list', { title: def.label, def, kind: req.params.kind, docs: [], notReady: true, progress, msg: null });
    res.render('workspace/doc_list', { title: def.label, def, kind: req.params.kind, docs: data || [], notReady: false, progress, ideaScore, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/docs/:kind', async (req, res, next) => {
  try {
    const def = defOf(req.params.kind);
    if (!def) return res.redirect('/workspace');
    const title = String(req.body.title || '').trim().slice(0, 120) || ('My ' + def.label.toLowerCase());
    const { data: doc, error } = await req.sb.from('workspace_docs')
      .insert({ user_id: req.user.id, kind: req.params.kind, title, data: {} }).select('id').maybeSingle();
    if (error || !doc) return res.redirect('/workspace/docs/' + req.params.kind + '?err=' + enc(missing(error) ? 'The workspace is being set up — try again shortly.' : 'Could not create that. Please try again.'));
    res.redirect('/workspace/docs/' + req.params.kind + '/' + doc.id);
  } catch (e) { next(e); }
});

router.get('/docs/:kind/:id', async (req, res, next) => {
  try {
    const def = defOf(req.params.kind);
    if (!def) return res.status(404).render('error', { title: 'Not found', message: 'That tool does not exist.' });
    const { data: doc } = await req.sb.from('workspace_docs').select('*')
      .eq('id', req.params.id).eq('user_id', req.user.id).eq('kind', req.params.kind).maybeSingle();
    if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'That document is gone.' });
    res.render('workspace/doc', {
      title: (doc.title || def.label) + ' — ' + def.label, def, kind: req.params.kind, doc, data: doc.data || {},
      progress: progress(def, doc.data || {}), score: req.params.kind === 'idea_refiner' ? ideaScore(doc.data || {}) : null,
      pitch: req.params.kind === 'elevator_pitch' ? pitchStats((doc.data || {}).pitch) : null,
      matrix: def.layout === 'matrix' ? matrix.results(doc.data || {}) : null,
      summary: summaryOf(def, doc.data || {}),
      saved: !!req.query.saved, canShare: await canShare(req.sb)
    });
  } catch (e) { next(e); }
});

router.post('/docs/:kind/:id', async (req, res, next) => {
  try {
    const def = defOf(req.params.kind);
    if (!def) return res.redirect('/workspace');
    const to = '/workspace/docs/' + req.params.kind + '/' + req.params.id;
    const { data: doc } = await req.sb.from('workspace_docs').select('data')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!doc) return res.redirect('/workspace/docs/' + req.params.kind);
    const data = clean(def, req.body);
    // A pitch keeps its earlier wordings, newest first, so a member can see how
    // it sharpened and go back to a version that worked.
    if (req.params.kind === 'elevator_pitch') {
      const before = (doc.data || {}).pitch;
      const versions = Array.isArray((doc.data || {}).versions) ? doc.data.versions : [];
      data.versions = before && before !== data.pitch
        ? [{ text: before, saved_at: new Date().toISOString() }].concat(versions).slice(0, MAX_VERSIONS)
        : versions;
    }
    const title = String(req.body.title || '').trim().slice(0, 120);
    const { error } = await req.sb.from('workspace_docs')
      .update(Object.assign({ data }, title ? { title } : {})).eq('id', req.params.id).eq('user_id', req.user.id);
    const auto = req.get('X-Autosave') === '1';   // the editor saving itself in the background
    if (error) return auto ? res.status(500).end() : res.redirect(to + '?err=' + enc('Could not save. Please try again.'));
    if (auto) return res.status(204).end();
    res.redirect(to + '?saved=1');
  } catch (e) { next(e); }
});

// ------------------------------------------------- Viewing, PDF and sharing
const ownDoc = (sb, req) => sb.from('workspace_docs').select('*')
  .eq('id', req.params.id).eq('user_id', req.user.id).eq('kind', req.params.kind).maybeSingle();
const nameOf = p => p ? (p.display_name || p.username || 'A member') : 'A member';

// The worksheet read-only: the canvas as a poster, ready to print or save as PDF.
router.get('/docs/:kind/:id/view', async (req, res, next) => {
  try {
    const def = defOf(req.params.kind);
    if (!def) return res.status(404).render('error', { title: 'Not found', message: 'That tool does not exist.' });
    const { data: doc } = await ownDoc(req.sb, req);
    if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'That document is gone.' });
    res.render('workspace/view', {
      title: (doc.title || def.label) + ' — ' + def.label, def, kind: req.params.kind, doc, data: doc.data || {},
      mode: 'owner', ownerName: nameOf(req.profile), canShare: await canShare(req.sb), autoPdf: req.query.pdf === '1'
    });
  } catch (e) { next(e); }
});

// Who it is shared with, and the two ways to share: a cohort member by name, or by email.
router.get('/docs/:kind/:id/share', async (req, res, next) => {
  try {
    const def = defOf(req.params.kind);
    if (!def) return res.status(404).render('error', { title: 'Not found', message: 'That tool does not exist.' });
    const { data: doc } = await ownDoc(req.sb, req);
    if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'That document is gone.' });
    const [cand, sh] = await Promise.all([
      req.sb.rpc('share_candidates'),
      req.sb.from('workspace_shares').select('id, recipient_id, email, note, created_at, expires_at, revoked_at, last_viewed_at')
        .eq('doc_id', doc.id).is('revoked_at', null).order('created_at', { ascending: false })
    ]);
    const notReady = noFn(cand.error) || missing(sh.error);
    const candidates = (cand.data || []).slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const byId = {};
    candidates.forEach(c => { byId[c.user_id] = c; });
    const ids = (sh.data || []).map(x => x.recipient_id).filter(id => id && !byId[id]);
    if (ids.length) {
      const { data: ps } = await req.sb.from('profiles').select('id, username, display_name').in('id', ids);
      (ps || []).forEach(p => { byId[p.id] = Object.assign({ user_id: p.id }, p); });
    }
    const now = Date.now();
    const shares = (sh.data || []).filter(x => !x.expires_at || new Date(x.expires_at).getTime() > now)
      .map(x => Object.assign({}, x, { who: x.recipient_id ? byId[x.recipient_id] || null : null }));
    const sharedWith = new Set(shares.map(x => x.recipient_id).filter(Boolean));
    res.render('workspace/share', {
      title: 'Share — ' + (doc.title || def.label), def, kind: req.params.kind, doc, notReady,
      allowed: !notReady && await canShare(req.sb), candidates: candidates.filter(c => !sharedWith.has(c.user_id)),
      shares, nameOf, link: req.query.link || null, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

const shareBase = req => '/workspace/docs/' + req.params.kind + '/' + req.params.id + '/share';
const note = b => String(b.note || '').trim().slice(0, 500) || null;

router.post('/docs/:kind/:id/share/member', async (req, res, next) => {
  try {
    const to = shareBase(req);
    const { data, error } = await req.sb.rpc('doc_share_member', { p_doc: req.params.id, p_recipient: String(req.body.recipient || ''), p_note: note(req.body) });
    if (noFn(error)) return res.redirect(to + '?err=' + enc('Sharing is being set up — try again shortly.'));
    if (error || !data) return res.redirect(to + '?err=' + enc('Could not share with that person. You can share with members of your own cohorts.'));
    res.redirect(to + '?msg=' + enc('Shared. They have been notified and will find it under "Shared with you".'));
  } catch (e) { next(e); }
});

router.post('/docs/:kind/:id/share/email', async (req, res, next) => {
  try {
    const to = shareBase(req);
    const def = defOf(req.params.kind);
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!def || !EMAIL.test(email) || email.length > 254) return res.redirect(to + '?err=' + enc('Enter a valid email address.'));
    const { data: token, error } = await req.sb.rpc('doc_share_email', { p_doc: req.params.id, p_email: email, p_note: note(req.body) });
    if (noFn(error)) return res.redirect(to + '?err=' + enc('Sharing is being set up — try again shortly.'));
    if (error || !token) return res.redirect(to + '?err=' + enc('Could not share by email. Sharing is for members of a cohort, up to 20 emails a day.'));
    const { data: doc } = await req.sb.from('workspace_docs').select('title').eq('id', req.params.id).maybeSingle();
    const link = mailer.SITE + '/shared/' + token;
    const sent = await mailer.send('doc_share', email, null, {
      userId: req.user.id,
      template: { from: nameOf(req.profile), title: (doc && doc.title) || def.label, label: def.label.toLowerCase(), note: note(req.body), link }
    });
    res.redirect(to + '?link=' + enc(link) + '&msg=' + enc(sent
      ? 'Sent to ' + email + '. The link works for 30 days, until you turn it off.'
      : 'The link is ready, but the email could not be sent right now. Copy the link below and send it yourself.'));
  } catch (e) { next(e); }
});

router.post('/docs/:kind/:id/share/:sid/revoke', async (req, res, next) => {
  try {
    await req.sb.rpc('doc_share_revoke', { p_share: req.params.sid }).then(...quiet('doc_share_revoke'));
    res.redirect(shareBase(req) + '?msg=' + enc('Sharing turned off.'));
  } catch (e) { next(e); }
});

// Worksheets other members shared with you.
router.get('/shared', async (req, res, next) => {
  try {
    const { data, error } = await req.sb.rpc('shared_with_me');
    res.render('workspace/shared', {
      title: 'Shared with you', notReady: noFn(error),
      items: (data || []).map(d => Object.assign({}, d, { def: defOf(d.kind) })).filter(d => d.def)
    });
  } catch (e) { next(e); }
});

router.get('/shared/:sid', async (req, res, next) => {
  try {
    const gone = () => res.status(404).render('error', { title: 'Not available', message: 'That worksheet is no longer shared with you.' });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.sid)) return gone();
    const { data: d, error } = await req.sb.rpc('shared_doc', { p_share: req.params.sid });
    const def = d && defOf(d.kind);
    if (error || !def) return gone();
    res.render('workspace/view', {
      title: (d.title || def.label) + ' — shared with you', def, kind: d.kind,
      doc: { id: d.share_id, title: d.title, updated_at: d.updated_at }, data: d.data || {},
      mode: 'member', ownerName: d.owner, note: d.note || null, canShare: false
    });
  } catch (e) { next(e); }
});

router.post('/docs/:kind/:id/duplicate', async (req, res, next) => {
  try {
    const { data: doc } = await req.sb.from('workspace_docs').select('kind, title, data')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!doc) return res.redirect('/workspace/docs/' + req.params.kind);
    const { data: copy } = await req.sb.from('workspace_docs')
      .insert({ user_id: req.user.id, kind: doc.kind, title: (doc.title + ' (copy)').slice(0, 120), data: doc.data }).select('id').maybeSingle();
    res.redirect('/workspace/docs/' + doc.kind + (copy ? '/' + copy.id : ''));
  } catch (e) { next(e); }
});

router.post('/docs/:kind/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('workspace_docs').delete().eq('id', req.params.id).eq('user_id', req.user.id).then(...quiet('workspace_docs.delete'));
    res.redirect('/workspace/docs/' + req.params.kind + '?msg=' + enc('Deleted.'));
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ Goals
// A goal is a small document: what, why, how you will know, by when, and the
// next step. Kept in workspace_docs as kind 'goal'.
router.get('/goals', async (req, res, next) => {
  try {
    const { data, error } = await req.sb.from('workspace_docs').select('id, title, data, updated_at')
      .eq('user_id', req.user.id).eq('kind', 'goal').order('updated_at', { ascending: false });
    const goals = (data || []).map(g => Object.assign({ id: g.id, title: g.title }, g.data || {}));
    const order = { active: 0, done: 1, dropped: 2 };
    goals.sort((a, b) => (order[a.status || 'active'] - order[b.status || 'active']) || String(a.target || '9999').localeCompare(String(b.target || '9999')));
    res.render('workspace/goals', { title: 'Goals', goals, notReady: missing(error), GOAL_STATUS, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

const goalData = b => {
  const d = {};
  const t = (v, n) => String(v || '').trim().slice(0, n);
  if (t(b.why, 600)) d.why = t(b.why, 600);
  if (t(b.measure, 300)) d.measure = t(b.measure, 300);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.target || ''))) d.target = b.target;
  if (t(b.next_step, 300)) d.next_step = t(b.next_step, 300);
  d.status = GOAL_STATUS[b.status] ? b.status : 'active';
  return d;
};

router.post('/goals', async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    if (!title) return res.redirect('/workspace/goals?err=' + enc('Name the goal first.'));
    const { error } = await req.sb.from('workspace_docs').insert({ user_id: req.user.id, kind: 'goal', title, data: goalData(req.body) });
    res.redirect('/workspace/goals' + (error ? '?err=' + enc('Could not save that goal. Please try again.') : ''));
  } catch (e) { next(e); }
});

router.post('/goals/:id', async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    await req.sb.from('workspace_docs').update(Object.assign({ data: goalData(req.body) }, title ? { title } : {}))
      .eq('id', req.params.id).eq('user_id', req.user.id).eq('kind', 'goal').then(...quiet('workspace_docs.goal'));
    res.redirect('/workspace/goals');
  } catch (e) { next(e); }
});

router.post('/goals/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('workspace_docs').delete().eq('id', req.params.id).eq('user_id', req.user.id).eq('kind', 'goal').then(...quiet('workspace_docs.goal_delete'));
    res.redirect('/workspace/goals');
  } catch (e) { next(e); }
});

// ------------------------------------------------------------- Milestones
// Personal milestones in the member's own words, in user_custom_milestones
// (achieved ones are visible on their profile, by that table's own policy).
router.get('/milestones', async (req, res, next) => {
  try {
    const { data } = await req.sb.from('user_custom_milestones').select('id, title, description, emoji, achieved, date_achieved, created_at')
      .eq('user_id', req.user.id).order('achieved').order('created_at', { ascending: false });
    res.render('workspace/milestones', { title: 'Milestones', milestones: data || [], msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/milestones', async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    if (!title) return res.redirect('/workspace/milestones');
    const emoji = String(req.body.emoji || '').trim().slice(0, 8) || '🏁';
    await req.sb.from('user_custom_milestones').insert({
      user_id: req.user.id, title, emoji, description: String(req.body.description || '').trim().slice(0, 500), category: 'Personal'
    }).then(...quiet('user_custom_milestones.insert'));
    res.redirect('/workspace/milestones');
  } catch (e) { next(e); }
});

router.post('/milestones/:id/toggle', async (req, res, next) => {
  try {
    const { data: m } = await req.sb.from('user_custom_milestones').select('achieved').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (m) {
      const now = new Date();
      await req.sb.from('user_custom_milestones').update(m.achieved
        ? { achieved: false, date_achieved: null, achieved_at: null }
        : { achieved: true, date_achieved: now.toISOString().slice(0, 10), achieved_at: now.toISOString() })
        .eq('id', req.params.id).eq('user_id', req.user.id).then(...quiet('user_custom_milestones.toggle'));
    }
    res.redirect('/workspace/milestones');
  } catch (e) { next(e); }
});

router.post('/milestones/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('user_custom_milestones').delete().eq('id', req.params.id).eq('user_id', req.user.id).then(...quiet('user_custom_milestones.delete'));
    res.redirect('/workspace/milestones');
  } catch (e) { next(e); }
});

module.exports = router;
