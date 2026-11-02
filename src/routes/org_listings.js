// The provider console: an organization's programs and courses. Mounted at
// /orgs beside src/routes/orgs.js (cohorts and team). Anyone on the
// organization's team can write listings and lessons; the database decides
// who may publish (approved providers only), who sees what, and who can be
// accepted (migrations/2026-11-03_marketplace.sql).
const router = require('express').Router();
const crypto = require('crypto');
const mk = require('../marketplace');
const { WORKSHEETS } = require('../workspace/worksheets');
const { quiet } = require('../db');

const enc = encodeURIComponent;
const UUID = /^[0-9a-f-]{36}$/i;
const noFn = err => !!err && (err.code === 'PGRST202' || err.code === '42883' || err.code === '42P01' || err.code === 'PGRST205' || err.code === '42703'
  || /Could not find the function|does not exist|column/i.test(err.message || ''));
const back = (res, to, m, isErr) => res.redirect(to + (to.includes('?') ? '&' : '?') + (isErr ? 'err=' : 'msg=') + enc(m));
const TOOL_KEYS = Object.keys(WORKSHEETS);
const TOOLS = TOOL_KEYS.map(k => ({ key: k, label: WORKSHEETS[k].label, emoji: WORKSHEETS[k].emoji })).sort((a, b) => a.label.localeCompare(b.label));
const isAdmin = req => !!(req.profile && req.profile.is_admin);

// The organization (by slug) and the caller's role on it; null when they are
// not on its team. RLS on organizations already hides it from everyone else.
async function orgOf(req) {
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(req.params.org)) return null;
  const { data: org } = await req.sb.from('organizations').select('*').eq('slug', req.params.org).maybeSingle();
  if (!org) return null;
  const { data: me } = await req.sb.from('org_admins').select('role').eq('org_id', org.id).eq('user_id', req.user.id).maybeSingle();
  const role = me ? me.role : (isAdmin(req) ? 'owner' : null);
  return role ? { org, role } : null;
}

async function listingOf(req, o) {
  if (!UUID.test(req.params.id)) return null;
  const { data } = await req.sb.from('listings').select('*').eq('id', req.params.id).eq('org_id', o.org.id).maybeSingle();
  return data || null;
}

const notFound = res => res.status(404).render('error', { title: 'Not found', message: 'That is not here, or you are not on this organization\'s team.' });
const base = (o, l) => '/orgs/' + o.org.slug + '/listings' + (l ? '/' + l.id : '');

// ------------------------------------------------------------- The console
router.get('/:org/listings', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const { data: listings, error } = await req.sb.from('listings').select('id, kind, title, slug, status, join_mode, starts_on, updated_at')
      .eq('org_id', o.org.id).order('updated_at', { ascending: false });
    const ids = (listings || []).map(l => l.id);
    const { data: people } = ids.length ? await req.sb.from('listing_enrollments').select('listing_id, status').in('listing_id', ids) : { data: [] };
    const counts = {};
    (people || []).forEach(p => { const c = counts[p.listing_id] = counts[p.listing_id] || { applied: 0, enrolled: 0 }; if (c[p.status] !== undefined) c[p.status]++; });
    res.render('orgs/listings', { title: 'Programs & courses — ' + o.org.name, mk, org: o.org, myRole: o.role, listings: listings || [], counts, notReady: noFn(error), msg: req.query.msg || null });
  } catch (e) { next(e); }
});

// Public profile shown on listings: tagline, about, website.
router.post('/:org/profile', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o || !['owner', 'admin'].includes(o.role)) return notFound(res);
    const website = mk.url(req.body.website_url);
    const { error } = await req.sb.from('organizations').update({
      tagline: mk.str(req.body.tagline, 160) || null, about: mk.str(req.body.about, 2000) || null,
      website_url: website || null
    }).eq('id', o.org.id);
    back(res, '/orgs/' + o.org.slug + '/listings', error ? 'Could not save the profile.' : 'Profile saved.', !!error);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------ A listing
