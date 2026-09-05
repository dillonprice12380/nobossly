// Tests for the eight business paths (src/paths.js).
//
// Questions are data now, so the failures worth catching are structural: a
// question that renders nothing, a path that cannot be completed, an answer
// that writes to the wrong place, or a universal constraint quietly dropped
// from a path — which would silently break the fit test for everyone on it.
//
//   node test/paths.js

const paths = require('../src/paths');
const { partition, readAnswer, readinessScore } = require('../src/routes/questionnaire');
const { founderFacts } = require('../src/fit_library');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const TYPES = ['text', 'textarea', 'select', 'checks', 'csv', 'url'];

console.log('\nNine paths, each answerable:');
eq('nine of them', paths.PATHS.length, 9);
ok('slugs are unique', new Set(paths.SLUGS).size === 9, paths.SLUGS.join(', '));
for (const p of paths.PATHS) {
  const all = paths.coreQuestions(p.slug).concat(paths.depthQuestions(p.slug));
  const names = all.map(q => q.name);
  ok(`  ${p.slug}: no duplicate question names`, new Set(names).size === names.length,
     names.filter((n, i) => names.indexOf(n) !== i).join(', ') || 'clean');
  ok(`  ${p.slug}: every question has a label and a known type`,
     all.every(q => q.label && TYPES.includes(q.type)),
     all.filter(q => !q.label || !TYPES.includes(q.type)).map(q => q.name).join(', ') || 'clean');
  ok(`  ${p.slug}: every select and checks has options`,
     all.filter(q => q.type === 'select' || q.type === 'checks').every(q => Array.isArray(q.options) && q.options.length));
  ok(`  ${p.slug}: has a label, emoji and blurb`, !!(p.label && p.emoji && p.blurb));
}

console.log('\nMaking a product and running a shop ask different things:');
{
  const pp = paths.coreQuestions('physical_product').concat(paths.depthQuestions('physical_product')).map(q => q.name);
  const os = paths.coreQuestions('online_store').concat(paths.depthQuestions('online_store')).map(q => q.name);
  const shared = pp.filter(n => os.includes(n));
  const universal = paths.UNIVERSAL_CORE.concat(paths.UNIVERSAL_DEPTH).map(q => q.name).concat(['stage', 'product']);
  const overlap = shared.filter(n => !universal.includes(n));
  ok('they share only the universal questions', overlap.length === 0, overlap.join(', ') || 'no unexpected overlap');
  ok('only the maker is asked about tooling and minimum orders',
     pp.includes('tooling_cost') && pp.includes('moq') && !os.includes('tooling_cost'));
  ok('only the shop is asked about fulfilment and channel',
     os.includes('fulfilment') && os.includes('channel') && !pp.includes('fulfilment'));
}

console.log('\nEvery path asks the universal constraints, because the fit test needs them:');
{
  // If a path ever loses one of these, the fit-criteria library stops matching
  // for everyone on it — and nothing would throw.
  const REQUIRED_COLS = ['founder_name', 'hours_per_week', 'launch_budget', 'runway', 'income_year1', 'deal_breakers'];
  for (const p of paths.PATHS) {
    const cols = paths.coreQuestions(p.slug).map(q => q.col).filter(Boolean);
    const missing = REQUIRED_COLS.filter(c => !cols.includes(c));
    ok(`  ${p.slug}`, missing.length === 0, missing.join(', ') || 'all present');
  }
}

console.log('\nEvery path asks where the founder is with it:');
for (const p of paths.PATHS) {
  const stage = paths.coreQuestions(p.slug).find(q => q.name === 'stage');
  ok(`  ${p.slug} has a stage question`, !!stage && Array.isArray(stage.options) && stage.options.length >= 4,
     stage ? stage.options.length + ' options' : 'MISSING');
}

console.log('\nStage reads across every path\'s own wording:');
{
  // Each path phrases its stage options differently, so this maps the shape of
  // the answer rather than matching strings.
  const cases = [
    ['This is my main income', 'running'], ['Turning work away', 'running'],
    ['Open and trading', 'running'], ['Selling regularly', 'running'],
    ['Earning something', 'earning'], ['A few sales', 'earning'],
    ['Posting occasionally', 'started'], ['Building it', 'started'], ['Lease signed', 'started'],
    ['Just an idea', 'idea'], ['Not started', 'idea'], ['Just curious', 'idea']
  ];
  for (const [answer, want] of cases) {
    eq(`  "${answer}"`, paths.stageOf({ path_answers: { stage: answer } }), want);
  }
  eq('  no answer at all', paths.stageOf({}), 'unknown');
}

