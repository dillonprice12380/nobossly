// Compass AI. Deliberately separate from ai.js: the Compass never
// prescribes which business to start — it sharpens the member's judgement
// (archetype, loadout, territories, fit test, avoid list, toolkit) and then
// stress-tests the idea the member drafts THEMSELVES. The member decides;
// the AI advises. ai.js keeps the legacy prescriptive generator untouched.

const paths = require('./paths');

const EDGE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/ai-proxy';

async function askJSON(token, system, prompt, maxTokens = 4096, opts = {}) {
  if (!token) throw new Error('Not authenticated');
  const r = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'apikey': process.env.SUPABASE_ANON_KEY
    },
    body: JSON.stringify({
      system: system + ' Respond ONLY with valid JSON. No markdown fences, no commentary.',
      prompt,
      max_tokens: maxTokens,
      web_search: !!opts.webSearch,
      max_searches: opts.maxSearches || undefined
    })
  });
  const raw = await r.text();
  let j = {};
  let bodyParsed = true;
  try { j = raw ? JSON.parse(raw) : {}; } catch (_) { bodyParsed = false; }
  if (!r.ok || j.error) {
    if (r.status === 546 || r.status === 504) {
      throw new Error('the AI request ran past the server time limit. Please try again — it usually goes through on a second attempt.');
    }
    throw new Error(j.error || ('AI proxy HTTP ' + r.status));
  }
  if (!bodyParsed) throw new Error('the AI response was cut off in transit. Please try again.');
  let text = String(j.text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  if (!text) throw new Error('the AI returned an empty response. Please try again.');
  const start = Math.min(...['[', '{'].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start === Infinity || end === -1) throw new Error('AI returned no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

// Compact, lossless-enough member profile: every answered question, keyed
// plainly, skipped questions dropped so the model never reads absence as signal.
// The member's answers, labelled and path-aware. This used to dump every
// non-empty column as raw JSON, which meant the model saw keys like
// "biz_whats_stuck" with no idea which path they belonged to — and, once
// path-specific answers moved into path_answers, would have seen a nested blob
// with no labels at all.
function compactProfile(q) {
  return paths.describe(q);
}

// What the Compass is FOR on each path. The three tasks this replaces were
// written for the old stage split, so a plumber and a SaaS builder were given
// identical instructions. Every one of these still ends the same way: the
// Compass sharpens the member's judgement, it never picks for them.
const PATH_TASKS = {
  creator: `This person builds an audience. Draw their Compass around what only they can make: name their archetype, read their loadout honestly, and map 3-4 CONTENT TERRITORIES — subject areas where their knowledge, access or taste gives them an unfair angle, not "post more". Weigh their real posting capacity against the platform they chose, and be candid where an audience size of zero means the first year is unpaid.

Use the right unit for the kind of creator they are, and say the number out loud. A social, video, podcast or newsletter creator is measured in followers or subscribers, and money that comes from audience size alone starts arriving at roughly 10,000. A publisher or blogger is measured in monthly visitors, and ad or affiliate revenue does not amount to much below roughly 50,000 a month. Compare where they are now against the bar for their kind, say plainly how far that is, and treat both numbers as rules of thumb rather than laws. Never quote the follower bar at a publisher or the traffic bar at an influencer.`,
  freelancer: `This person sells a skill and does the work themselves. Map 3-4 POSITIONING TERRITORIES — the specific niches and buyer types where their skill commands a premium rather than competing on price. Be honest about the ceiling: hours are finite, and a rate that cannot reach their income goal at their available hours is the most useful thing you can show them.`,
  consultant: `This person sells judgement, not execution. Map 3-4 PROBLEM TERRITORIES — expensive, recurring problems their expertise actually solves, where the buyer has budget and authority. Weigh their proof honestly: advice without a track record or a credential sells slowly, and pricing follows the outcome, never the hours.`,
  local_service: `This person goes to the customer. Map 3-4 SERVICE TERRITORIES inside their travel radius — job types where demand is steady, competition is beatable, and their kit and licensing let them start. Ground everything in local reality: seasonality, drive time, and how people in their area actually find a tradesperson.`,
  brick_mortar: `This person is opening a place people come to. Map 3-4 CONCEPT TERRITORIES that fit their rent ceiling, fit-out budget and the licences they can realistically get. Be blunt about fixed costs: rent is due whether anyone walks in or not, and a concept that only works at full capacity is a concept that fails.`,
  online_store: `This person sells products online. Map 3-4 PRODUCT TERRITORIES where their sourcing route, margin and channel can actually compete. Be honest about the two ways this fails: a margin too thin to pay for customer acquisition, and a commodity anyone can undercut.`,
  physical_product: `This person is MAKING a product, not reselling one. Map 3-4 PRODUCT TERRITORIES where their skills, access to manufacturing and budget can realistically produce something people want. Weigh the two things that kill physical products: a unit cost that leaves no room for wholesale and retail margin on top, and money committed to tooling or a minimum order before anyone has proved they will buy.`,
  software: `This person is building a product. Map 3-4 PROBLEM TERRITORIES narrow enough to build with what they can actually build — their own hands, no-code, or a budget. Weigh distribution as hard as the build: software that nobody can find is the most common way this path ends.`,
  exploring: `This person has no direction yet. Draw their Compass so THEY can choose well: name their archetype, read their loadout back honestly, map 3-4 territories where their profile gives a real edge, and name what they should avoid. The Compass sharpens their judgement — it does not pick for them.`
};

async function generateCompass(token, q, scan, fromLibrary) {
  const path = PATH_TASKS[q && q.founder_path] ? q.founder_path : 'exploring';
  const system = "You are NoBossly's strategist. The person you are writing for wants out of a job, and almost always still has one — treat their remaining hours, their runway and their salary as the central facts, not as background. You never prescribe which business they should start; you sharpen their judgement so they can choose for themselves. Everything you write is grounded in their actual answers and any market scan provided. You are candid: naming a real constraint or a mismatch respectfully serves them better than encouragement. Speak to them in second person, and avoid the words founder, entrepreneur and startup — say what they are actually doing instead.";
  const scanBlock = scan ? '\n\nLIVE MARKET SCAN (web search run moments ago — treat as the current state of the market; where it names what the business actually is and its segments, trust that over any assumption):\n' + JSON.stringify(scan) : '';
  // Most of the fit test comes from a curated library, matched to this
  // member's answers. The model is asked only for whatever the library could
  // not cover — and is told what already exists so it does not restate it in
  // different words.
  const covered = Array.isArray(fromLibrary) ? fromLibrary : [];
  const gap = Math.max(0, 5 - covered.length);
  const fitBlock = covered.length
    ? '\n\nTHE FIT TEST IS MOSTLY WRITTEN ALREADY. These ' + covered.length + ' criteria are set and will be used verbatim:\n'
      + covered.map((c, i) => (i + 1) + '. ' + c.criterion).join('\n')
      + (gap
          ? '\n\nReturn EXACTLY ' + gap + ' further criterion' + (gap === 1 ? '' : 'a') + ' in fit_test — only the missing '
            + gap + '. Do not restate, rephrase or overlap with the ones above; cover something they do not, drawn from this person\'s answers. Set check to "judgment" and metric, op and value to null.'
          : '\n\nReturn an EMPTY array for fit_test. The test is already complete.')
    : '';
  const prompt = 'Their profile (questionnaire answers, verbatim keys):\n' + compactProfile(q) + scanBlock + '\n\n' + PATH_TASKS[path] + '\n\n' + COMPASS_SPEC + fitBlock;
  return askJSON(token, system, prompt, 5000);
}

// Stress-test the idea the member drafted, against their own Compass and the
// live market. Returns fields shaped for the generated_ideas row plus the
// advisor extras (fit_results, sharper_version, considerations).
async function adviseIdea(token, q, compassData, draft, fitTest) {
  const system = "You are NoBossly's advisor — the wise counsel at their side, never the author of their idea. They are building a way out of a job they still have, so time and runway are real constraints, not caveats. The idea below is THEIRS. Your job: stress-test it against their own fit test, their loadout, and the live market; show them exactly where it holds and where it strains; offer a sharper version they are free to ignore. Honest probabilities, real competitors (never invented), respect shown through candour. Second person throughout, and avoid the words founder, entrepreneur and startup.";
  const prompt = 'Their profile:\n' + compactProfile(q)
    + '\n\nTheir Compass (their archetype, loadout and territories — test the idea against THIS):\n' + JSON.stringify(compassData || {})
    + (Array.isArray(fitTest) && fitTest.length
        ? '\n\nTHE FIT TEST TO GRADE, pinned to this idea when it was first drafted. Grade THESE criteria, in THIS order, and return exactly ' + fitTest.length + ' fit_results. Do not substitute, reorder, merge or add criteria.\n'
          + fitTest.map((c, i) => (i + 1) + '. ' + c.criterion + (c.why ? '  (' + c.why + ')' : '')).join('\n')
        : '')
    + '\n\nTHE FOUNDER\'S OWN DRAFT IDEA:\nName: ' + (draft.name || '')
    + '\nOne-liner: ' + (draft.tagline || '')
    + '\nDescription: ' + (draft.description || '')
    + '\nProblem it solves: ' + (draft.problem || '')
    + '\nFirst customer: ' + (draft.customer || '')
    + '\nHow it makes money: ' + (draft.monetization || '')
    + `\n\nUse web search to ground the market read and competitors in what exists right now.\n\nReturn a JSON object with exactly these string fields unless noted:\nname (their idea's name, cleaned up but recognizably theirs), tagline (their one-liner, sharpened only if theirs is empty or unclear), category, profile_summary (2-3 sentences: how this idea sits against their Compass overall — candid, no verdict words like 'proceed' or 'abandon'), why_you (why THIS person specifically could win here, or where the fit genuinely strains), market_analysis (3-4 sentences grounded in search), competitor_landscape (2-3 sentences), competitors (array of exactly 3 objects: { name, what_they_do, strength, weakness, your_edge } — real companies or precisely described substitute types, never invented names), success_likelihood (integer 0-100, a genuine probability for the idea as drafted), demand_score (integer 1-10), passion_score (integer 1-10, from their profile), time_to_revenue (e.g. "2-4 weeks"), startup_cost_lean, startup_cost_standard, startup_cost_full, legal_nuances (1-2 sentences), first_steps (3-5 concrete first steps as a single string with numbered lines, starting from what they already have),\nfit_results (one object per criterion in THE FIT TEST BELOW, in exactly that order and no other: { "criterion": string, "pass": true|false, "applicable": true|false, "note": "one sentence on why it passes, fails, or does not apply" }). Set "applicable": false ONLY where the criterion genuinely has no bearing on this idea — a delivery-schedule test against something nobody delivers, a camera test against a business with no audience-facing surface. It is not an escape hatch for a criterion the idea fails: a hard fail is a fail, and saying so is the useful thing. Never mark more than one as inapplicable, and never one that turns on a number you were given.\nsharper_version (2-3 sentences: the narrower or repositioned wedge where their loadout gives the strongest edge — offered, not imposed),\nconsiderations (array of 3-5 short strings: the questions they should answer or assumptions they should test before committing).`;
  return askJSON(token, system, prompt, 4500, { webSearch: true, maxSearches: 3 });
}

module.exports = { generateCompass, adviseIdea };
