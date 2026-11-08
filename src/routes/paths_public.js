const router = require('express').Router();
const paths = require('../paths');
const dashboards = require('../path_dashboards');

// Public landing pages, one per path.

const canonical = (req, p) => 'https://nobossly.com/paths/' + p;

router.get('/', (req, res) => {
  res.render('paths_index', {
    title: 'Pick your path',
    metaDescription: 'NoBossly sets up a different dashboard depending on what you are building: a channel, a client base, a shop, a product. Pick your path and see what it tracks.',
    canonicalUrl: 'https://nobossly.com/paths',
    paths: paths.MARKETED
  });
});

router.get('/:slug', async (req, res, next) => {
  try {
    const def = paths.get(req.params.slug);
    // A path with no marketing block is live in the product but not on the
    // public site, so it must not resolve to a half-empty page.
    if (!def || !def.marketing) return res.redirect('/paths');

    res.render('path_landing', {
      title: def.label + ' — your path',
      metaDescription: def.marketing.subhead.slice(0, 300),
      canonicalUrl: canonical(req, def.slug),
      def,
      // What this path's dashboard is made of, from the same config members get.
      dash: dashboards.previewFor(def.slug),
      subpaths: paths.subpathsOf(def.slug),
      others: paths.MARKETED.filter(p => p.slug !== def.slug)
    });
  } catch (e) { next(e); }
});

module.exports = router;
