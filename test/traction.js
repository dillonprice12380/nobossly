// Tests for the traction bar — the one number each path is measured by
// (src/traction.js).
//
// Two ways this goes wrong, both silent:
//
//   A number that is confidently wrong. Reading a band from the wrong end, or
//   quoting one path's unit at another, produces advice that looks precise and
//   sends someone the wrong way. Worse than saying nothing.
//
//   A number invented to fill a gap. Where the answers a formula needs are
//   missing, the honest output is nothing at all — not a default, not a guess.
//
//   node test/traction.js

const t = require('../src/traction');
const lib = require('../src/fit_library');
const paths = require('../src/paths');
const ROWS = require('./fit-library-snapshot.json');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const run = (path, path_answers, extra) => ({ founder_path: path, path_answers, ...(extra || {}) });
const read = (path, path_answers, facts) => t.tractionFor(run(path, path_answers), facts || {});

console.log('\nEvery path that can have a bar has one:');

const WITH_ANSWERS = {
  creator: [{ creator_type: 'Social media creator or influencer', audience_size: '1,000–10,000' }, {}],
  freelancer: [{}, { hours_per_week: 10 }],
  consultant: [{ ticket_comfort: '$2,000–10,000' }, {}],
  local_service: [{ avg_job_value: '$100–250' }, {}],
  brick_mortar: [{ rent_capacity: '$1,500–3,000' }, {}],
  online_store: [{ avg_order_value: '$40–100', gross_margin: '50–70%' }, {}],
  physical_product: [{}, {}],
  software: [{ expected_price: '$30–100', who_pays: 'Small businesses' }, {}]
};

for (const p of paths.PATHS) {
  const spec = WITH_ANSWERS[p.slug];
  const got = spec ? read(p.slug, spec[0], spec[1]) : read(p.slug, {}, {});
  if (p.slug === 'exploring') {
    ok('exploring has no bar, deliberately', got === null, got ? JSON.stringify(got) : 'none');
    continue;
  }
  ok(`${p.slug}: has a bar`, !!(got && got.display), got ? got.display : 'MISSING');
  ok(`${p.slug}: says where the number came from`, !!(got && got.detail), got ? got.detail : '—');
}

console.log('\nThe arithmetic is right:');

// $1k a month at 10 hours a week: 10 x 0.6 billable x 4.3 weeks = 26 hours,
// so the rate has to clear 1000/26.
eq('a freelancer at 10h/week needs $39/hr', read('freelancer', {}, { hours_per_week: 10 }).target, 39);
eq('...and twice the hours halves the rate', read('freelancer', {}, { hours_per_week: 20 }).target, 20);
eq('a consultant at $2,000 needs one engagement a month',
   read('consultant', { ticket_comfort: '$2,000–10,000' }).target, 1);
eq('...at $250 they need four', read('consultant', { ticket_comfort: 'Under $500' }).target, 4);
eq('a $100 job means 10 jobs a month', read('local_service', { avg_job_value: '$100–250' }).target, 10);
eq('a $40 order at 50% margin means 50 orders',
   read('online_store', { avg_order_value: '$40–100', gross_margin: '50–70%' }).target, 50);
eq('rent of $1,500 demands $15,000 of takings',
   read('brick_mortar', { rent_capacity: '$1,500–3,000' }).target, 15000);
eq('a physical product needs 3x its cost', read('physical_product', {}).target, 3);

// The reason software deserved this treatment: the buyer moves the count by two
// orders of magnitude, and the same product priced two ways is two businesses.
eq('consumer software needs 200 customers',
   read('software', { expected_price: 'Under $10', who_pays: 'Consumers' }).target, 200);
eq('small-business software needs 34',
   read('software', { expected_price: '$30–100', who_pays: 'Small businesses' }).target, 34);
eq('enterprise software needs 2',
   read('software', { expected_price: '$500+', who_pays: 'Larger companies' }).target, 2);

console.log('\nBands are read from the honest end:');

// A band describing what you HAVE reads as its floor: crediting the top would
// understate the work. An OPEN-BOTTOM band has no floor to read, so it takes
// half its top rather than zero — which would divide by nothing.
eq('a closed band reads as its floor (a $100-250 job is $100)',
   read('local_service', { avg_job_value: '$100–250' }).target, 10);
eq('an open-bottom band reads as half its top ("under $100" is $50, so 20 jobs)',
   read('local_service', { avg_job_value: 'Under $100' }).target, 20);
ok('a thin-margin store is told the brutal number',
   read('online_store', { avg_order_value: 'Under $20', gross_margin: 'Under 30%' }).target > 500,
   read('online_store', { avg_order_value: 'Under $20', gross_margin: 'Under 30%' }).display);

console.log('\nA missing answer produces nothing, never a guess:');

eq('software with no price', read('software', {}), null);
eq('a store that knows its order value but not its margin',
   read('online_store', { avg_order_value: '$40–100', gross_margin: 'Not sure yet' }), null);
