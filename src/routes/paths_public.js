const router = require('express').Router();
const paths = require('../paths');
const ladders = require('../ladders');

// Public landing pages, one per path.
//
// The quests on these pages are pulled LIVE from the same table the product
// uses, filtered by the same path tag, so a curated row edited in the pool
// changes the landing page too.

const canonical = (req, p) => 'https://nobossly.com/paths/' + p;

async function challengesFor(sb, slug) {
  const { data } = await sb.from('tailored_challenges')
    .select('title, description, emoji, xp_reward, suggested_days, paths')
    .eq('is_active', true).eq('source', 'curated').limit(200);
  return (data || []).filter(c => (c.paths || []).includes(slug)).slice(0, 5);
}

router.get('/', (req, res) => {
  res.render('paths_index', {
    title: 'Pick your path',
    metaDescription: 'NoBossly asks different questions depending on what you are building — a channel, a client base, a shop, a product. Nine paths, each with its own quest board.',
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

    const challenges = await challengesFor(req.sb, def.slug).catch(() => []);

    res.render('path_landing', {
      title: def.label + ' — your path',
      metaDescription: def.marketing.subhead.slice(0, 300),
      canonicalUrl: canonical(req, def.slug),
      def,
      // The rungs this path actually climbs, named in its own vernacular.
      rungs: ladders.ladderFor(def.slug),
      subpaths: paths.subpathsOf(def.slug),
      challenges,
      others: paths.MARKETED.filter(p => p.slug !== def.slug)
    });
  } catch (e) { next(e); }
});

module.exports = router;
