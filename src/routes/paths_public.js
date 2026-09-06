const router = require('express').Router();
const paths = require('../paths');
const lib = require('../fit_library');

// Public landing pages, one per path.
//
// The fit criteria and the challenges on these pages are pulled LIVE from the
// same tables the product uses, filtered by the same path tag. Retyping them
// into marketing copy would guarantee the page and the product drift apart
// within a month; this way a criterion edited in the library changes the
// landing page too.
//
// Both tables are readable with the publishable key: fit_criteria_library is
// catalog content, and tailored_challenges exposes only its curated rows to
// anon (AI-written ones have not been read by a human).

const canonical = (req, p) => 'https://nobossly.com/paths/' + p;

// The criteria this path would be tested against. Path-tagged first — those are
// the ones that make the page feel written for the reader — then the universal
// ones that fill out a real five-point test.
// Library wording carries placeholders — "{budget}", "{hours}", "{traction}" —
// which are filled from a member's own answers when the criterion is pinned.
// A visitor has no answers, so the page has to bind them to the generic phrase
// instead. Printing the row unbound put a literal "{budget}" on the page.
//
// The one exception is the audience bar, which is a real constant rather than a
// personal number: on the creator page it should read as the actual figure.
function visitorFacts(slug) {
  if (slug !== 'creator') return {};
  const spec = paths.CREATOR_AUDIENCE[paths.SOCIAL_CREATOR_TYPES[0]];
  return { audience_target: spec.target, audience_metric: spec.metric };
}

async function criteriaFor(sb, slug) {
  const { data } = await sb.from('fit_criteria_library')
    .select('slug, criterion, why, check_kind, paths, priority')
    .eq('is_active', true).order('priority', { ascending: false }).limit(200);
  const rows = data || [];
  const tagged = rows.filter(r => (r.paths || []).includes(slug));
  const general = rows.filter(r => !r.paths || !r.paths.length);
  // Bind and drop the unusable BEFORE slicing, or dropping one leaves a page
  // with four criteria where the copy promises five.
  return bindForVisitor(tagged.concat(general), slug).slice(0, 5);
}

// Exported so the view tests can hold the real library rows to the same rule
// the page does: nothing a visitor reads may still contain a placeholder.
function bindForVisitor(rows, slug) {
  const facts = visitorFacts(slug);
  return (rows || [])
    .map(r => ({ ...r, criterion: lib.bind(r.criterion, facts), why: lib.bind(r.why, facts) }))
    // A criterion whose wording only makes sense with a member's own numbers —
    // the money bar reads "the number this path turns on" to a stranger — is
    // dropped rather than shown vague. The page states that bar in its own
    // words instead, in the marketing block.
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
    // A path with no marketing block is live in the product but not on the
    // public site, so it must not resolve to a half-empty page.
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
      // The founder sees the actual questions their path asks, not a summary of
      // them — it is the most convincing thing on the page and it costs nothing
      // to keep true.
      questions: paths.ownQuestions(def.slug),
      criteria,
      challenges,
      others: paths.MARKETED.filter(p => p.slug !== def.slug)
    });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.bindForVisitor = bindForVisitor;
module.exports.visitorFacts = visitorFacts;
