const EDGE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/functions/v1/ai-proxy';

function hasKey() { return !!process.env.SUPABASE_URL; }

async function askJSON(token, system, prompt, maxTokens = 4096) {
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
      max_tokens: maxTokens
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const hint = j.similar_secret_names && j.similar_secret_names.length
      ? ' (found similar secret names: ' + j.similar_secret_names.join(', ') + ')'
      : '';
    throw new Error((j.error || ('AI proxy HTTP ' + r.status)) + hint);
  }
  let text = String(j.text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const start = Math.min(...['[', '{'].map(c => { const i = text.indexOf(c); return i === -1 ? Infinity : i; }));
  return JSON.parse(text.slice(start));
}

function profileSummaryText(q) {
  return `Founder profile:
Name: ${q.founder_name || 'Unknown'} | Age: ${q.age_range || '?'} | Work status: ${q.work_status || '?'} | Industry background: ${q.industry_field || '?'} | Location: ${q.location || '?'}
Skills: ${(q.skills || []).join(', ')} | Superpower: ${q.superpower || '?'} | Credentials: ${q.credentials || 'none listed'}
Hobbies: ${(q.hobbies || []).join(', ')} | Passionate about: ${q.passion_topic || '?'} | People ask their advice on: ${q.advice_topic || '?'}
A problem that frustrates them: ${q.problem_pain || '?'}
Energized by: ${(q.energizing_work || []).join(', ')} | Tech comfort (1-5): ${q.tech_level || '?'} | AI stance: ${q.ai_stance || '?'}
Work mode: ${q.work_mode || '?'} | Team preference: ${q.team_preference || '?'} | Risk tolerance: ${q.risk_tolerance || '?'} | Hustle mode: ${q.hustle_mode || '?'}
Budget: ${q.launch_budget || '?'} | Runway: ${q.runway || '?'} | Year-1 income goal: ${q.income_year1 || '?'} | Hours/week: ${q.hours_per_week || '?'}
Has an idea already: ${q.has_idea || 'no'}${q.idea_description ? ' — ' + q.idea_description : ''}
Preferred business models: ${(q.biz_models || []).join(', ')} | Deal breakers: ${(q.deal_breakers || []).join(', ')}
Competition appetite: ${q.competition_preference || 'no preference'} (niche = less competition but smaller market; mainstream = proven demand but crowded)
Prior business attempts: ${q.prior_attempts || 'none mentioned'} | Biggest obstacle they expect: ${q.biggest_obstacle || '?'}
Target customer preference: ${q.target_customer || 'no preference'} | Sales comfort (1-5): ${q.sales_comfort || '?'} | Marketing comfort (1-5): ${q.marketing_comfort || '?'}
Core motivation: ${q.motivation || '?'}
Ideal day: ${q.ideal_day || '?'} | Would regret not trying: ${q.regret || '?'} | Biggest fear: ${q.biggest_fear || '?'}`;
}

async function generateIdeas(token, q) {
  const system = 'You are NoBossly, an expert startup advisor who matches aspiring founders with viable, realistic business ideas tailored to their skills, constraints, and personality.';
  const prompt = `${profileSummaryText(q)}

Generate exactly 4 tailored business ideas for this founder. Honor their competition appetite: if they prefer niche, favor underserved niches; if mainstream, favor proven markets with a differentiation angle. Return a JSON array where each element has these string fields unless noted:
name, tagline, category, profile_summary (2-3 sentences on why this fits their profile), why_you (why THIS founder specifically), market_analysis (3-4 sentences), competitor_landscape (2-3 sentences), success_likelihood (integer 0-100), demand_score (integer 1-10), passion_score (integer 1-10), time_to_revenue (e.g. "2-4 weeks"), startup_cost_lean (e.g. "$0-100"), startup_cost_standard, startup_cost_full, legal_nuances (1-2 sentences), first_steps (3-5 concrete first steps as a single string with numbered lines).
If the founder already has an idea, make idea #1 a refined version of it.`;
  return askJSON(token, system, prompt, 8000);
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
gtm_strategy (3-4 sentences), gtm_first_customer (how to land customer #1), gtm_channels (array of {channel, why, effort}), gtm_week1_actions (array of 5-7 strings).`;
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

module.exports = { generateIdeas, generateBlueprint, generateSprintTasks, generateMilestones, generateChallenges, generateBudget, budgetInsights, hasKey };