console.log('\nAnswers land in the right place:');
{
  const body = {
    founder_name: 'Dillon', hours_per_week: '10-20', launch_budget: 'Under $500',
    runway: 'None — need income now', income_year1: 'Replace full salary',
    deal_breakers: 'video content, cold calling',
    stage: 'Posting occasionally', platform: 'YouTube', niche: 'van builds',
    audience_size: 'Under 1,000', monetization: ['Sponsorships', 'Affiliate']
  };
  const { cols, pathAnswers } = partition(paths.coreQuestions('creator'), body, {});
  // Universal constraints must reach their OWN columns — the fit library reads
  // those, not path_answers.
  eq('  budget goes to its column', cols.launch_budget, 'Under $500');
  ok('  deal breakers parse to an array', Array.isArray(cols.deal_breakers) && cols.deal_breakers.length === 2,
     JSON.stringify(cols.deal_breakers));
  // Path-specific answers must NOT invent columns.
  eq('  platform goes to path_answers', pathAnswers.platform, 'YouTube');
  ok('  platform did not become a column', cols.platform === undefined);
  ok('  a checkbox group survives as an array', Array.isArray(pathAnswers.monetization) && pathAnswers.monetization.length === 2);

  // Editing one depth step must not wipe answers given on another.
  const later = partition(paths.depthSteps('creator')[0] || [], { cadence: 'Weekly' }, pathAnswers);
  eq('  an earlier answer survives a later step', later.pathAnswers.platform, 'YouTube');
  eq('  and the new one is added', later.pathAnswers.cadence, 'Weekly');
}

console.log('\nInput is cleaned before it is stored:');
{
  eq('a url that is not a url is dropped', readAnswer({ name: 'u', type: 'url' }, { u: 'javascript:alert(1)' }), '');
  eq('a real url survives', readAnswer({ name: 'u', type: 'url' }, { u: 'https://example.com' }), 'https://example.com');
  ok('csv trims and drops blanks',
     JSON.stringify(readAnswer({ name: 'd', type: 'csv' }, { d: ' a , , b ,' })) === JSON.stringify(['a', 'b']));
  ok('a single checkbox still becomes an array',
     Array.isArray(readAnswer({ name: 'm', type: 'checks' }, { m: 'Sponsorships' })));
  eq('a scale answer becomes a number', readAnswer({ name: 'tech_level', type: 'select' }, { tech_level: '3' }), 3);
  eq('a junk scale answer becomes null', readAnswer({ name: 'tech_level', type: 'select' }, { tech_level: 'x' }), null);
}

console.log('\nThe fit library reads what the questionnaire wrote:');
{
  // The join that matters: answers -> columns -> derived facts -> criteria.
  const run = {
    founder_path: 'local_service', launch_budget: '$500-2,000', hours_per_week: '20-40',
    runway: 'None — need income now', income_year1: 'Replace full salary',
    deal_breakers: ['cold calling'], path_answers: { stage: 'Booked out' }
  };
  const f = founderFacts(run);
  eq('  path is a matchable fact', f.path, 'local_service');
  eq('  stage is separate from path', f.stage, 'running');
  ok('  and is_running follows from it', f.is_running === true);
  eq('  budget converts to a number', f.launch_budget_usd, 2000);
  eq('  no runway sets an 8-week revenue deadline', f.revenue_deadline_weeks, 8);
  ok('  a named deal breaker is picked up', f.avoids_cold_outreach === true);
}

console.log('\nReadiness reflects how much of the path was answered:');
{
  const empty = readinessScore('creator', { path_answers: {} });
  const some = readinessScore('creator', {
    founder_name: 'D', hours_per_week: '10-20', launch_budget: '$0', runway: '1-3 months',
    income_year1: 'Side income ($500+/mo)', deal_breakers: ['x'],
    path_answers: { stage: 'Posting occasionally', platform: 'YouTube', niche: 'vans', audience_size: 'None yet' }
  });
  ok('an empty run scores 0', empty === 0, String(empty));
  ok('a completed core scores well under 100 — depth is still unanswered', some > 30 && some < 90, String(some));
}

console.log('\nEvery marketed path can carry a landing page:');
{
  ok('eight paths are marketed', paths.MARKETED.length === 8, String(paths.MARKETED.length));
  ok('physical product is live in the app but off the public site',
     paths.isPath('physical_product') && !paths.MARKETED.some(p => p.slug === 'physical_product'));

  for (const p of paths.MARKETED) {
    const mk = p.marketing;
    ok(`  ${p.slug}: has a headline, subhead and three pains`,
       !!(mk && mk.headline && mk.subhead && Array.isArray(mk.pains) && mk.pains.length === 3),
       mk ? (mk.pains || []).length + ' pains' : 'MISSING');
    // Generic marketing copy is worse than none — it is the thing that makes a
    // path page feel like a template. A headline that never names the path's
    // own vocabulary is the tell.
    ok(`  ${p.slug}: the truth line says something specific`,
       !!(mk && mk.truth && mk.truth.length > 60), mk && mk.truth ? mk.truth.length + ' chars' : 'MISSING');
    // The landing page shows the path's own questions; a path whose questions
    // are all universal would render an empty section.
    const own = paths.ownQuestions(p.slug);
    ok(`  ${p.slug}: has questions of its own to show`, own.length >= 4, String(own.length));
  }

  // Two paths must not share a headline — that would mean the copy was written
  // once and pasted.
  const heads = paths.MARKETED.map(p => p.marketing.headline);
  ok('no two paths share a headline', new Set(heads).size === heads.length);
}

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nPaths hold. All checks pass.');
process.exit(fail ? 1 : 0);
