// The provider side's front door: what NoBossly offers people who run
// accelerator programs or teach courses, and the application to become one.
// A NoBossly admin approves each application (/admin/providers), which creates
// the provider's organization; from then on they manage everything at /orgs.
const router = require('express').Router();
const mk = require('../marketplace');

const enc = encodeURIComponent;
const noFn = err => !!err && (err.code === 'PGRST202' || err.code === '42883' || err.code === '42P01' || err.code === 'PGRST205'
  || /Could not find the function|does not exist/i.test(err.message || ''));
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// What the signed-in member already has: their applications, and any
// organization they are on the team of.
async function standing(req) {
  if (!req.user) return { apps: [], orgs: [], notReady: false };
  const [{ data: apps, error }, { data: roles }] = await Promise.all([
    req.sb.from('provider_applications').select('id, org_name, status, admin_note, created_at, org_id').eq('user_id', req.user.id).order('created_at', { ascending: false }),
    req.sb.from('org_admins').select('org_id, role').eq('user_id', req.user.id)
  ]);
  let orgs = [];
  if ((roles || []).length) ({ data: orgs } = await req.sb.from('organizations').select('id, name, slug, provider').in('id', roles.map(r => r.org_id)));
  return { apps: apps || [], orgs: orgs || [], notReady: noFn(error) };
}

router.get('/', async (req, res, next) => {
  try {
    const s = await standing(req);
    res.render('providers/landing', {
      title: 'Run a program or teach a course', mk, ...s, canonicalUrl: 'https://nobossly.com/providers',
      metaDescription: 'List your accelerator program or course on NoBossly. Reach people building a business around a job, take applications, run a private cohort and host your lessons — free.'
    });
  } catch (e) { next(e); }
});

router.get('/apply', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/login?next=/providers/apply');
    const s = await standing(req);
    res.render('providers/apply', { title: 'Apply to be a provider', mk, ...s, form: {}, msg: req.query.msg || null });
  } catch (e) { next(e); }
});

router.post('/apply', async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/login?next=/providers/apply');
    const b = req.body;
    const form = {
      org_name: mk.str(b.org_name, 120), kind: mk.ORG_KINDS[b.kind] ? b.kind : '',
      offers: (Array.isArray(b.offers) ? b.offers : [b.offers]).filter(o => mk.KINDS[o]),
      website_url: mk.str(b.website_url, 300), contact_email: mk.str(b.contact_email, 254).toLowerCase(), about: mk.str(b.about, 2000)
    };
    const fail = async m => res.status(400).render('providers/apply', { title: 'Apply to be a provider', mk, ...(await standing(req)), form, msg: null, err: m });
    if (form.org_name.length < 2) return fail('Enter your organization\'s name (or your own, if you teach on your own).');
    if (!form.kind) return fail('Choose what kind of provider you are.');
    if (!form.offers.length) return fail('Choose whether you run programs, courses, or both.');
    if (form.website_url && !mk.url(form.website_url)) return fail('The website must start with http:// or https://.');
    if (form.contact_email && !EMAIL.test(form.contact_email)) return fail('Enter a valid contact email, or leave it blank.');
    if (form.about.length < 20) return fail('Tell us a little more about what you run (at least 20 characters).');
    const { data, error } = await req.sb.rpc('provider_apply', {
      p_org_name: form.org_name, p_kind: form.kind, p_offers: form.offers, p_website: form.website_url || null,
      p_email: form.contact_email || null, p_about: form.about
    });
    if (noFn(error)) return fail('Provider applications open shortly — this part is being set up.');
    if (error) return fail('Could not send the application. Please try again.');
    if (!data) return res.redirect('/providers/apply?msg=' + enc('You already have an application waiting, or you already run a provider organization.'));
    res.redirect('/providers/apply?msg=' + enc('Application sent. We review every provider by hand and will notify you here.'));
  } catch (e) { next(e); }
});

// Where a notification about a provider application leads.
router.get('/application/:id', (req, res) => {
  if (!req.user) return res.redirect('/login?next=/providers/apply');
  res.redirect(req.profile && req.profile.is_admin ? '/admin/providers' : '/providers/apply');
});

module.exports = router;
