// Tests for building a founder's fit test from the curated library
// (src/fit_library.js + fit_criteria_library).
//
// The library exists so two founders with the same answers get the same test,
// and so criteria arrive already TYPED — a criterion that carries its own
// threshold can be graded by arithmetic in fit.js instead of by the model's
// opinion. Both properties fail silently if the matching is wrong, so this
// walks real founder profiles end to end.
//
// fit-library-snapshot.json mirrors the live table (anon RLS blocks reading it
// with the publishable key), the same way ladder-config.json mirrors the
// ladder. Verify it after editing the library with:
//
//   select md5(string_agg(slug||'|'||criterion||'|'||check_kind||'|'||coalesce(metric,'')||'|'
//     ||coalesce(op,'')||'|'||coalesce(value_from,'')||'|'||coalesce((value::float8)::text,'')
//     ||'|'||category||'|'||priority::text, E'\n' order by slug))
//   from fit_criteria_library where is_active;
//
// It must equal the fingerprint this test prints.
//
//   node test/fit-library.js

const crypto = require('crypto');
const lib = require('../src/fit_library');
const { gradeFitTest } = require('../src/fit');
const ROWS = require('./fit-library-snapshot.json');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const fingerprint = crypto.createHash('md5').update(
  ROWS.slice().sort((a, b) => a.slug.localeCompare(b.slug)).map(r => [
    r.slug, r.criterion, r.check_kind, r.metric || '', r.op || '', r.value_from || '',
    r.value == null ? '' : String(r.value), r.category, String(r.priority)].join('|')).join('\n')
).digest('hex');

// ---------- profiles ----------
const PROFILES = {
  hygienist: {
    label: 'employed, $500, 10-20h, no runway, no video, credentialed',
    q: { founder_path: 'consultant', work_status: 'Employed full-time', launch_budget: 'Under $500',
         hours_per_week: '10-20', runway: 'None — need income now', income_year1: 'Replace full salary',
         deal_breakers: ['video content', 'inventory'], credentials: 'RDH license',
         industry_field: 'dental', tech_level: 2, sales_comfort: 2 }
  },
  owner: {
    label: 'existing business, $2-10k, 20-40h, 6-12mo runway',
    q: { founder_path: 'local_service', work_status: 'Freelancing', path_answers: { stage: 'Booked out' }, launch_budget: '$2,000-10,000',
         hours_per_week: '20-40', runway: '6-12 months', income_year1: 'Build something big',
         deal_breakers: [], credentials: '', industry_field: 'retail', tech_level: 4, sales_comfort: 4 }
  },
  broke: {
    label: 'no budget, <5h, no runway, nothing else stated',
    q: { founder_path: 'exploring', work_status: 'Between jobs', launch_budget: '$0',
         hours_per_week: '<5', runway: 'None — need income now', income_year1: 'Side income ($500+/mo)',
         deal_breakers: [], credentials: '', industry_field: '', tech_level: 3, sales_comfort: 3 }
  },
  blank: {
    label: 'answered almost nothing',
    q: { founder_path: 'exploring' }
  }
};

console.log('\nLibrary snapshot:');
eq('42 active criteria', ROWS.length, 42);
ok('fingerprint (compare against the query in this file\'s header)', true, fingerprint);
ok('every row has a category, so the diversity rule can work', ROWS.every(r => !!r.category));
ok('every numeric row can resolve a threshold',
   ROWS.filter(r => r.check_kind === 'numeric').every(r => r.value_from || r.value != null));
ok('slugs are unique', new Set(ROWS.map(r => r.slug)).size === ROWS.length);

