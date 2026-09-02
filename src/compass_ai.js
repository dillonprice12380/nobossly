// Founder Compass AI. Deliberately separate from ai.js: the Compass never
// prescribes which business to start — it sharpens the founder's judgement
// (archetype, loadout, territories, fit test, avoid list, toolkit) and then
// stress-tests the idea the founder drafts THEMSELVES. The founder decides;
// the AI advises. ai.js keeps the legacy prescriptive generator untouched.

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

// Compact, lossless-enough founder profile: every answered question, keyed
// plainly, skipped questions dropped so the model never reads absence as signal.
const SKIP = new Set(['id', 'user_id', 'completed', 'created_at', 'updated_at', 'run_number', 'readiness_score', 'has_idea']);
function compactProfile(q) {
  const out = {};
  Object.keys(q || {}).forEach(k => {
    if (SKIP.has(k)) return;
    const v = q[k];
    if (v == null) return;
    if (Array.isArray(v)) { if (v.length) out[k] = v; return; }
    const s = String(v).trim();
    if (s) out[k] = Array.isArray(v) ? v : v;
  });
  return JSON.stringify(out);
}

const COMPASS_SPEC = `Return a JSON object with exactly these fields:
{ "archetype": { "name": "a memorable two-or-three word founder class, e.g. 'The Craftsman', 'The Connector', 'The Systems Thinker' — derived from THIS profile, not generic", "emoji": "one emoji", "tagline": "one punchy sentence of identity, second person", "description": "2-3 sentences on how this founder type wins and where they typically struggle, grounded in their actual answers" },
  "loadout": { "strengths": ["3-5 short phrases — skills and capabilities they actually listed"], "advantages": ["2-4 unfair advantages, credentials, assets or access they hold"], "constraints": ["2-4 binding constraints stated plainly — time, money, obligations, fears — the ones that will actually shape what they can build"], "honest_notes": ["1-3 candid observations they need to hear, respectfully — e.g. a mismatch between their income goal and their hours, or a fear that conflicts with their chosen path"] },
  "territories": [ 3-4 objects: { "name": "an opportunity ZONE, not a specific business — e.g. 'productized services for local trades', not 'start a bookkeeping service for plumbers'", "temperature": "hot"|"warm"|"steady", "why_you": "2 sentences tying this zone to their specific loadout and constraints", "example_plays": ["2-4 short example plays INSIDE the zone, phrased as possibilities to explore, never as instructions"], "watch_out": "one sentence on the main trap in this territory for someone with their profile" } ],
  "fit_test": [ exactly 5 objects: { "criterion": "a short personal pass/fail test distilled from THEIR answers — budget ceiling, weekly hours, deal breakers, fears, income need", "why": "one sentence on why this test matters for them specifically", "check": "numeric"|"boolean"|"judgment", "metric": "startup_cost"|"time_to_revenue"|null, "op": "lte"|"gte"|null, "value": number|null } ],
  "avoid_list": [ 2-3 objects: { "territory": "something tempting for someone like them", "reason": "why it conflicts with their constraints or deal breakers — plain and kind" } ],
  "toolkit": [ 4-6 objects: { "name": "a real, currently popular tool", "purpose": "what stage of their journey it serves, one short phrase", "cost": "free" | "freemium" | "paid" } ] }
Every field grounded in the profile (and market scan where given). Never invent facts. Never prescribe: territories are zones to explore and the founder chooses. Honest beats encouraging.

On fit_test "check": this says how each criterion gets DECIDED, because the ones that are really thresholds are checked by arithmetic rather than by opinion.
- "numeric" is only for the two metrics named, and only where the criterion is a genuine threshold taken from their answers. A launch-budget ceiling ("Does it start for under $800?") is metric "startup_cost", op "lte", value 800. How soon they need money ("Is it earning inside 8 weeks?") is metric "time_to_revenue", op "lte", value 8 — ALWAYS expressed in weeks, so three months is 13.
- "boolean" is a clean yes/no about the idea itself ("Can it sell without me on camera?"). "judgment" is a real call that needs reading ("Does my clinical credibility matter to this buyer?").
- For "boolean" and "judgment", set metric, op and value to null.
Aim for one or two numeric criteria where the profile genuinely supports a threshold, and never dress a judgement call up as a number — a fake threshold is worse than an honest opinion.
Return only JSON. No comments, no trailing commas.`;