router.get('/:org/listings/new', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const kind = mk.KINDS[req.query.kind] ? req.query.kind : 'course';
    res.render('orgs/listing_new', { title: 'New ' + mk.KINDS[kind].toLowerCase(), mk, org: o.org, kind });
  } catch (e) { next(e); }
});

router.post('/:org/listings', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const kind = mk.KINDS[req.body.kind] ? req.body.kind : 'course';
    const title = mk.str(req.body.title, 120);
    const summary = mk.str(req.body.summary, 280);
    const to = '/orgs/' + o.org.slug + '/listings/new?kind=' + kind;
    if (title.length < 3) return back(res, to, 'Give it a title of at least 3 characters.', true);
    if (summary.length < 10) return back(res, to, 'Add a one-line summary (at least 10 characters).', true);
    let stem = (mk.slugify(title) || 'listing').replace(/^-+/, '').slice(0, 64).padEnd(3, 'x');
    if (['mine', 'enrollment'].includes(stem)) stem = stem + '-' + kind;   // these are /programs pages
    let row = null, error = null;
    for (const slug of [stem, stem + '-' + crypto.randomBytes(2).toString('hex'), stem + '-' + crypto.randomBytes(3).toString('hex')]) {
      ({ data: row, error } = await req.sb.from('listings').insert({
        org_id: o.org.id, kind, title, summary, slug, created_by: req.user.id,
        join_mode: kind === 'course' ? 'enroll' : 'apply', format: 'online'
      }).select('id').maybeSingle());
      if (!error || error.code !== '23505') break;
    }
    if (error || !row) return back(res, to, noFn(error) ? 'Listings open shortly — this part is being set up.' : 'Could not create it. Please try again.', true);
    res.redirect('/orgs/' + o.org.slug + '/listings/' + row.id + '?msg=' + enc('Created as a draft. Fill in the details, then publish.'));
  } catch (e) { next(e); }
});

router.get('/:org/listings/:id', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l) return notFound(res);
    const { data: cohorts } = await req.sb.from('groups').select('id, name, slug').eq('org_id', o.org.id).order('created_at', { ascending: false });
    const { count: lessons } = await req.sb.from('course_lessons').select('id', { count: 'exact', head: true }).eq('listing_id', l.id);
    res.render('orgs/listing_edit', { title: 'Edit — ' + l.title, mk, org: o.org, myRole: o.role, l, cohorts: cohorts || [], lessons: lessons || 0, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/:org/listings/:id', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l) return notFound(res);
    const to = base(o, l);
    const { row, error: bad } = mk.cleanListing(req.body);
    if (bad) return back(res, to, bad, true);
    // The cohort accepted members join: one of this organization's, a new one, or none.
    if (req.body.cohort === 'new') {
      const name = (row.title + (row.starts_on ? ' · ' + row.starts_on.slice(0, 7) : '')).slice(0, 80);
      const slug = (l.slug.slice(0, 50) + '-' + crypto.randomBytes(2).toString('hex'));
      const { data: gid, error } = await req.sb.rpc('cohort_create', { p_org: o.org.id, p_name: name, p_slug: slug, p_description: row.summary });
      if (error) return back(res, to, 'Could not create the cohort.', true);
      row.group_id = gid;
    } else {
      row.group_id = UUID.test(req.body.cohort || '') ? req.body.cohort : null;
    }
    const { error } = await req.sb.from('listings').update(row).eq('id', l.id).eq('org_id', o.org.id);
    if (error) return back(res, to, /cohort belongs/i.test(error.message || '') ? 'Choose one of your own cohorts.' : 'Could not save. Please try again.', true);
    back(res, to, 'Saved.');
  } catch (e) { next(e); }
});

router.post('/:org/listings/:id/status', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l) return notFound(res);
    const status = mk.STATUS[req.body.status] ? req.body.status : 'draft';
    const to = base(o, l);
    if (status === 'published' && l.kind === 'course') {
      const { count } = await req.sb.from('course_lessons').select('id', { count: 'exact', head: true }).eq('listing_id', l.id);
      if (!count) return back(res, to, 'Add at least one lesson before publishing a course.', true);
    }
    const { error } = await req.sb.from('listings').update({ status }).eq('id', l.id).eq('org_id', o.org.id);
    if (error) return back(res, to, /not approved to publish/i.test(error.message || '') ? 'Your organization is not approved to publish yet. Apply at /providers/apply, or ask us to turn on listings for it.' : 'Could not change that.', true);
    back(res, to, { published: 'Published — it\'s live in the marketplace.', closed: 'Closed to new applications and enrollments. People already in keep access.', draft: 'Back to draft — hidden from the marketplace.' }[status]);
  } catch (e) { next(e); }
});