eq('a consultant who has not named a price', read('consultant', {}), null);
eq('a local service with no job value', read('local_service', {}), null);
eq('a shop with no rent figure', read('brick_mortar', {}), null);
eq('a freelancer whose hours are unknown', read('freelancer', {}, {}), null);
eq('a path that does not exist', t.tractionFor(run('nonsense', {})), null);
eq('no questionnaire at all', t.tractionFor(null), null);

console.log('\nThe bar reaches the fit test, in that path\'s own words:');

const moneyRow = ROWS.find(r => r.slug === 'reaches_the_money_bar');
ok('the row is written with a placeholder, not a number',
   /\{traction\}/.test(moneyRow.criterion), moneyRow.criterion);

const profile = (path, path_answers) => ({
  founder_path: path, path_answers, launch_budget: 'Under $500', hours_per_week: '5-10',
  runway: '1-3 months', income_year1: 'Replace part of salary', deal_breakers: []
});

const cases = [
  ['freelancer', {}, /\$\d+ an hour/],
  ['consultant', { ticket_comfort: '$2,000–10,000' }, /engagement/],
  ['local_service', { avg_job_value: '$100–250' }, /jobs a month/],
  ['software', { expected_price: '$30–100', who_pays: 'Small businesses' }, /paying customers/],
  ['brick_mortar', { rent_capacity: '$1,500–3,000' }, /through the till/],
  ['online_store', { avg_order_value: '$40–100', gross_margin: '50–70%' }, /orders a month/]
];
for (const [path, answers, shape] of cases) {
  const facts = lib.founderFacts(profile(path, answers));
  const bound = lib.toCriterion(moneyRow, facts);
  ok(`${path}: reads in its own unit`, !!bound && shape.test(bound.criterion),
     bound ? bound.criterion : 'DROPPED');
  ok(`${path}: no placeholder survives into the wording`,
     !!bound && !/\{|\}/.test(bound.criterion + bound.why), 'clean');
}

// And it must be withheld rather than fudged when the answers are missing.
const noBar = lib.founderFacts(profile('software', {}));
eq('a member with no bar does not match the criterion', noBar.has_traction_bar, false);
ok('...so selection never hands it to them',
   !lib.selectFromLibrary(ROWS, noBar).some(c => c.slug === 'reaches_the_money_bar'), 'withheld');
ok('...while a member with one gets it',
   lib.selectFromLibrary(ROWS, lib.founderFacts(profile('software', { expected_price: '$30–100', who_pays: 'Small businesses' })))
     .some(c => c.slug === 'reaches_the_money_bar'), 'included');

// One path's unit must never be quoted at another.
const fl = lib.toCriterion(moneyRow, lib.founderFacts(profile('freelancer', {}))).criterion;
const sw = lib.toCriterion(moneyRow, lib.founderFacts(profile('software', { expected_price: '$30–100' }))).criterion;
ok('a freelancer is never told about paying customers', !/customers/.test(fl), fl);
ok('a software builder is never told an hourly rate', !/an hour/.test(sw), sw);


console.log('\nThe landing-page copy quotes the numbers the engine produces:');

// Marketing copy that drifts from the product is how a page ends up promising
// something the app does not do. Every figure in a path's `bar` line is one the
// engine actually returns for that answer, so these are checked, not trusted.
for (const p of paths.MARKETED) {
  ok(`${p.slug}: states its bar`, !!(p.marketing && p.marketing.bar),
     p.marketing && p.marketing.bar ? p.marketing.bar.slice(0, 54) + '…' : 'MISSING');
}

const quoted = [
  ['freelancer', '$39 an hour', read('freelancer', {}, { hours_per_week: 10 }).target, 39],
  ['consultant', 'four engagements at $250', read('consultant', { ticket_comfort: 'Under $500' }).target, 4],
  ['local_service', 'ten jobs at $100', read('local_service', { avg_job_value: '$100–250' }).target, 10],
  ['local_service', 'four jobs at $250', read('local_service', { avg_job_value: '$250–500' }).target, 4],
  ['brick_mortar', '$15,000 through the till', read('brick_mortar', { rent_capacity: '$1,500–3,000' }).target, 15000],
  ['online_store', '50 orders', read('online_store', { avg_order_value: '$40–100', gross_margin: '50–70%' }).target, 50],
  ['software', '200 customers at $5', read('software', { expected_price: 'Under $10' }).target, 200],
  ['software', '34 customers at $30', read('software', { expected_price: '$30–100' }).target, 34],
  ['software', '2 customers at $500', read('software', { expected_price: '$500+' }).target, 2]
];
for (const [slug, label, got, want] of quoted) {
  ok(`${slug}: the copy's "${label}" is what the engine returns`, got === want,
     `engine says ${got}`);
}

// And the figure has to actually be in the sentence a reader sees.
const inCopy = [
  ['freelancer', '$39'], ['brick_mortar', '$15,000'], ['software', '200'],
  ['online_store', '50 orders'], ['creator', '10,000 followers']
];
for (const [slug, figure] of inCopy) {
  const bar = paths.get(slug).marketing.bar;
  ok(`${slug}: the page says "${figure}"`, bar.includes(figure), bar.slice(0, 60) + '…');
}

console.log(fail ? `\n${fail} failing\n` : '\nTraction bars hold. All checks pass.\n');
process.exit(fail ? 1 : 0);