const PATH_TASKS = {
  exploring: `This founder has no business idea yet. Draw their Compass so THEY can choose well: name their archetype, read their loadout back to them honestly, map 3-4 territories where their profile gives them a real edge, distill their 5-point fit test, and name what they should avoid. The Compass sharpens their judgement — it does not pick for them.`,
  idea: `This founder has an idea (in the profile) but no business yet. Draw their Compass: archetype and loadout as normal. For territories, make the FIRST territory the zone their own idea lives in — read it honestly against the market scan (temperature, real demand, the trap) — and add 2-3 adjacent territories their loadout also supports, so they choose with open eyes rather than tunnel vision. The fit test must be built so they can score their own idea against it. Never tell them whether to proceed — give them the lens.`,
  existing: `This founder already runs the business described in the profile. Draw a diagnostic Compass. Archetype and loadout as normal, informed by how they actually operate. For territories, lay out 3-4 STRATEGIC DIRECTIONS for this business — the first should be their current path sharpened (repositioned, repriced or narrowed to break the bottleneck they described), the others adjacent moves that reuse their customers, skills or channels. For each, honest temperature and tradeoffs. Judge the business fairly: analyze every segment it serves, weigh the non-revenue traction metric they gave, never invent kill criteria or revenue deadlines. Lay out the paths — the founder picks. No verdicts, no 'you should'.`
};

async function generateCompass(token, q, scan) {
  const path = (q && (q.founder_path === 'existing' || q.founder_path === 'idea')) ? q.founder_path : 'exploring';
  const system = "You are NoBossly's founder strategist. You never prescribe which business a founder should start — you sharpen their judgement so they can choose for themselves. Everything you write is grounded in their actual answers and any market scan provided. You are candid: naming a real constraint or a mismatch respectfully serves the founder better than encouragement. You speak to the founder in second person.";
  const scanBlock = scan ? '\n\nLIVE MARKET SCAN (web search run moments ago — treat as the current state of the market; where it names what the business actually is and its segments, trust that over any assumption):\n' + JSON.stringify(scan) : '';
  const prompt = 'Founder profile (their questionnaire answers, verbatim keys):\n' + compactProfile(q) + scanBlock + '\n\n' + PATH_TASKS[path] + '\n\n' + COMPASS_SPEC;
  return askJSON(token, system, prompt, 5000);
}

// Stress-test the idea the founder drafted, against their own Compass and the
// live market. Returns fields shaped for the generated_ideas row plus the
// advisor extras (fit_results, sharper_version, considerations).
async function adviseIdea(token, q, compassData, draft, fitTest) {
  const system = "You are NoBossly's advisor — the wise counsel at the founder's side, never the author of their idea. The idea below is THEIRS. Your job: stress-test it against their own fit test, their loadout, and the live market; show them exactly where it holds and where it strains; offer a sharper version they are free to ignore. Honest probabilities, real competitors (never invented), respect shown through candour. Second person throughout.";
  const prompt = 'Founder profile:\n' + compactProfile(q)
    + '\n\nTheir Founder Compass (their archetype, loadout and territories — test the idea against THIS):\n' + JSON.stringify(compassData || {})
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
    + `\n\nUse web search to ground the market read and competitors in what exists right now.\n\nReturn a JSON object with exactly these string fields unless noted:\nname (their idea's name, cleaned up but recognizably theirs), tagline (their one-liner, sharpened only if theirs is empty or unclear), category, profile_summary (2-3 sentences: how this idea sits against their Compass overall — candid, no verdict words like 'proceed' or 'abandon'), why_you (why THIS founder specifically could win here, or where the fit genuinely strains), market_analysis (3-4 sentences grounded in search), competitor_landscape (2-3 sentences), competitors (array of exactly 3 objects: { name, what_they_do, strength, weakness, your_edge } — real companies or precisely described substitute types, never invented names), success_likelihood (integer 0-100, a genuine probability for the idea as drafted), demand_score (integer 1-10), passion_score (integer 1-10, from their profile), time_to_revenue (e.g. "2-4 weeks"), startup_cost_lean, startup_cost_standard, startup_cost_full, legal_nuances (1-2 sentences), first_steps (3-5 concrete first steps as a single string with numbered lines, starting from what they already have),\nfit_results (one object per criterion in THE FIT TEST BELOW, in exactly that order and no other: { "criterion": string, "pass": true|false, "applicable": true|false, "note": "one sentence on why it passes, fails, or does not apply" }). Set "applicable": false ONLY where the criterion genuinely has no bearing on this idea — a delivery-schedule test against something nobody delivers, a camera test against a business with no audience-facing surface. It is not an escape hatch for a criterion the idea fails: a hard fail is a fail, and saying so is the useful thing. Never mark more than one as inapplicable, and never one that turns on a number you were given.\nsharper_version (2-3 sentences: the narrower or repositioned wedge where their loadout gives the strongest edge — offered, not imposed),\nconsiderations (array of 3-5 short strings: the questions they should answer or assumptions they should test before committing).`;
  return askJSON(token, system, prompt, 4500, { webSearch: true, maxSearches: 3 });
}

module.exports = { generateCompass, adviseIdea };
