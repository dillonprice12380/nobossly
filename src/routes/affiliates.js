const router = require('express').Router();
const { anonClient } = require('../supabase');
const affiliates = require('../affiliates');

// Outbound affiliate link. affiliate_go() logs the click and returns the
// partner URL, or null for a slot with no live link — which lands on the
// toolkit instead of a dead end.
router.get('/go/:key', async (req, res, next) => {
  try {
    const key = String(req.params.key || '').toLowerCase();
    if (!/^[a-z0-9_]{2,60}$/.test(key)) return res.redirect('/toolkit');
    const from = typeof req.query.from === 'string' ? req.query.from.slice(0, 200) : null;
    const { data: url, error } = await (req.sb || anonClient()).rpc('affiliate_go', { p_key: key, p_source: from });
    if (error) console.error('[db] affiliate_go failed:', error.message);
    if (!url || !/^https:\/\//i.test(url)) return res.redirect('/toolkit');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.redirect(302, url);
  } catch (e) { next(e); }
});

// Every live recommendation in one place.
router.get('/toolkit', (req, res) => {
  res.render('toolkit', {
    title: 'Founder toolkit',
    metaDescription: 'The tools NoBossly members use to register, get paid, sell online and grow — picked for each step of the climb.',
    groups: affiliates.grouped()
  });
});

router.get('/affiliate-disclosure', (req, res) => {
  res.render('affiliate_disclosure', {
    title: 'How recommendations work',
    metaDescription: 'How NoBossly recommends tools and earns affiliate commissions while staying free.'
  });
});

module.exports = router;
