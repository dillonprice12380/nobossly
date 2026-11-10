const router = require('express').Router();
const paths = require('../paths');
const pages = require('../path_pages');

// Public pages: the /paths comparison and one landing page per path
// (src/path_pages.js builds what each renders with).

function clientFor(req) {
  if (req.sb) return req.sb;
  try { return require('../supabase').anonClient(); } catch (_) { return null; }
}

router.get('/', (req, res) => res.render('paths_index', pages.indexLocals()));

router.get('/:slug', async (req, res, next) => {
  try {
    const def = paths.get(req.params.slug);
    // A path with no marketing block is live in the product but not on the
    // public site, so it must not resolve to a half-empty page.
    if (!def || !def.marketing) return res.redirect('/paths');
    const sb = clientFor(req);
    res.render('path_landing', pages.landingLocals(def, sb ? await pages.community(sb, def.slug) : null));
  } catch (e) { next(e); }
});

module.exports = router;
