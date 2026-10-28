const router = require('express').Router();

// /privacy and /terms used to be two short CMS rows served by the /:slug
// catch-all. They are now real views so the text is reviewed, versioned and
// tested with the code that actually collects the data. This router is mounted
// before the CMS catch-all, so it wins over the old rows.
//
// Change LAST_UPDATED whenever the text materially changes. Set LEGAL_ENTITY on
// the host (e.g. "NoBossly, LLC") once the registered name is confirmed; until
// then the pages simply say "NoBossly".
const LAST_UPDATED = 'October 28, 2026';
const OPERATOR = process.env.LEGAL_ENTITY || 'NoBossly';
const CONTACT = 'support@nobossly.com';

const base = { operator: OPERATOR, contact: CONTACT, updated: LAST_UPDATED };

router.get('/privacy', (req, res) => {
  res.render('privacy', {
    ...base,
    title: 'Privacy Policy',
    metaDescription: 'What NoBossly collects, why, who sees it, how long we keep it, and the choices you have.'
  });
});

router.get('/terms', (req, res) => {
  res.render('terms', {
    ...base,
    title: 'Terms & Conditions',
    metaDescription: 'The rules for using NoBossly: your account, the community, Premium, and what we can and cannot promise.'
  });
});

// Old or guessed addresses people link to.
router.get(['/privacy-policy', '/privacy-policy/'], (req, res) => res.redirect(301, '/privacy'));
router.get(['/terms-and-conditions', '/terms-of-service', '/tos'], (req, res) => res.redirect(301, '/terms'));

module.exports = router;
