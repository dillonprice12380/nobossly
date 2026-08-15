const EDGE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/ai-proxy';

function hasKey() { return !!process.env.SUPABASE_URL; }

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
  // Read as text first: a body that isn't valid JSON means the response was cut
  // off in transit, which is a different fault from the model returning prose.
  const raw = await r.text();
  let j = {};
  let bodyParsed = true;
  try { j = raw ? JSON.parse(raw) : {}; } catch (_) { bodyParsed = false; }

  if (!r.ok || j.error) {
    // 546/504 mean the edge function was killed at its 150s request limit, not that
    // anything is broken. Say so plainly instead of surfacing a bare status code.
    if (r.status === 546 || r.status === 504) {
      throw new Error('the AI request ran past the server time limit. Please try again — it usually goes through on a second attempt.');
    }
    const hint = j.similar_secret_names && j.similar_secret_names.length
      ? ' (found similar secret names: ' + j.similar_secret_names.join(', ') + ')'
      : '';
    throw new Error((j.error || ('AI proxy HTTP ' + r.status)) + hint);
  }
  if (!bodyParsed) {
    throw new Error('the AI response was cut off in transit after ' + raw.length + ' bytes. Please try again.');
  }
  let text = String(j.text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  if (!text) throw new Error('the AI returned an empty response. Please try again.');
  const start = Math.min(...['[', '{'].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start === Infinity || end === -1) throw new Error('AI returned no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

// --- profile summarizing -----------------------------------------------------
// Lines with no answer are dropped entirely rather than rendered as "?", so the
// model never treats a skipped question as a meaningful signal.

const val = v => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return String(v).trim();
};

function lines(pairs) {
  return pairs.map(([k, v]) => { const s = val(v); return s ? k + ': ' + s : null; }).filter(Boolean).join('\n');
}

function pathOf(q) {
  return (q && (q.founder_path === 'existing' || q.founder_path === 'idea')) ? q.founder_path : 'exploring';
}

function founderCore(q) {
  return lines([
    ['Name', q.founder_name], ['Age', q.age_range], ['Work status', q.work_status],
    ['Industry background', q.industry_field], ['Location', q.location],
    ['Skills', q.skills], ['Superpower', q.superpower], ['Credentials', q.credentials],
    ['Unfair advantage', q.unfair_advantage], ['Assets already in hand', q.existing_assets],
    ['Hours per week available', q.hours_per_week], ['Money available', q.launch_budget],
    ['Financial runway', q.runway], ['Income goal', q.income_year1],
    ['Risk tolerance', q.risk_tolerance], ['Hustle mode', q.hustle_mode],
    ['Sales comfort (1-5)', q.sales_comfort], ['Marketing comfort (1-5)', q.marketing_comfort],
    ['Deal breakers', q.deal_breakers], ['Core motivation', q.motivation]
  ]);
}

function existingBlock(q) {
  return 'CURRENT BUSINESS (this founder is already trading):\n' + lines([
    ['Business name', q.biz_name], ['What it sells', q.biz_description],
    ['Stage', q.biz_stage], ['Time running', q.biz_age], ['Model', q.biz_model],
    ['Serves', q.target_customer], ['Monthly revenue', q.biz_revenue_monthly],
    ['Revenue trend', q.biz_trend], ['Profitability', q.biz_profitability],
    ['Paying customers to date', q.biz_customer_count], ['Pricing', q.biz_pricing],
    ['Acquisition channels in use', q.biz_channels], ['Best-performing channel', q.biz_best_channel],
    ['What is working', q.biz_whats_working], ['Where they are stuck', q.biz_whats_stuck],
    ['Self-identified growth blocker', q.biz_growth_blocker],
    ['Openness to changing direction', q.biz_pivot_openness],
    ['12-month goal for the business', q.biz_goal_12mo],
    ['Competition appetite', q.competition_preference]
  ]);
}

function ideaBlock(q) {
  return 'THEIR IDEA (not yet a business):\n' + lines([
    ['The idea', q.idea_description], ['Stage', q.idea_stage],
    ['Problem it solves', q.idea_problem], ['First customer they would target', q.idea_customer],
    ['How it would make money', q.idea_monetization], ['Why now', q.idea_why_now],
    ['Validation done so far', q.idea_validation],
    ['Competitors they already know of', q.idea_known_competitors],
    ['Their claimed differentiator', q.idea_differentiator],
    ['The assumption that would sink it if wrong', q.idea_biggest_unknown],
    ['Existing access to those customers', q.customer_access],
    ['Target customer preference', q.target_customer],
    ['Competition appetite', q.competition_preference]
  ]);
}

function exploringBlock(q) {
  return 'NO IDEA YET — this founder is starting from a blank page.\n' + lines([
    ['Hobbies', q.hobbies], ['Passionate about', q.passion_topic],
    ['People ask their advice on', q.advice_topic],
    ['A problem that frustrates them', q.problem_pain],
    ['Energized by', q.energizing_work], ['Tech comfort (1-5)', q.tech_level],
    ['AI stance', q.ai_stance], ['Work mode', q.work_mode], ['Team preference', q.team_preference],
    ['Appetite for learning new skills', q.learning_appetite],
    ['Preferred business models', q.biz_models],
    ['Industries to avoid', q.avoid_industries],
    ['Competition appetite', q.competition_preference],
    ['Prior business attempts', q.prior_attempts],
    ['Biggest obstacle they expect', q.biggest_obstacle],
    ['Target customer preference', q.target_customer],
    ['What success looks like in a year', q.success_definition],
    ['Ideal day', q.ideal_day], ['Would regret not trying', q.regret], ['Biggest fear', q.biggest_fear]
  ]);
}

function profileSummaryText(q) {
  const path = pathOf(q);
  const block = path === 'existing' ? existingBlock(q) : path === 'idea' ? ideaBlock(q) : exploringBlock(q);
  return 'Founder profile:\n' + founderCore(q) + '\n\n' + block;
}

// --- market scan -------------------------------------------------------------
// Web search and idea generation used to happen in one call, which ran ~150s and
// tripped the edge function's request limit. They're split now: a short search
// pass first, then generation with those findings pasted in. Each stays well
// inside the limit, and a failed scan degrades to an ungrounded generation
// rather than killing the whole run.

async function marketScan(token, q) {
  const path = pathOf(q);
  if (path === 'exploring') return null;
  const subject = path === 'existing'
    ? `An existing business: ${val(q.biz_name)} — ${val(q.biz_description)}
Model: ${val(q.biz_model)} | Serves: ${val(q.target_customer)} | Based in: ${val(q.location)}
Monthly revenue: ${val(q.biz_revenue_monthly) || 'unstated'} | Trend: ${val(q.biz_trend) || 'unstated'}
Where the founder says they're stuck: ${val(q.biz_whats_stuck) || 'unstated'}`
    : `A business idea: ${val(q.idea_description)}
Problem it solves: ${val(q.idea_problem)} | First customer: ${val(q.idea_customer)}
How it would make money: ${val(q.idea_monetization)} | Based in: ${val(q.location)}
Competitors the founder already named: ${val(q.idea_known_competitors) || 'none named'}`;

  const system = 'You are NoBossly\'s market analyst. You use web search to establish the current state of a market. Every claim must come from something you actually found in search results — never invent statistics, company names, or sources. Thin evidence stated plainly is worth more than confident filler.';
  const prompt = `${subject}

Search the web for the current state of this market. Return a compact JSON object:
{ "demand": "2-3 sentences on real, current demand — growing, flat, or shrinking, and on what evidence",
  "competitors": [ { "name": "a real, named company or product", "note": "one sentence on what they offer and where they're weak" } ],
  "openings": ["2-4 specific gaps or underserved segments you actually found"],
  "risks": ["2-4 real headwinds — saturation, price pressure, regulation, platform dependence, seasonality"],
  "sources": ["the named sources you drew on"] }
Include 3-5 competitors. Keep every field short. If the evidence is thin or mixed, say that in "demand" rather than filling the gap.`;
  return askJSON(token, system, prompt, 1800, { webSearch: true, maxSearches: 4 });
}

// --- idea generation ---------------------------------------------------------

const IDEA_JSON_SPEC = `Return a JSON array where each element has these string fields unless noted:
name, tagline, category, profile_summary (2-3 sentences on why this fits their situation), why_you (why THIS founder specifically), market_analysis (3-4 sentences), competitor_landscape (2-3 sentence overview of the competitive space), competitors (see below), success_likelihood (integer 0-100), demand_score (integer 1-10), passion_score (integer 1-10), time_to_revenue (e.g. "2-4 weeks"), startup_cost_lean (e.g. "$0-100"), startup_cost_standard, startup_cost_full, legal_nuances (1-2 sentences), first_steps (3-5 concrete first steps as a single string with numbered lines).

"competitors" is an array of exactly 3 objects, each with these string fields:
  name: a real, specific competitor or close substitute this founder would actually be up against — name a real company, product, or service where possible, not a generic category;
  what_they_do: one sentence on their offering and who they serve;
  strength: one sentence on their main advantage (what they do well);
  weakness: one sentence on a real gap, blind spot, or underserved segment;
  your_edge: one sentence on how THIS founder can realistically win against or differentiate from them, grounded in their specific skills, angle, or target niche.
Be honest and specific. If the space is crowded, reflect that with strong competitors; if it's wide open, name the closest substitutes people use today. Never invent fake company names — if unsure of a specific name, describe the competitor type precisely instead.
success_likelihood is a genuine probability, not a motivational number. A weak option should score low.`;

const BRIEF_EXISTING = `This founder already runs the business described above. Ground your read in the live market scan where one is given.

Return exactly 4 strategic paths, in this order:
1. Their current business, analyzed honestly. Use their business name for "name". "success_likelihood" is your genuine probability that continuing on this exact path reaches their 12-month goal. Open "profile_summary" with a one-word verdict — "Double down", "Optimize", or "Pivot" — then the reasoning behind it.
2. A sharpened version of the same business: same customers or same capability, but repositioned, repriced, or narrowed specifically to break the bottleneck they described.
3. An adjacent pivot that reuses their existing customers, skills, channels, or assets in a market with stronger demand.
4. A clean-break option worth weighing if the current path turns out to be capped.

"first_steps" must start from where they actually are, not from zero — reference their real revenue, customers, pricing, and channels wherever they gave them. Weigh their stated openness to changing direction, but do not let it soften the verdict: if the honest read is that the current path is capped, say so plainly in option 1.`;

const BRIEF_IDEA = `This founder has the idea described above but has not built a business around it yet. Ground your read in the live market scan where one is given.

Return exactly 4 options, in this order:
1. Their idea, stacked against what the market actually wants right now. Keep the concept recognizable, but correct it where the evidence points somewhere else. "market_analysis" must state plainly where their idea lines up with real demand and where it doesn't. "success_likelihood" is your honest read on the idea as they described it.
2. The same idea narrowed to the wedge where their background gives them a genuine edge — smaller, sharper, faster to win.
3. A higher-demand play in the same space that their skills, credentials, and customer access already support.
4. A different angle on the same underlying customer problem.

"why_you" must tie back to their specific background, credentials, and unfair advantage — the differentiation is the point here. Engage with the competitors they already named where relevant, and test their claimed differentiator rather than repeating it. If the idea is chasing a shrinking, crowded, or thin market, say so in option 1 instead of softening it.`;

const BRIEF_EXPLORING = `Generate exactly 4 tailored business ideas for this founder. Honor their competition appetite: if they prefer niche, favor underserved niches; if mainstream, favor proven markets with a clear differentiation angle. Respect their deal breakers and the industries they want to avoid — do not propose anything that violates either. Favor ideas that lean on assets they already have and that fit inside their available hours and budget. Spread the four across different business models rather than four variations on one theme.`;

async function generateIdeas(token, q, opts = {}) {
  const path = pathOf(q);
  const system = 'You are NoBossly, an expert startup advisor who matches founders with viable, realistic business paths tailored to their skills, constraints, and personality. You are candid — a founder is better served by an honest read on their odds than by encouragement.';
  const brief = path === 'existing' ? BRIEF_EXISTING : path === 'idea' ? BRIEF_IDEA : BRIEF_EXPLORING;
  const scan = opts.scan
    ? '\n\nLIVE MARKET SCAN (web search run moments ago — treat this as the current state of the market and ground your market_analysis, competitors, demand_score and success_likelihood in it):\n'
      + JSON.stringify(opts.scan)
    : '';
  const prompt = `${profileSummaryText(q)}${scan}

${brief}

${IDEA_JSON_SPEC}`;
  return askJSON(token, system, prompt, 8000);
}

// Live demand evidence for a generated idea. Uses server-side web search via the
// ai-proxy edge function (web_search flag) to find named, real-world signals.
async function demandEvidence(token, idea) {
  const system = 'You are NoBossly\'s market research analyst. You use web search to find real, current demand evidence for business ideas. Every signal must come from something you actually found in search results — never invent statistics, sources, or discussions. Honest, evidence-grounded reads build founder trust; thin evidence stated plainly is more valuable than inflated claims.';
  const prompt = `Business idea: ${idea.name} — ${idea.tagline || ''}
Category: ${idea.category || ''}
Market context: ${idea.market_analysis || ''}

Search the web for real, current demand evidence for this idea. Look for:
- Community discussions (Reddit, forums, Facebook groups) where people express this need or pain
- Search or trend data indicating rising or steady interest
- Recent market size, growth, or spending statistics
- Gaps that existing competitors leave open

Return a JSON object:
{ "signals": [ { "type": "community" | "trend" | "market" | "competitor_gap", "claim": "one specific sentence stating the evidence in your own words", "source": "where you found it (e.g. r/sweatystartup, Exploding Topics, IBISWorld, a named publication)", "strength": "strong" | "moderate" | "weak" } ], "verdict": "2-3 sentence honest read on real-world demand, including any weak spots or risks the evidence revealed" }
Include 3-6 signals. Only include signals backed by something you actually found. If the evidence is thin or mixed, say so plainly in the verdict.`;
  return askJSON(token, system, prompt, 3000, { webSearch: true, maxSearches: 6 });
}

async function generateBlueprint(token, idea, q) {
  const system = 'You are NoBossly, an expert startup strategist who creates actionable launch blueprints.';
  const prompt = `${profileSummaryText(q)}

Chosen business idea: ${idea.name} — ${idea.tagline}
Category: ${idea.category}
Why them: ${idea.why_you}
Market: ${idea.market_analysis}

Create a launch blueprint as a JSON object with fields:
business_name (string), tagline (string), positioning (2-3 sentences), elevator_pitch (string),
icp_archetype (short label), icp_description (2-3 sentences), icp_demographics (array of strings), icp_motivations (array of strings), icp_pain_points (array of strings), icp_watering_holes (array of strings - where to find them),
revenue_type (string), revenue_rationale (2 sentences), pricing_tiers (array of {name, price, includes}),
projection_month3 (string like "$500 MRR"), projection_month6 (string), projection_month12 (string),
differentiators (array of strings), roadmap_summary (3-4 sentences),
gtm_strategy (3-4 sentences), gtm_first_customer (how to land customer #1), gtm_channels (array of {channel, why, effort}), gtm_week1_actions (array of 5-7 strings).
If the founder is already trading, build from their current traction rather than from zero.`;
  return askJSON(token, system, prompt, 6000);
}

async function generateSprintTasks(token, blueprint, sprintNumber) {
  const system = 'You are NoBossly, a startup execution coach who breaks launches into focused weekly sprints.';
  const prompt = `Business: ${blueprint.business_name} — ${blueprint.tagline}
Positioning: ${blueprint.positioning}
GTM: ${blueprint.gtm_strategy}
Week-1 actions: ${JSON.stringify(blueprint.gtm_week1_actions)}

This is Sprint #${sprintNumber} (7 days). Return a JSON object:
{ "theme": "short sprint theme", "goal": "one-sentence sprint goal", "tasks": [ { "title": "...", "description": "1-2 sentences", "priority": "high"|"medium"|"low" } ] }
Include 6-9 tasks ordered by priority. Sprint 1 should focus on validation and first steps; later sprints build on momentum.`;
  return askJSON(token, system, prompt, 4000);
}

function blueprintContext(bp) {
  return `Business: ${bp.business_name || ''} — ${bp.tagline || ''}
Positioning: ${bp.positioning || ''}
Ideal customer: ${bp.icp_archetype || ''} — ${bp.icp_description || ''}
Revenue model: ${bp.revenue_type || ''}
Roadmap: ${bp.roadmap_summary || ''}
Go-to-market: ${bp.gtm_strategy || ''}
First customer plan: ${bp.gtm_first_customer || ''}
Week-1 actions: ${JSON.stringify(bp.gtm_week1_actions || [])}
Projections: 3mo ${bp.projection_month3 || '?'}, 6mo ${bp.projection_month6 || '?'}, 12mo ${bp.projection_month12 || '?'}`;
}

async function generateMilestones(token, bp) {
  const system = 'You are NoBossly, a startup coach who turns a founder\'s launch blueprint into meaningful, personalized milestones that mark real progress.';
  const prompt = `${blueprintContext(bp)}

Create 7 milestones tailored to THIS specific business that mark concrete moments of progress (not generic). Return a JSON array where each element has:
title (short, specific to this business), description (1 sentence on what achieving it means), emoji (a single relevant emoji), category (one of: foundation, product, revenue, traction, community, personal), xp_reward (integer between 25 and 150, larger for harder milestones).
Order them roughly from earliest to latest in the journey.`;
  return askJSON(token, system, prompt, 3000);
}

async function generateChallenges(token, bp) {
  const system = 'You are NoBossly, a startup execution coach who designs time-boxed challenges that push a founder toward their launch.';
  const prompt = `${blueprintContext(bp)}

Create 6 time-boxed challenges tailored to THIS specific business that build momentum toward launch and first revenue. Return a JSON array where each element has:
title (short, action-oriented, specific to this business), description (1-2 sentences on the challenge and why it matters), emoji (a single relevant emoji), suggested_days (one of 30, 60, 90), xp_reward (integer between 25 and 150).`;
  return askJSON(token, system, prompt, 3000);
}

async function generateBudget(token, bp) {
  const system = 'You are NoBossly, a pragmatic startup finance coach who builds lean, realistic monthly operating budgets for early-stage founders.';
  const prompt = `${blueprintContext(bp)}

Propose a lean MONTHLY startup operating budget for this specific business. Return a JSON array of 6-8 elements, each with:
category (short label, e.g. "Software & tools", "Marketing & ads", "Contractors"), monthly_limit (integer US dollars, realistic for an early-stage solo founder), rationale (1 short sentence on why this matters for THIS business).
Keep the total lean and grounded in the business model above.`;
  return askJSON(token, system, prompt, 2500);
}

async function budgetInsights(token, summary) {
  const system = 'You are NoBossly, a startup finance coach. You give concise, practical, encouraging insights on a founder\'s spending vs. their budget.';
  const prompt = `Here is the founder's current month budget and spending (USD):
${JSON.stringify(summary)}

Return a JSON object: { "summary": "2-3 sentence read on how they're doing", "tips": ["3-5 specific, actionable tips based on the numbers"] }.
Call out over-budget categories, unspent room, and lean-startup suggestions. Be specific to the numbers, not generic.`;
  return askJSON(token, system, prompt, 2000);
}

module.exports = { generateIdeas, marketScan, demandEvidence, generateBlueprint, generateSprintTasks, generateMilestones, generateChallenges, generateBudget, budgetInsights, hasKey, pathOf };
