// The income log, and the two Premium tools that read it.
//
// One payment logged on the Money page has to show up, with the same number,
// in three places: the set-aside line, the Quit-Date Planner's side income and
// the Tax tool's quarters. And when the log says a money rung is reached, the
// member is pointed at the quest or trophy that records it — the log itself
// never awards anything, because a number a member typed is not proof.
//
//   node test/income.js

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const income = require('../src/income');
const calc = require('../src/tools_calc');
const { STANDARD } = require('../src/budget_categories');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const NOW = new Date('2026-10-15T12:00:00Z');
const pay = (date, amount) => ({ entry_date: date, amount });
const cost = (date, amount, category = 'Software & Subscriptions') => ({ spent_at: date, amount, category });

// ---------------------------------------------------------------------------
console.log('\nThe log reads honestly:');
{
  const empty = income.summary([], [], NOW);
  ok('an empty log has no average and no growth', empty.avgProfit === null && empty.growth === null);

  // Only the current month so far: that month is all there is to go on.
  const fresh = income.summary([pay('2026-10-03', 400)], [], NOW);
  ok('a first month on its own is the average', fresh.avgProfit === 400, String(fresh.avgProfit));

  // Three complete months; the half-finished current month must not drag the
  // average down.
  const s = income.summary(
    [pay('2026-07-10', 500), pay('2026-08-10', 600), pay('2026-09-10', 700), pay('2026-10-01', 50)],
    [cost('2026-09-12', 100)], NOW);
  ok('profit is averaged over the last three complete months, after costs', s.avgProfit === 566.67,
     `${s.avgProfit} = (500 + 600 + (700 − 100)) / 3; October's $50 so far is left out`);
  ok('...and that window is named', s.window.from === '2026-07' && s.window.to === '2026-09');
  ok('growth is measured once three months exist', s.growth !== null && s.growth > 0, s.growth + '%');

  const two = income.summary([pay('2026-08-10', 500), pay('2026-09-10', 900)], [], NOW);
  ok('two months are not a trend', two.growth === null);

  const wild = income.summary([pay('2026-07-10', 10), pay('2026-08-10', 10), pay('2026-09-10', 5000)], [], NOW);
  ok('one lucky month is clamped, not believed', wild.growth === 30, wild.growth + '%');

  const gap = income.summary([pay('2026-06-10', 300), pay('2026-09-10', 300)], [], NOW);
  ok('a month with nothing logged counts as nothing, not as missing', gap.avgProfit === 100, String(gap.avgProfit));
}

// ---------------------------------------------------------------------------
console.log('\nA reached money rung is pointed at, never awarded:');
{
  const log = [pay('2026-08-02', 300), pay('2026-09-05', 1200)];
  const s = income.summary(log, [], NOW);
  const titles = income.claimPrompts('freelancer', s, new Set()).map(c => c.title);
  ok('a $1,200 month reaches the freelancer\'s first sale, first $100 and $1k month',
     ['Make your first sale', 'Earn Your First $100', 'Hit a $1k month'].every(t => titles.includes(t)), titles.join(', '));
  ok('...but not three $1k months in a row', !titles.includes('Three $1k months in a row'));

  const held = income.claimPrompts('freelancer', s, new Set(['Make your first sale', 'Earn Your First $100']));
  ok('a quest already completed is not asked for again', !held.some(c => c.title === 'Make your first sale'),
     held.map(c => c.title).join(', '));
  ok('quests go to the quest board, trophies to the trophies page',
     held.every(c => c.href === (c.kind === 'quest' ? '/quests' : '/trophies')));

  const run = income.summary([pay('2026-07-01', 1000), pay('2026-08-01', 1100), pay('2026-09-01', 1300)], [], NOW);
  ok('three $1k months in a row is seen', run.run1k === 3);
  const broken = income.summary([pay('2026-06-01', 1000), pay('2026-07-01', 400), pay('2026-08-01', 1000), pay('2026-09-01', 1000)], [], NOW);
  ok('...and a dip in between breaks the run', broken.run1k === 2);

  const loss = income.summary([pay('2026-09-01', 200)], [cost('2026-09-02', 500)], NOW);
  ok('a month that cost more than it made is not profitable', loss.profitableMonth === false);

  // The point of the whole rule: nothing in the income path writes a
  // completion, a trophy or XP.
  const src = read('src/income.js') + read('src/routes/budget.js');
  const writes = ['awardXP', 'award_xp', 'complete_quest_for', 'claim_trophy_for', "from('challenge_completions').insert", "from('user_milestones').insert"]
    .filter(w => src.includes(w));
  ok('logging income awards nothing by itself', writes.length === 0, writes.join(', ') || 'clean');

  ok('every money gate the log knows is a real gate on some ladder',
     income.MONEY_GATES.every(g => require('../src/ladders').SLUGS.some(p => income.gatesOnPath(p).some(x => x.title === g.title))));
}

// ---------------------------------------------------------------------------
console.log('\nThe next money rung is forecast from the logged pace:');
{
  // Freelancer Level 7 → the next money rung is "Hit a $1k month" at Level 8.
  const s = income.summary([pay('2026-07-01', 500), pay('2026-08-01', 550), pay('2026-09-01', 605)], [], NOW);
  const next = income.nextMoneyRung('freelancer', 7, s, NOW);
  ok('it names the rung on the member\'s own ladder', next && next.title === 'Hit a $1k month' && next.level === 8,
     next && `${next.title}, Level ${next.level} ${next.rung}`);
  ok('...and when the logged pace gets there', next && next.eta && next.eta.months > 0 && next.eta.months < 12,
     next && next.eta && `${next.eta.months} months, ${next.eta.month}`);

  const flat = income.summary([pay('2026-09-01', 500)], [], NOW);
  const noPace = income.nextMoneyRung('freelancer', 7, flat, NOW);
  ok('with no growth measured there is no date, not a made-up one', noPace && noPace.eta === null);

  ok('a rung already passed is not forecast', income.nextMoneyRung('freelancer', 10, s, NOW) === null);
}

