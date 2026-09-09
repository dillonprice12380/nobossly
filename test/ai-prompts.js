// The Compass prompt has to actually assemble.
//
// COMPASS_SPEC was referenced by generateCompass() and never defined anywhere.
// Every Compass generation therefore died on `COMPASS_SPEC is not defined`
// before it reached the model — and nothing caught it, because the prompt is
// built by string concatenation inside a function that only runs when someone
// has a real questionnaire and a real token. Neither exists in a test, and
// neither exists in the sandbox, which cannot reach Supabase at all.
//
// So this stubs the network and builds the prompt for real, on every path. It
// is cheap and it catches the whole class: a missing constant, a renamed
// helper, a schema key the views read that the model was never asked for.
//
//   node test/compass-prompt.js

const paths = require('../src/paths');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// A plausible answer set per path, built from that path's own questions so the
// prompt has something real to compact.
function answersFor(slug) {
  const q = {
    founder_path: slug, founder_name: 'Sam',
    hours_per_week: '5-10', launch_budget: 'Under $500', runway: '3-6 months',
    income_year1: '$1,000-2,500 a month', deal_breakers: ['cold calling'],
    location: 'Leeds, UK', path_answers: {}
  };
  // Fill every question this path asks, so nothing reads as absent.
  for (const def of paths.coreQuestions(slug).concat(paths.depthQuestions(slug))) {
    const v = def.type === 'checks' || def.type === 'csv' ? ['something']
      : def.options && def.options.length ? def.options[0]
      : 'an answer';
    if (def.col) { if (q[def.col] === undefined) q[def.col] = v; }
    else q.path_answers[def.name] = v;
  }
  return q;
}

// Everything views/compass.ejs reads off the Compass object. If the model is
// never asked for one of these, the page renders a hole.
const REQUIRED_KEYS = ['archetype', 'loadout', 'territories', 'fit_test', 'avoid_list', 'toolkit'];
const REQUIRED_SUBKEYS = [
  'strengths', 'advantages', 'constraints', 'honest_notes',   // loadout
  'temperature', 'why_you', 'example_plays', 'watch_out',     // territories
  'criterion', 'avoid_list', 'toolkit'
];