router.post('/:org/listings/:id/delete', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l) return notFound(res);
    const { error } = await req.sb.from('listings').delete().eq('id', l.id).eq('org_id', o.org.id);
    back(res, '/orgs/' + o.org.slug + '/listings', error ? 'Only the organization\'s owner or admins can delete a listing.' : 'Deleted.', !!error);
  } catch (e) { next(e); }
});

// ------------------------------------------------- Applicants and learners
router.get('/:org/listings/:id/people', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l) return notFound(res);
    const [{ data: rows }, { count: lessons }, { data: progress }] = await Promise.all([
      req.sb.from('listing_enrollments').select('*').eq('listing_id', l.id).order('created_at', { ascending: false }),
      req.sb.from('course_lessons').select('id', { count: 'exact', head: true }).eq('listing_id', l.id),
      req.sb.from('lesson_progress').select('user_id').eq('listing_id', l.id)
    ]);
    const ids = [...new Set((rows || []).map(r => r.user_id))];
    const { data: people } = ids.length ? await req.sb.from('profiles').select('id, username, display_name, path, location').in('id', ids) : { data: [] };
    const done = {};
    (progress || []).forEach(p => { done[p.user_id] = (done[p.user_id] || 0) + 1; });
    res.render('orgs/listing_people', {
      title: 'People — ' + l.title, mk, org: o.org, l, rows: rows || [], pmap: Object.fromEntries((people || []).map(p => [p.id, p])),
      done, lessons: lessons || 0, paths: require('../paths'), msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/:org/listings/:id/people/:eid', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l || !UUID.test(req.params.eid)) return notFound(res);
    const action = ['accept', 'decline', 'remove'].includes(req.body.action) ? req.body.action : null;
    const { data } = action ? await req.sb.rpc('listing_decide', { p_enrollment: req.params.eid, p_action: action, p_note: mk.str(req.body.note, 500) || null }) : { data: null };
    back(res, base(o, l) + '/people', data ? { enrolled: 'Accepted — they\'re in, and have been told.', declined: 'Declined — they have been told.', removed: 'Removed.' }[data] : 'Could not do that (it may already be decided).', !data);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------ Curriculum
async function curriculum(req, l) {
  const [{ data: mods }, { data: lessons }] = await Promise.all([
    req.sb.from('course_modules').select('*').eq('listing_id', l.id).order('position').order('created_at'),
    req.sb.from('course_lessons').select('id, module_id, title, minutes, video_url, tool_key, position, created_at').eq('listing_id', l.id).order('position').order('created_at')
  ]);
  return (mods || []).map(m => Object.assign({}, m, { lessons: (lessons || []).filter(x => x.module_id === m.id) }));
}

router.get('/:org/listings/:id/curriculum', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l) return notFound(res);
    res.render('orgs/curriculum', { title: 'Lessons — ' + l.title, mk, org: o.org, l, modules: await curriculum(req, l), msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/:org/listings/:id/modules', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l) return notFound(res);
    const title = mk.str(req.body.title, 120);
    const to = base(o, l) + '/curriculum';
    if (!title) return back(res, to, 'Name the module.', true);
    const { count } = await req.sb.from('course_modules').select('id', { count: 'exact', head: true }).eq('listing_id', l.id);
    const { error } = await req.sb.from('course_modules').insert({ listing_id: l.id, title, position: count || 0 });
    back(res, to, error ? 'Could not add the module.' : 'Module added.', !!error);
  } catch (e) { next(e); }
});

// Rename, move up or down, or delete a module.
router.post('/:org/listings/:id/modules/:mid', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l || !UUID.test(req.params.mid)) return notFound(res);
    const to = base(o, l) + '/curriculum';
    const mods = await curriculum(req, l);
    const i = mods.findIndex(m => m.id === req.params.mid);
    if (i < 0) return res.redirect(to);
    if (req.body.action === 'delete') {
      await req.sb.from('course_modules').delete().eq('id', req.params.mid).eq('listing_id', l.id).then(...quiet('course_modules.delete'));
      return back(res, to, 'Module deleted, with its lessons.');
    }
    if (req.body.action === 'up' || req.body.action === 'down') {
      const j = req.body.action === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < mods.length) {
        [mods[i], mods[j]] = [mods[j], mods[i]];
        await Promise.all(mods.map((m, k) => req.sb.from('course_modules').update({ position: k }).eq('id', m.id).eq('listing_id', l.id)));
      }
      return res.redirect(to);
    }
    const title = mk.str(req.body.title, 120);
    if (title) await req.sb.from('course_modules').update({ title }).eq('id', req.params.mid).eq('listing_id', l.id).then(...quiet('course_modules.rename'));
    res.redirect(to);
  } catch (e) { next(e); }
});