console.log('\nEach profile gets a full, tailored test:');
for (const key of Object.keys(PROFILES)) {
  const { label, q } = PROFILES[key];
  const facts = lib.founderFacts(q);
  const chosen = lib.selectFromLibrary(ROWS, facts);
  console.log(`\n  ${label}`);
  chosen.forEach(c => console.log(`     ${c.check === 'numeric' ? '#' : c.check === 'boolean' ? 'y/n' : '~'} ${c.criterion}`));
  // A sparse profile legitimately matches fewer rows — the model fills the
  // rest. What must always hold is that library + gap comes to five.
  const filled = lib.mergeFitTest(chosen, [{ criterion: 'gap A' }, { criterion: 'gap B' }, { criterion: 'gap C' }], facts);
  ok('  five criteria after the gap is filled', filled.length === 5, `${chosen.length} from library`);
  ok('  no duplicates', new Set(chosen.map(c => c.criterion)).size === chosen.length);
  ok('  no unbound placeholders left in the wording',
     chosen.every(c => !/\{[a-z_]+\}/.test(c.criterion) && !/\{[a-z_]+\}/.test(c.why)),
     chosen.map(c => c.criterion).find(t => /\{/.test(t)) || 'clean');
  ok('  every criterion is typed', chosen.every(c => ['numeric', 'boolean', 'judgment'].includes(c.check)));
  ok('  numeric criteria all carry a real threshold',
     chosen.filter(c => c.check === 'numeric').every(c => Number.isFinite(c.value)));
}

console.log('\nThe test actually reflects what the founder said:');
{
  const facts = lib.founderFacts(PROFILES.hygienist.q);
  const chosen = lib.selectFromLibrary(ROWS, facts);
  const slugs = chosen.map(c => c.slug);
  ok('a video deal breaker produces the camera criterion', slugs.includes('no_camera'), slugs.join(', '));
  ok('credentials produce the credentials criterion — the reserved edge slot',
     slugs.includes('uses_credentials'), slugs.join(', '));
  ok('and the test is not five constraints with no edge',
     chosen.some(c => (ROWS.find(r => r.slug === c.slug) || {}).category === 'advantage'));
  ok('no runway produces the urgent revenue deadline', slugs.includes('revenue_deadline_urgent'));
  const budget = chosen.find(c => c.metric === 'startup_cost');
  ok('the budget ceiling is bound to THEIR $500', budget && budget.value === 500, budget && String(budget.value));
  ok('and the wording says $500', budget && budget.criterion.includes('$500'), budget && budget.criterion);
  const timing = chosen.find(c => c.metric === 'time_to_revenue');
  ok('the revenue deadline is bound to 8 weeks (no runway)', timing && timing.value === 8, timing && timing.criterion);

  const ownerChosen = lib.selectFromLibrary(ROWS, lib.founderFacts(PROFILES.owner.q));
  const ownerSlugs = ownerChosen.map(c => c.slug);
  ok('an existing business gets the build-on-it criterion', ownerSlugs.includes('builds_on_existing'), ownerSlugs.join(', '));
  ok('and NOT the camera criterion they never asked for', !ownerSlugs.includes('no_camera'));
  // Their budget criterion may not make the top five — path-specific criteria
  // outrank a generic ceiling, which is the point of tagging them. What must
  // hold is that when it IS used, it binds to their number and not someone
  // else's, so this tests the binding directly.
  const budgetRow = ROWS.find(r => r.slug === 'budget_ceiling_soft');
  const ownerBound = lib.toCriterion(budgetRow, lib.founderFacts(PROFILES.owner.q));
  ok('their ceiling binds to $10,000, not $500', ownerBound && ownerBound.value === 10000,
     ownerBound && String(ownerBound.value));
  ok('and the wording says $10,000', ownerBound && ownerBound.criterion.includes('$10,000'),
     ownerBound && ownerBound.criterion);

  const brokeChosen = lib.selectFromLibrary(ROWS, lib.founderFacts(PROFILES.broke.q));
  const zero = brokeChosen.find(c => c.slug === 'zero_budget');
  ok('a $0 budget asks "no money at all", not "under $0"', !!zero, brokeChosen.map(c => c.slug).join(', '));
  ok('and it is checkable against zero', zero && zero.check === 'numeric' && zero.value === 0);
}

console.log('\nOne criterion per category, so nobody is asked five ways about money:');
{
  for (const key of Object.keys(PROFILES)) {
    const chosen = lib.selectFromLibrary(ROWS, lib.founderFacts(PROFILES[key].q));
    const cats = chosen.map(c => (ROWS.find(r => r.slug === c.slug) || {}).category);
    const dupes = cats.filter((c, i) => c && cats.indexOf(c) !== i);
    // The second pass may repeat a category rather than leave a gap — that is
    // deliberate, but it should not happen for a well-covered profile.
    ok(`  ${key}: at most one repeat`, dupes.length <= 1, dupes.join(', ') || 'none repeated');
  }
}

console.log('\nThe same answers always produce the same test:');
{
  const q = PROFILES.hygienist.q;
  const a = lib.selectFromLibrary(ROWS, lib.founderFacts(q)).map(c => c.slug).join(',');
  // Shuffled input rows must not change the outcome — ties break on slug.
  const shuffled = ROWS.slice().sort(() => Math.random() - 0.5);
  const b = lib.selectFromLibrary(shuffled, lib.founderFacts(q)).map(c => c.slug).join(',');
  eq('row order does not change the test', b, a);
}

console.log('\nThe model fills only the gap, and never overwrites the library:');
{
  const facts = lib.founderFacts(PROFILES.blank.q);
  const chosen = lib.selectFromLibrary(ROWS, facts);
  // A near-empty profile still matches the universal fallbacks.
  ok('a blank profile still gets criteria from the library', chosen.length > 0, String(chosen.length));

  const short = chosen.slice(0, 3);
  const merged = lib.mergeFitTest(short, [
    { criterion: 'Model criterion A' }, { criterion: 'Model criterion B' }, { criterion: 'Model criterion C' }
  ], facts);
  eq('the test is filled to five', merged.length, 5);
  eq('the library criteria come first and survive', merged[0].criterion, short[0].criterion);
  ok('the extra model criterion beyond the gap is dropped',
     merged.filter(c => c.source === 'ai').length === 2, String(merged.filter(c => c.source === 'ai').length));
  ok('model criteria are judgement only — an unreviewed threshold is not graded',
     merged.filter(c => c.source === 'ai').every(c => c.check === 'judgment' && c.value === null));

  // The failure that would undo the whole design: a model returning five when
  // asked for two, and replacing curated checkable criteria with its own.
  const fullSet = lib.selectFromLibrary(ROWS, lib.founderFacts(PROFILES.hygienist.q));
  ok('a well-answered profile fills all five from the library alone', fullSet.length === 5, String(fullSet.length));
  const full = lib.mergeFitTest(fullSet, [{ criterion: 'X' }, { criterion: 'Y' }], facts);
  eq('a full library test takes nothing from the model', full.filter(c => c.source === 'ai').length, 0);
  ok('and stays at five', full.length === 5);

  const dupe = lib.mergeFitTest(short, [{ criterion: short[0].criterion }, { criterion: 'Genuinely new' }], facts);
  ok('a model criterion that restates a library one is dropped',
     dupe.filter(c => c.criterion === short[0].criterion).length === 1,
     dupe.map(c => c.criterion).join(' | '));
}

console.log('\nAnd the result grades the way fit.js expects:');
{
  const facts = lib.founderFacts(PROFILES.hygienist.q);
  const pinned = lib.selectFromLibrary(ROWS, facts);
  // An idea that starts cheap and pays fast: the two numeric criteria should be
  // settled by arithmetic, whatever the model says about them.
  const graded = gradeFitTest(pinned, pinned.map(() => ({ pass: false })), {
    startup_cost_lean: '$300', time_to_revenue: '4 weeks'
  });
  ok('the checkable criteria pass on the numbers despite the model failing them',
     graded.verified === 2 && graded.passed === 2, `${graded.passed}/${graded.total}, verified ${graded.verified}`);
  const dear = gradeFitTest(pinned, pinned.map(() => ({ pass: true })), {
    startup_cost_lean: '$5,000', time_to_revenue: '9 months'
  });
  ok('and fail on the numbers despite the model passing them',
     dear.passed === dear.total - 2, `${dear.passed}/${dear.total}`);
}

console.log('\nPath-tagged criteria only reach their own path:');
{
  const tagged = ROWS.filter(r => r.paths && r.paths.length);
  ok('the library carries path-specific criteria', tagged.length >= 16, String(tagged.length));

  for (const slug of ['creator', 'brick_mortar', 'software', 'online_store', 'physical_product']) {
    const facts = lib.founderFacts({ founder_path: slug, launch_budget: '$500-2,000',
      hours_per_week: '10-20', runway: '3-6 months', income_year1: 'Replace full salary' });
    const chosen = lib.selectFromLibrary(ROWS, facts);
    const slugs = chosen.map(c => c.slug);
    // Nothing tagged for a DIFFERENT path may appear.
    const foreign = chosen.filter(c => {
      const row = ROWS.find(r => r.slug === c.slug);
      return row && row.paths && row.paths.length && !row.paths.includes(slug);
    });
    ok(`  ${slug}: no criteria from another path`, foreign.length === 0, foreign.map(f => f.slug).join(', ') || 'clean');
    ok(`  ${slug}: still gets a full test`, chosen.length === 5, String(chosen.length));
  }

  // The specific thing paths buy you: a brick-and-mortar founder is asked about
  // rent, and a creator never is.
  const bm = lib.selectFromLibrary(ROWS, lib.founderFacts({ founder_path: 'brick_mortar',
    launch_budget: '$2,000-10,000', hours_per_week: '20-40', runway: '3-6 months' })).map(c => c.slug);
  ok('a brick-and-mortar founder is asked about rent', bm.includes('bm_rent_survivable'), bm.join(', '));
  const cr = lib.selectFromLibrary(ROWS, lib.founderFacts({ founder_path: 'creator',
    launch_budget: '$2,000-10,000', hours_per_week: '20-40', runway: '3-6 months' })).map(c => c.slug);
  ok('and a creator is not', !cr.includes('bm_rent_survivable'), cr.join(', '));
}

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nFit library holds. All checks pass.');
process.exit(fail ? 1 : 0);