// ---------------------------------------------------------------------------
console.log('\nTax deductions come from the budget, by category:');
{
  ok('a standard business category counts by default', calc.isDeductible({}, 'Software & Subscriptions', STANDARD));
  ok('Travel & Vehicle starts off — miles are claimed instead', !calc.isDeductible({}, 'Travel & Vehicle', STANDARD));
  ok('a category the member typed starts off', !calc.isDeductible({}, 'Groceries', STANDARD));
  ok('the member\'s own tick wins either way',
     calc.isDeductible({ deductible: { 'Travel & Vehicle': true } }, 'Travel & Vehicle', STANDARD)
     && !calc.isDeductible({ deductible: { 'Software & Subscriptions': false } }, 'Software & Subscriptions', STANDARD));

  // The same payment, read by the tax summary the way the route merges it.
  const sum = calc.taxSummary({
    income: [{ date: '2026-05-10', amount: 1000, fromLog: true }],
    deductions: [{ date: '2026-05-11', amount: 200, category: 'Software & Subscriptions', fromBudget: true }]
  }, 2026);
  ok('a logged payment lands in its IRS quarter', sum.quarters[1].income === 1000, 'Q2 ' + sum.quarters[1].income);
  ok('...less the budget expense beside it', sum.quarters[1].deductions === 200);
}

// ---------------------------------------------------------------------------
console.log('\nThe pages render with a log and without one:');
{
  const V = f => path.join(ROOT, 'views', f);
  const base = {
    title: 'T', user: { id: 'u' }, profile: { username: 'u', display_name: 'U' }, plan: 'paid', currentPath: '/budget',
    canonicalUrl: 'https://nobossly.com/', unreadCount: 0, unreadMsgs: 0, metaDescription: '',
    bodyTheme: 'theme-light', settings: {}, pendingDeletion: null, reactivated: false, isPremium: true,
    affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false },
    premiumTools: require('../src/premium').TOOLS
  };
  const render = (f, data) => ejs.render(fs.readFileSync(V(f), 'utf8'), Object.assign({}, base, data), { filename: V(f) });
  const s = income.summary([pay('2026-07-01', 500), pay('2026-08-01', 550), pay('2026-09-01', 1200)], [], NOW);

  const budgetData = claims => ({
    budgets: [], expenses: [], spentByCat: {}, totalSpent: 0, totalBudget: 0, cats: [], monthLabel: 'October 2026',
    paid: true, msg: null, insights: null, launchBudget: null, launchBudgetUsd: 0, suggestion: [], starterMonths: 3,
    budgetCategories: STANDARD, incomeLog: [{ id: 'i1', amount: 1200, entry_date: '2026-09-01', source: 'Acme' }],
    incomeSum: s, setAsideRate: 26.1, claims
  });
  let html = '';
  try { html = render('budget.ejs', budgetData(income.claimPrompts('freelancer', s, new Set()))); } catch (e) { ok('the Money page renders', false, e.message); }
  ok('the Money page shows the log and the set-aside rate', html.includes('$1,200.00') && html.includes('26.1%'));
  ok('...and points at the reached rung', html.includes('Hit a $1k month') && html.includes('href="/quests"'));

  const quitBase = {
    data: { inputs: { living: 3000 } }, inputs: calc.quitInputs({ living: 3000, side: s.avgProfit, growth: s.growth }),
    hasPlan: true, checkins: [], monthLabel: calc.monthLabel, m: null, checkinSide: 0
  };
  quitBase.plan = calc.quitPlan(quitBase.inputs);
  for (const [label, extra] of [
    ['from the log', { logged: s, auto: true, nextRung: income.nextMoneyRung('freelancer', 6, s, NOW) }],
    ['with no log yet', { logged: null, auto: false, nextRung: null }]
  ]) {
    let q = '';
    try { q = render('tools/quit.ejs', Object.assign({}, quitBase, extra)); } catch (e) { ok(`the planner renders ${label}`, false, e.message); continue; }
    ok(`the planner renders ${label}`, extra.logged ? q.includes('From your income log') && q.includes('use_log') : q.includes('Log your payments'));
  }

  let t = '';
  try {
    t = render('tools/tax.ejs', {
      year: 2026, thisYear: 2026, sum: calc.taxSummary({ income: [{ date: '2026-05-10', amount: 1000, fromLog: true }] }, 2026),
      settings: {}, income: [{ id: 'x', date: '2026-05-10', amount: 1000, fromLog: true }], deductions: [], miles: [], payments: [],
      brackets: calc.FED_BRACKETS, today: '2026-10-15', m: null,
      categories: STANDARD.map(c => ({ name: c, on: calc.isDeductible({}, c, STANDARD) }))
    });
  } catch (e) { ok('the tax tool renders', false, e.message); }
  ok('the tax tool reads income from the log, with no second form for it',
     t.includes('From your income log') && !t.includes('action="/tools/tax/income"'));
  ok('...and a logged payment has no delete button there (it is deleted from the Money page)',
     !t.includes('/tools/tax/income/x/delete'));
  ok('...and lists the budget categories to count', t.includes('name="deductible" value="Software &amp; Subscriptions" checked')
     && t.includes('name="deductible" value="Travel &amp; Vehicle" >'));
}

console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
process.exit(fail ? 1 : 0);