router.post('/:org/listings/:id/lessons', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l || !UUID.test(req.body.module || '')) return notFound(res);
    const title = mk.str(req.body.title, 160);
    const to = base(o, l) + '/curriculum';
    if (!title) return back(res, to, 'Name the lesson.', true);
    const { count } = await req.sb.from('course_lessons').select('id', { count: 'exact', head: true }).eq('module_id', req.body.module);
    const { data, error } = await req.sb.from('course_lessons').insert({ listing_id: l.id, module_id: req.body.module, title, position: count || 0 }).select('id').maybeSingle();
    if (error || !data) return back(res, to, 'Could not add the lesson.', true);
    res.redirect(base(o, l) + '/lessons/' + data.id);
  } catch (e) { next(e); }
});

router.get('/:org/listings/:id/lessons/:lid', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l || !UUID.test(req.params.lid)) return notFound(res);
    const { data: lesson } = await req.sb.from('course_lessons').select('*').eq('id', req.params.lid).eq('listing_id', l.id).maybeSingle();
    if (!lesson) return notFound(res);
    res.render('orgs/lesson_edit', { title: 'Edit lesson — ' + lesson.title, mk, org: o.org, l, lesson, tools: TOOLS, embed: mk.embedOf(lesson.video_url), msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/:org/listings/:id/lessons/:lid', async (req, res, next) => {
  try {
    const o = await orgOf(req);
    if (!o) return notFound(res);
    const l = await listingOf(req, o);
    if (!l || !UUID.test(req.params.lid)) return notFound(res);
    const to = base(o, l) + '/lessons/' + req.params.lid;
    const cur = base(o, l) + '/curriculum';
    if (req.body.action === 'delete') {
      await req.sb.from('course_lessons').delete().eq('id', req.params.lid).eq('listing_id', l.id).then(...quiet('course_lessons.delete'));
      return back(res, cur, 'Lesson deleted.');
    }
    if (req.body.action === 'up' || req.body.action === 'down') {
      const mods = await curriculum(req, l);
      const m = mods.find(x => x.lessons.some(y => y.id === req.params.lid));
      if (m) {
        const list = m.lessons.slice(), i = list.findIndex(y => y.id === req.params.lid), j = req.body.action === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < list.length) {
          [list[i], list[j]] = [list[j], list[i]];
          await Promise.all(list.map((x, k) => req.sb.from('course_lessons').update({ position: k }).eq('id', x.id).eq('listing_id', l.id)));
        }
      }
      return res.redirect(cur);
    }
    const { row, error: bad } = mk.cleanLesson(req.body, TOOL_KEYS);
    if (bad) return back(res, to, bad, true);
    const { error } = await req.sb.from('course_lessons').update(row).eq('id', req.params.lid).eq('listing_id', l.id);
    if (req.get('X-Autosave') === '1') return res.status(error ? 500 : 204).end();
    back(res, to, error ? 'Could not save. Please try again.' : 'Saved.', !!error);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.TOOLS = TOOLS;
