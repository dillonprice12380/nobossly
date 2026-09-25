const router = require('express').Router();
const paths = require('../paths');
const ladders = require('../ladders');

// Public landing pages, one per path.
//
// The fit criteria and the challenges on these pages are pulled LIVE from the
// same tables the product uses, filtered by the same path tag.
//
// fit_criteria_library is catalog content, readable with the publishable key.

const canonical = (req, p) => 'https://nobossly.com/paths/' + p;

// Library wording carries placeholders — "{budget}", "{hours}", "{traction}"
// — which used to be filled from a member's own answers when a criterion was
// pinned to their idea. A visitor has no answers, so the page binds them to a
// generic phrase instead; anything still holding an unbound placeholder after
// that gets dropped rather than shown broken.
function bind(str, facts) {
  return String(str || '').replace(/\{([a-z_]+)\}/g, (m, key) => (facts && facts[key] != null) ? String(facts[key]) : m);
}

// The one exception is the audience bar, which is a real constant rather than a
// personal number: on the creator page it should read as the actual figure.
function visitorFacts(slug) {
  if (slug !== 'creator') return {};
  const spec = paths.CREATOR_AUDIENCE.social;
  return { audience_target: spec.target, audience_metric: spec.metric };
}

async function criteriaFor(sb, slug) {
  const { data } = await sb.from('fit_criteria_library')
    .select('slug, criterion, why, check_kind, paths, priority')
    .eq('is_active', true).order('priority', { ascending: false }).limit(200);
  const rows = data || [];
  const tagged = rows.filter(r => (r.paths || []).includes(slug));
  const general = rows.filter(r => !r.paths || !r.paths.length);
  return bindForVisitor(tagged.concat(general), slug).slice(0, 5);
}

// Exported so the view tests can hold the real library rows to the same rule
// the page does: nothing a visitor reads may still contain a placeholder.
function bindForVisitor(rows, slug) {
  const facts = visitorFacts(slug);
  return (rows || [])
    .map(r => ({ ...r, criterion: bind(r.criterion, facts), why: bind(r.why, facts) }))
    .filter(r => !/\{[a-z_]+\}/.test(r.criterion + r.why) && !/the number this path turns on/i.test(r.criterion));
}

async function challengesFor(sb, slug) {
  const { data } = await sb.from('tailored_challenges')
    .select('title, description, emoji, xp_reward, suggested_days, paths')
    .eq('is_active', true).eq('source', 'curated').limit(200);
  return (data || []).filter(c => (c.paths || []).includes(slug)).slice(0, 5);
}

router.get('/', (req, res) => {
  res.render('paths_index', {
    title: 'Pick your path',
    metaDescription: 'NoBossly asks different questions depending on what you are building — a channel, a client base, a shop, a product. Eight paths, each with its own fit test and its own quests.',
    canonicalUrl: 'https://nobossly.com/paths',
    paths: paths.MARKETED
  });
});

router.get('/:slug', async (req, res, next) => {
  try {
    const def = paths.get(req.params.slug);
    if (!def || !def.marketing) return res.redirect('/paths');

    const [criteria, challenges] = await Promise.all([
      criteriaFor(req.sb, def.slug).catch(() => []),
      challengesFor(req.sb, def.slug).catch(() => [])
    ]);

    res.render('path_landing', {
      title: def.label + ' — your path',
      metaDescription: def.marketing.subhead.slice(0, 300),
      canonicalUrl: canonical(req, def.slug),
      def,
      questions: paths.ownQuestions(def.slug),
      rungs: ladders.ladderFor(def.slug),
      subpaths: paths.subpathsOf(def.slug),
      criteria,
      challenges,
      others: paths.MARKETED.filter(p => p.slug !== def.slug)
    });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.bindForVisitor = bindForVisitor;
module.exports.visitorFacts = visitorFacts;
