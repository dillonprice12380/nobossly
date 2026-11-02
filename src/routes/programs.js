// The marketplace, member side: browse programs and courses, open one, apply
// or enroll, and see what you have joined. Browsing and listing pages are
// public (no account needed); joining needs one. Every rule about who may see
// or join what is in the database (migrations/2026-11-03_marketplace.sql).
const router = require('express').Router();
const { anonClient } = require('../supabase');
const mk = require('../marketplace');
const richtext = require('../workspace/richtext');

const enc = encodeURIComponent;
const sbOf = req => req.sb || anonClient();
const noFn = err => !!err && (err.code === 'PGRST202' || err.code === '42883' || err.code === '42P01' || err.code === 'PGRST205'
  || /Could not find the function|does not exist/i.test(err.message || ''));
const signIn = (req, res) => res.redirect('/login?next=' + enc(req.originalUrl.replace(/\/(join|withdraw)$/, '')));

const JOIN_MSG = {
  applied: 'Application sent. The team will review it, and you will get a notification when they decide.',
  enrolled: 'You\'re in.',
  closed: 'Applications for this have closed.',
  full: 'This is full.',
  declined: 'Your earlier application was not accepted, so you cannot apply again here. Contact the provider if things have changed.',
  removed: 'The team removed you from this. Contact the provider if you think that is a mistake.',
  own: 'This is your own organization\'s listing.',
  invalid: 'This is not open right now.'
};

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await sbOf(req).rpc('marketplace_listings');
    const { shown, chosen } = mk.filter(data || [], req.query);
    const myPath = req.profile && req.profile.path && mk.PATH_LABEL[req.profile.path] ? req.profile.path : null;
    res.render('programs/index', {
      title: 'Programs & courses', mk, items: shown, total: (data || []).length, chosen, myPath,
      notReady: noFn(error), canonicalUrl: 'https://nobossly.com/programs',
      metaDescription: 'Accelerator programs and courses for people building a business around a job: free and paid, online and in person, from approved providers.'
    });
  } catch (e) { next(e); }
});

// What you have applied to or joined.
router.get('/mine', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/login?next=/programs/mine');
    const { data, error } = await req.sb.rpc('my_listings');
    res.render('programs/mine', { title: 'My programs & courses', mk, items: data || [], notReady: noFn(error), msg: req.query.msg || null });
  } catch (e) { next(e); }
});

// Where a notification about an application or enrollment leads: the member
// to the listing, the provider's team to its applicants.
router.get('/enrollment/:id', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/login?next=' + enc(req.originalUrl));
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.redirect('/programs/mine');
    const { data: e } = await req.sb.from('listing_enrollments').select('user_id, listing_id').eq('id', req.params.id).maybeSingle();
    if (!e) return res.redirect('/programs/mine');
    const { data: l } = await req.sb.from('listings').select('id, slug, org_id').eq('id', e.listing_id).maybeSingle();
    if (!l) return res.redirect('/programs/mine');
    if (e.user_id === req.user.id) return res.redirect('/programs/' + l.slug);
    const { data: o } = await req.sb.from('organizations').select('slug').eq('id', l.org_id).maybeSingle();
    res.redirect(o ? '/orgs/' + o.slug + '/listings/' + l.id + '/people' : '/programs/' + l.slug);
  } catch (e) { next(e); }
});

async function page(req) {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(req.params.slug)) return null;
  const { data, error } = await sbOf(req).rpc('listing_page', { p_slug: req.params.slug });
  return error ? null : data;
}

router.get('/:slug', async (req, res, next) => {
  try {
    const l = await page(req);
    if (!l) return res.status(404).render('error', { title: 'Not found', message: 'That program or course is not listed.' });
    res.render('programs/show', {
      title: l.title + ' — ' + l.org.name, mk, l, msg: req.query.msg || null,
      desc: richtext.clean(l.description, mk.LIMITS.description), signedIn: !!req.user,
      canonicalUrl: 'https://nobossly.com/programs/' + l.slug, metaDescription: l.summary
    });
  } catch (e) { next(e); }
});

router.post('/:slug/join', async (req, res, next) => {
  try {
    if (!req.user) return signIn(req, res);
    const l = await page(req);
    if (!l) return res.redirect('/programs');
    const to = '/programs/' + l.slug;
    const answers = (Array.isArray(req.body.answers) ? req.body.answers : [req.body.answers]).map(a => mk.str(a, 2000));
    const questions = Array.isArray(l.questions) ? l.questions : [];
    if (l.join_mode === 'apply' && questions.some((q, i) => !answers[i])) {
      return res.redirect(to + '?err=' + enc('Answer each question to apply.') + '#join');
    }
    const { data: status, error } = await req.sb.rpc('listing_join', { p_listing: l.id, p_answers: answers.slice(0, 5) });
    if (error) return res.redirect(to + '?err=' + enc(noFn(error) ? 'Programs are being set up — try again shortly.' : 'Could not do that. Please try again.'));
    if (status === 'enrolled' && l.kind === 'course') return res.redirect('/learn/' + l.slug + '?msg=' + enc(JOIN_MSG.enrolled));
    const msg = JOIN_MSG[status] || JOIN_MSG.invalid;
    res.redirect(to + (['applied', 'enrolled'].includes(status) ? '?msg=' : '?err=') + enc(msg));
  } catch (e) { next(e); }
});

router.post('/:slug/withdraw', async (req, res, next) => {
  try {
    if (!req.user) return signIn(req, res);
    const l = await page(req);
    if (!l) return res.redirect('/programs/mine');
    await req.sb.rpc('listing_withdraw', { p_listing: l.id });
    res.redirect('/programs/mine?msg=' + enc('Withdrawn from ' + l.title + '.'));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.JOIN_MSG = JOIN_MSG;
