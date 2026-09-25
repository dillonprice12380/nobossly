// Elective challenge matching — non-AI.
//
// Electives are matched from the tailored_challenges pool by path, subpath and
// business tags already on the profile. There used to be an AI top-up here
// (and an AI business-classification step before it) that wrote fresh
// electives into the pool when it ran thin. Both are gone along with the rest
// of the AI in the product; this file is left with just the deterministic
// matching, which needs no model and costs nothing to run.

const matches = (arr, val) => !arr || !arr.length || (val && arr.includes(val));
const specificity = (c, p) => ['business_types', 'industries', 'customer_segments', 'value_props']
  .reduce((s, dim, i) => s + ((c[dim] || []).length && (c[dim] || []).includes([p.biz_type, p.biz_industry, p.biz_segment, p.biz_value_prop][i]) ? 1 : 0), 0);

// Electives for this founder: pool matches by path/subpath, tags and level.
async function getElectives(sb, profile, level) {
  // A declared path is what makes a quest land: "rewrite one page and measure
  // what it does" is for a copywriter, not for every freelancer alive.
  const path = profile.path || null;
  const subpath = profile.subpath || null;
  if (!profile.biz_type && !path) return { electives: [], unclassified: true };

  const { data: taken } = await sb.from('user_custom_challenges').select('tailored_id').eq('user_id', profile.id).not('tailored_id', 'is', null);
  const takenSet = new Set((taken || []).map(t => t.tailored_id));

  const { data: pool } = await sb.from('tailored_challenges').select('*')
    .eq('is_active', true).lte('min_level', level).gte('max_level', level).limit(500);

  // A challenge tagged with paths is only for those paths. An untagged one is
  // general and still matched on classification tags.
  const onPath = c => !c.paths || !c.paths.length || (path && c.paths.includes(path));
  // A subpath-tagged quest is ONLY for those subpaths. Untagged means it suits
  // the whole path.
  const onSubpath = c => !c.subpaths || !c.subpaths.length || (subpath && c.subpaths.includes(subpath));
  let list = (pool || []).filter(c => !takenSet.has(c.id)
    && onPath(c)
    && onSubpath(c)
    && matches(c.business_types, profile.biz_type)
    && matches(c.industries, profile.biz_industry)
    && matches(c.customer_segments, profile.biz_segment)
    && matches(c.value_props, profile.biz_value_prop));
  // Path-tagged first: written for exactly this kind of business, and chosen by
  // the founder rather than guessed at.
  const onPathScore = c => (c.paths && c.paths.length && path && c.paths.includes(path)) ? 1 : 0;
  const onSubpathScore = c => (c.subpaths && c.subpaths.length && subpath && c.subpaths.includes(subpath)) ? 1 : 0;
  list.sort((a, b) => onSubpathScore(b) - onSubpathScore(a)
    || onPathScore(b) - onPathScore(a)
    || specificity(b, profile) - specificity(a, profile)
    || (a.xp_reward - b.xp_reward));

  return { electives: list.slice(0, 6), unclassified: false };
}

module.exports = { getElectives };
