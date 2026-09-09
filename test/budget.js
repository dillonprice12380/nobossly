// Tests for the starting budget.
//
// /budget is a top-level tab entirely about money, and it did not know the one
// money number the member had already been made to give us. "Money you can put
// in to start" is a required question on every path — the fit test converts it
// to dollars and holds every idea against it, the Compass writes around it, the
// coach carries it — and this page still opened on "Add a category and limit
// below to start budgeting". The only thing that would have filled it in was
// behind the paywall, so a free member met a blank spreadsheet on a tab as
// prominent as the Compass.
//
// src/starter_budget.js is the free, deterministic half. The properties worth
// holding are all about agreement: it must not disagree with the questionnaire
// about which answers exist, or with the fit test about what they are worth.
//
//   node test/budget.js

const fs = require('fs');
const path = require('path');
const starter = require('../src/starter_budget');
const paths = require('../src/paths');
const ladders = require('../src/ladders');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
console.log('\nEvery answer the questionnaire offers is an answer this can use:');

const asked = paths.BUDGET;
ok('the questionnaire still asks in bands', Array.isArray(asked) && asked.length > 0, asked.join(' | '));
for (const band of asked) {
  const usd = starter.dollarsFor(band);
  ok(`"${band}" is understood`, usd !== null, usd === null ? 'no dollar value — suggest() would silently return nothing' : '$' + usd);
}
ok('an unanswered questionnaire yields no suggestion', starter.suggest(null, 'software').length === 0);
ok('a made-up band yields no suggestion', starter.suggest('a squillion', 'software').length === 0);
ok('$0 yields no suggestion', starter.suggest('$0', 'software').length === 0,
   'nothing to split is not the same as a budget of nothing');

// The fit test converts the same answer to dollars to decide whether an idea is
// affordable. Two different numbers for one answer would mean the app telling a
// member they can afford $2,000 on one screen and $500 on another.
const fitSrc = fs.readFileSync(path.join(ROOT, 'src/fit_library.js'), 'utf8');
const fitBlock = fitSrc.slice(fitSrc.indexOf('const BUDGET_USD'));
const fitMap = {};
for (const m of fitBlock.slice(0, fitBlock.indexOf('};')).matchAll(/'([^']+)':\s*(\d+)/g)) fitMap[m[1]] = Number(m[2]);
ok('the fit test\'s dollar bands were found', Object.keys(fitMap).length > 0, Object.keys(fitMap).length + ' bands');
const disagree = Object.entries(fitMap).filter(([k, v]) => starter.BUDGET_USD[k] !== v);
ok('the starting budget agrees with the fit test on every band', disagree.length === 0,
   disagree.map(([k, v]) => `${k}: fit ${v} vs starter ${starter.BUDGET_USD[k]}`).join('; ') || 'identical');

// ---------------------------------------------------------------------------
console.log('\nEvery path gets a split that adds up:');

const allPaths = ladders.SLUGS.concat([null, 'exploring', 'not_a_path']);
for (const p of allPaths) {
  const split = starter.splitFor(p);
  const sum = split.reduce((n, [, w]) => n + w, 0);
  ok(`${p || '(no path yet)'} splits into ${split.length}, summing to ${sum.toFixed(2)}`,
     split.length >= 3 && Math.abs(sum - 1) < 0.001);
}

// A seeded category the expense form does not offer would make the member type
// it back in by hand the first time they logged a receipt against it.
const viewSrc = fs.readFileSync(path.join(ROOT, 'views/budget.ejs'), 'utf8');
const stdLine = viewSrc.slice(viewSrc.indexOf('const stdCats = ['));
const stdCats = new Set([...stdLine.slice(0, stdLine.indexOf(']')).matchAll(/'([^']+)'/g)].map(m => m[1]));
ok('the expense form\'s category list was found', stdCats.size > 10, stdCats.size + ' categories');
const used = new Set(Object.values(starter.SPLITS).concat([starter.DEFAULT_SPLIT])
  .flat().map(([c]) => c));
const unknown = [...used].filter(c => !stdCats.has(c) && c !== 'Buffer');
ok('every suggested category is one the expense form offers', unknown.length === 0,
   unknown.join(', ') || `${used.size} categories, all offered`);

// ---------------------------------------------------------------------------
console.log('\nThe numbers are a monthly figure, and say so:');

// The declared band is what they can put in to START. Handing it back as a
// monthly allowance would triple what the member thinks they said.
const total = starter.dollarsFor('$500-2,000');
const rows = starter.suggest('$500-2,000', 'software');
const monthly = rows.reduce((n, r) => n + r.monthly_limit, 0);
// Written against the declared total rather than against MONTHS, so that
// changing MONTHS to 1 fails here instead of moving both sides of the sum.
ok('a month of the split is well under the whole launch budget',
   monthly < total * 0.75,
   `$${total} to start, $${monthly}/mo suggested`);
ok('...and it is spread over more than one month', starter.MONTHS >= 2, starter.MONTHS + ' months');
ok('...and the months add back up to roughly the total',
   Math.abs(monthly * starter.MONTHS - total) < rows.length * starter.MONTHS,
   `$${monthly} x ${starter.MONTHS} = $${monthly * starter.MONTHS} vs $${total}`);
ok('no category rounds down to nothing', rows.every(r => r.monthly_limit >= 1));

// The route must only ever fill a blank — seeding over categories someone set
// themselves would be the app editing their budget.
const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/budget.js'), 'utf8');
ok('the seed route refuses when categories already exist',
   /router\.post\('\/start'[\s\S]{0,400}existing[\s\S]{0,80}return res\.redirect\('\/budget'\)/.test(routeSrc));
ok('...and the offer is not even rendered once anything is set',
   /suggestion:\s*\(budgets \|\| \[\]\)\.length \? \[\]/.test(routeSrc));
ok('seeding costs no AI credits', !/credits\.run[\s\S]{0,200}starter/.test(routeSrc)
   && /starter\.suggest/.test(routeSrc), 'it is arithmetic on an answer they already gave');

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