(async () => {
  const cai = require('../src/compass_ai');

  console.log('\nThe Compass prompt assembles on every path:');

  const captured = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    captured.push(JSON.parse(opts.body));
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ text: '{"archetype":{},"loadout":{},"territories":[],"fit_test":[],"avoid_list":[],"toolkit":[]}' })
    };
  };

  try {
    for (const p of paths.PATHS) {
      captured.length = 0;
      let threw = null;
      try {
        await cai.generateCompass('fake-token', answersFor(p.slug), null, []);
      } catch (e) { threw = e; }

      ok(`${p.slug}: builds without throwing`, !threw, threw ? threw.message : 'ok');
      if (threw || !captured.length) { continue; }

      const prompt = captured[0].prompt;

      // The bug that motivated this file prints as the literal word "undefined"
      // in the middle of the prompt when the constant is a var rather than a
      // hard reference — and as a throw when it is not declared at all. Catch
      // both, plus any future helper that returns undefined.
      ok(`${p.slug}: no "undefined" reaches the model`,
         !/\bundefined\b/.test(prompt),
         (prompt.match(/.{0,40}\bundefined\b.{0,40}/) || ['clean'])[0]);

      const missing = REQUIRED_KEYS.filter(k => !prompt.includes('"' + k + '"'));
      ok(`${p.slug}: asks for every key the Compass page reads`,
         missing.length === 0, missing.join(', ') || REQUIRED_KEYS.length + ' keys');
    }

    // The library path: when the fit test is already covered, the model must be
    // told to return fewer — not five more that duplicate them.
    captured.length = 0;
    const covered = [1, 2, 3, 4].map(i => ({ criterion: 'Covered criterion ' + i }));
    await cai.generateCompass('fake-token', answersFor('creator'), null, covered);
    const withLib = captured[0].prompt;
    ok('a partly-covered fit test asks only for the gap',
       /EXACTLY 1 further criterion/.test(withLib), 'gap of 1');

    captured.length = 0;
    const full = [1, 2, 3, 4, 5].map(i => ({ criterion: 'Covered criterion ' + i }));
    await cai.generateCompass('fake-token', answersFor('creator'), null, full);
    ok('a fully-covered fit test asks for none',
       /EMPTY array for fit_test/.test(captured[0].prompt), 'no gap');

    // Sub-keys, checked once — they are the same spec on every path.
    captured.length = 0;
    await cai.generateCompass('fake-token', answersFor('local_service'), null, []);
    const one = captured[0].prompt;
    const missingSub = REQUIRED_SUBKEYS.filter(k => !one.includes(k));
    ok('...and every nested field the page renders', missingSub.length === 0,
       missingSub.join(', ') || REQUIRED_SUBKEYS.length + ' fields');

    // The advisor builds its own prompt the same way.
    captured.length = 0;
    let advThrew = null;
    try {
      await cai.adviseIdea('fake-token', answersFor('freelancer'), { archetype: {} },
        { name: 'An idea', tagline: 't', description: 'd', problem: 'p', customer: 'c', monetization: 'm' },
        [{ criterion: 'Can it be done in evenings?' }]);
    } catch (e) { advThrew = e; }
    ok('the advisor prompt assembles too', !advThrew, advThrew ? advThrew.message : 'ok');
    ok('...with no "undefined" in it',
       !advThrew && captured.length && !/\bundefined\b/.test(captured[0].prompt), 'clean');

    // ---------------------------------------------------------------------
    // The same class of bug, everywhere else a prompt is built.
    //
    // COMPASS_SPEC was a constant referenced and never declared. Nothing caught
    // it because prompts are assembled inside functions that only run with a
    // real token and a real row. src/ai.js has eight more such functions and
    // src/coach.js four; none of them had ever been executed by a test.

    console.log('\nEvery other prompt builder runs:');

    const ai = require('../src/ai');
    const q = answersFor('consultant');
    // Deliberately SPARSE. This is an idea the moment it is drafted: a name and
    // the member's own words, and nothing the advisor would later add. Building
    // a blueprint from one is a real sequence — the advisor can fail, or be
    // refused for credits — and it is how "Market: undefined" reached the model.
    const idea = { id: 'i1', name: 'An idea' };
    // Likewise a blueprint with only the columns the insert always sets.
    const bp = { id: 'b1', business_name: 'B' };

    const CALLS = [
      ['ai.marketScan', () => ai.marketScan('tok', q)],
      ['ai.demandEvidence', () => ai.demandEvidence('tok', idea)],
      ['ai.generateBlueprint', () => ai.generateBlueprint('tok', idea, q)],
      ['ai.generateSprintTasks', () => ai.generateSprintTasks('tok', bp, 1)],
      ['ai.generateMilestones', () => ai.generateMilestones('tok', bp)],
      ['ai.generateChallenges', () => ai.generateChallenges('tok', bp)],
      ['ai.generateBudget', () => ai.generateBudget('tok', bp)],
      ['ai.budgetInsights', () => ai.budgetInsights('tok', { month: 'May', totalBudget: 100, totalSpent: 50, categories: [] })]
    ];

    for (const [name, run] of CALLS) {
      captured.length = 0;
      let threw = null;
      try { await run(); } catch (e) { threw = e; }
      // A JSON-shape complaint is fine — the stub returns a fixed body. A
      // ReferenceError is not, and that is the whole point of this test.
      const isRef = threw && threw instanceof ReferenceError;
      ok(`${name}: no missing identifier`, !isRef, isRef ? threw.message : 'ok');
      if (captured.length) {
        ok(`${name}: no "undefined" in the prompt`,
           !/\bundefined\b/.test(captured[0].prompt),
           (String(captured[0].prompt).match(/.{0,40}\bundefined\b.{0,40}/) || ['clean'])[0]);
      }
    }

    // The coach spends a credit before it calls, so its client needs stubbing
    // too. rpc() returning ok:true is what spend_ai_credits() returns.
    const coach = require('../src/coach');
    const sb = { rpc: async () => ({ data: { ok: true, plan: 'paid', balance: 99, cap: 400, cost: 1, visible: false } }) };
    const ctx = {
      name: 'Sam', pathLabel: 'Coach or consultant', subpathLabel: 'Career coaching',
      level: 4, topLevel: 10, rungTitle: 'In the Room', next: { level: 5, title: 'First Fee' },
      quests: [{ title: 'Land one paid client', done: false }], needMin: 1, xpNeeded: 50,
      hours: '5-10', runway: '3-6 months', budget: 'Under $500', dealBreakers: 'cold calling',
      streak: 3, bar: null, idea: null, fitResults: [], fitTest: [], lastWeek: null, checkins: []
    };

    for (const [name, run] of [
      ['coach.weeklyPlan', () => coach.weeklyPlan(sb, 'tok', ctx)],
      ['coach.reply', () => coach.reply(sb, 'tok', ctx, [], 'I am stuck')],
      ['coach.reviewProof', () => coach.reviewProof(sb, 'tok', ctx, 'Land one paid client', 'I did it')],
      ['coach.readingList', () => coach.readingList(sb, 'tok', ctx, [{ id: 'g', title: 'A guide', excerpt: 'e' }])]
    ]) {
      captured.length = 0;
      let threw = null;
      try { await run(); } catch (e) { threw = e; }
      const isRef = threw && threw instanceof ReferenceError;
      ok(`${name}: no missing identifier`, !isRef, isRef ? threw.message : 'ok');
      if (captured.length) {
        ok(`${name}: no "undefined" in the prompt`,
           !/\bundefined\b/.test(captured[0].prompt),
           (String(captured[0].prompt).match(/.{0,40}\bundefined\b.{0,40}/) || ['clean'])[0]);
      }
    }

  } finally {
    global.fetch = realFetch;
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})();
