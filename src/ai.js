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
    ['Business name', q.biz_name], ['Website', q.biz_url], ['What it sells', q.biz_description],
    ['Everything they offer (their own words)', q.biz_offerings],
    ['What people wrongly assume about it', q.biz_misconceptions],
    ['Leading non-revenue metric and trend', q.biz_traction_metric],
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

// --- website reading ---------------------------------------------------------
// A business name alone is a trap: "EnRoute Jobs" reads as a generic job board
// unless you look at the actual site. We fetch it server-side rather than relying
// on the model's search finding it, since a small or new site may not be indexed.

// Block anything pointing back inside the network — the URL comes from a user.
const BLOCKED_HOST = /^(localhost$|.*\.local$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i;

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || '';
  const og = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i) || [])[1] || '';
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'").replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return [
    title && 'Page title: ' + title.trim(),
    (desc || og) && 'Meta description: ' + (desc || og).trim(),
    body
  ].filter(Boolean).join('\n');
}

// Pages worth reading beyond the homepage. A multi-segment business rarely puts
// every offering on its landing page — the segment that gets missed is exactly the
// one the analysis then judges the company for not having.
const PAGE_HINTS = /(about|how-it-works|how_it_works|howitworks|services|what-we-do|pricing|faq|employers?|seekers?|candidates?|jobs?|for-|our-story|solutions)/i;

function sameSiteLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];
  const re = /<a[^>]+href=["']([^"'>]+)["']/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 300) {
    let u;
    try { u = new URL(m[1], base); } catch (_) { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.hostname !== base.hostname) continue;
    u.hash = ''; u.search = '';
    const href = u.toString().replace(/\/$/, '');
    if (href === base.toString().replace(/\/$/, '')) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|css|js)$/i.test(u.pathname)) continue;
    if (!PAGE_HINTS.test(u.pathname)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

async function fetchPage(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'NoBosslyBot/1.0 (+https://nobossly.com)', 'Accept': 'text/html,text/plain' }
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    if (!/text\/html|text\/plain/i.test(r.headers.get('content-type') || '')) return null;
    const html = (await r.text()).slice(0, 400000);
    return { url: r.url || url, html, text: htmlToText(html) };
  } catch (_) {
    return null;
  }
}

async function fetchSite(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : 'https://' + rawUrl.trim()); }
  catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (BLOCKED_HOST.test(u.hostname) || !u.hostname.includes('.')) return null;

  const home = await fetchPage(u.toString());
  if (!home || home.text.length < 40) return null;

  // Read a few of the most descriptive inner pages in parallel, bounded so a slow
  // site can't stall generation.
  let extras = [];
  try {
    const links = sameSiteLinks(home.html, home.url).slice(0, 4);
    const pages = await Promise.all(links.map(l => fetchPage(l)));
    extras = pages.filter(pg => pg && pg.text.length > 80);
  } catch (_) { /* homepage alone is still useful */ }

  const parts = [`--- ${home.url} ---\n${home.text.slice(0, 5000)}`];
  extras.forEach(pg => parts.push(`--- ${pg.url} ---\n${pg.text.slice(0, 2000)}`));

  return {
    url: home.url,
    pagesRead: 1 + extras.length,
    text: parts.join('\n\n').slice(0, 12000)
  };
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

  const site = path === 'existing' ? await fetchSite(q.biz_url) : null;
  const siteBlock = site
    ? `

THEIR WEBSITE, ${site.pagesRead} page(s) fetched moments ago starting from ${site.url}. This is what the business actually is — trust it over anything the company name might suggest:
"""
${site.text}
"""`
    : (path === 'existing' && val(q.biz_url)
      ? `

The founder gave the website ${val(q.biz_url)} but it could not be read automatically. Try to find it via search before drawing any conclusion about what they do.`
      : '');

  const misread = val(q.biz_misconceptions)
    ? `
WHAT PEOPLE GET WRONG ABOUT IT, in the founder's words: ${val(q.biz_misconceptions)}
Do not repeat that mistake.`
    : '';

  const subject = path === 'existing'
    ? `An existing business the founder actually runs.
Business name: ${val(q.biz_name)}
Website: ${val(q.biz_url) || 'not given'}
What the founder says it sells: ${val(q.biz_description)}
Everything the founder says they offer: ${val(q.biz_offerings) || 'not itemized'}${misread}
Model: ${val(q.biz_model)} | Serves: ${val(q.target_customer)} | Based in: ${val(q.location)}
Monthly revenue: ${val(q.biz_revenue_monthly) || 'unstated'} | Trend: ${val(q.biz_trend) || 'unstated'}
Leading non-revenue metric: ${val(q.biz_traction_metric) || 'not given'}
Where the founder says they're stuck: ${val(q.biz_whats_stuck) || 'unstated'}${siteBlock}`
    : `A business idea: ${val(q.idea_description)}
Problem it solves: ${val(q.idea_problem)} | First customer: ${val(q.idea_customer)}
How it would make money: ${val(q.idea_monetization)} | Based in: ${val(q.location)}
Competitors the founder already named: ${val(q.idea_known_competitors) || 'none named'}`;

  const system = 'You are NoBossly\'s market analyst. You use web search to establish the current state of a market. Every claim must come from something you actually found in search results or in material you were given — never invent statistics, company names, or sources. You never infer what a company does from its name; you check. Thin evidence stated plainly is worth more than confident filler.';

  const existingTask = `First establish what THIS SPECIFIC business actually is. Read every page of website text above closely, and search for the exact business name and for its website domain to find any real public footprint — listings, coverage, reviews, social profiles, competitors naming it.

Do not guess the business model from the company name, and do not collapse the business into the nearest well-known category. A name that resembles a familiar category usually is not that category, and assessing the wrong market makes the entire analysis worthless.

Enumerate EVERY distinct offering, audience, and segment the site and the founder describe — every job type, worker situation, location arrangement, and customer side. A business serving several segments is not the same business as one serving only the most obvious segment, and judging it on the obvious one alone is the single most common way this analysis goes wrong. If the founder lists offerings you cannot verify on the site, still include them and note they are unverified rather than dropping them.

Then assess the market the business is genuinely in, across all of its segments.`;

  const ideaTask = 'Assess the current state of the market this idea would be entering.';

  const businessField = path === 'existing'
    ? '1-2 sentences on what this specific company actually does, per its own site and anything you found — its real niche, not the category its name suggests'
    : 'one sentence restating the idea in concrete terms';
  const visibilityField = path === 'existing'
    ? 'one sentence on how findable it is publicly — what you actually found, or plainly that you found little or nothing'
    : 'one sentence on how crowded the space already looks';

  const prompt = `${subject}

${path === 'existing' ? existingTask : ideaTask}

Return a compact JSON object:
{ "business": "${businessField}",
  "segments": [${path === 'existing' ? '"each distinct offering, audience, or job type this business actually serves — one short phrase each, covering all of them, not just the headline one"' : '"the one or two segments this idea would serve"'}],
  "visibility": "${visibilityField}",
  "demand": "2-3 sentences on real, current demand in that market — growing, flat, or shrinking, and on what evidence",
  "competitors": [ { "name": "a real, named company or product competing with what this business ACTUALLY does", "note": "one sentence on what they offer and where they are weak" } ],
  "openings": ["2-4 specific gaps or underserved segments you actually found"],
  "risks": ["2-4 real headwinds — saturation, price pressure, regulation, platform dependence, seasonality"],
  "sources": ["the named sources you drew on"] }
Include 3-5 competitors. Keep every field short. If the evidence is thin or mixed, say so plainly rather than filling the gap. Finding little public information about a small business is normal and is not by itself evidence that the business is failing.`;

  return askJSON(token, system, prompt, 2000, { webSearch: true, maxSearches: path === 'existing' ? 5 : 4 });
}

// --- idea generation ---------------------------------------------------------

const IDEA_JSON_SPEC = `Return a JSON array (no wrapper object) where each element has these string fields unless noted:
name, tagline, category, profile_summary (2-3 sentences on why this fits their situation), why_you (why THIS founder specifically), market_analysis (3-4 sentences), competitor_landscape (2-3 sentence overview of the competitive space), competitors (see below), success_likelihood (integer 0-100), demand_score (integer 1-10), passion_score (integer 1-10), time_to_revenue (e.g. "2-4 weeks"), startup_cost_lean (e.g. "$0-100"), startup_cost_standard, startup_cost_full, legal_nuances (1-2 sentences), first_steps (3-5 concrete first steps as a single string with numbered lines).

"competitors" is an array of exactly 3 objects, each with these string fields:
  name: a real, specific competitor or close substitute this founder would actually be up against — name a real company, product, or service where possible, not a generic category;
  what_they_do: one sentence on their offering and who they serve;
  strength: one sentence on their main advantage (what they do well);
  weakness: one sentence on a real gap, blind spot, or underserved segment;
  your_edge: one sentence on how THIS founder can realistically win against or differentiate from them, grounded in their specific skills, angle, or target niche.
Be honest and specific. If the space is crowded, reflect that with strong competitors; if it's wide open, name the closest substitutes people use today. Never invent fake company names — if unsure of a specific name, describe the competitor type precisely instead.
success_likelihood is a genuine probability, not a motivational number. A weak option should score low.`;

const EXISTING_JUDGEMENT = `How to judge this business fairly:
- Analyze every segment it actually serves, not just the most recognizable one. If the market scan lists several segments, your market_analysis and competitors must reflect all of them. Writing the business off because the most obvious segment is crowded, while ignoring the segments that are not, is a failure of analysis.
- If it is a marketplace, network, or two-sided business, weigh the leading indicator the founder is actually moving — supply, audience, or demand growth — rather than early revenue. Chicken-and-egg sequencing means one side is deliberately built before money arrives; pre-revenue during that phase is the expected path, not evidence of failure. Where the founder gave a non-revenue metric with a trend, cite the actual numbers and reason about the rate of change.
- Do not invent kill criteria or arbitrary revenue deadlines. If you propose a decision gate, tie it to the metric the founder is genuinely growing, give a horizon realistic for this type of business, and say what result would justify continuing. Never recommend shutting a business down on a short revenue window while its non-revenue traction is compounding.
- Be honest about real problems, and be equally honest about real progress. Candour cuts both ways: overstating the odds is a failure, and so is dismissing a business you have not correctly identified.`;

// The four options are produced by two calls of two, run in parallel. One call
// writing all four ran past the edge function's 150s wall clock limit (which is
// a hard ceiling on worker lifetime — streaming and keepalives do not extend it).
// Two halves finish in roughly 50-70s each, and running them together means the
// founder waits less than before rather than more.
const BRIEFS = {
  existing: [
    `This founder already runs the business described above. Ground your read in the live market scan where one is given.

Return exactly 2 strategic paths, in this order:
1. Their current business, analyzed honestly. Use their business name for "name". "success_likelihood" is your genuine probability that continuing on this exact path reaches their 12-month goal. Open "profile_summary" with a one-word verdict — "Double down", "Optimize", or "Pivot" — then the reasoning behind it.
2. A sharpened version of the same business: same customers or same capability, but repositioned, repriced, or narrowed specifically to break the bottleneck they described.

"first_steps" must start from where they actually are, not from zero — reference their real revenue, customers, pricing, and channels wherever they gave them. Weigh their stated openness to changing direction, but do not let it soften the verdict: if the honest read is that the current path is capped, say so plainly in option 1.

${EXISTING_JUDGEMENT}`,

    `This founder already runs the business described above. Ground your read in the live market scan where one is given.

Another analyst is separately covering their current business as-is and a sharpened version of it, so do NOT return either of those. Return exactly 2 alternative directions, in this order:
1. An adjacent pivot that reuses their existing customers, skills, channels, or assets in a market with stronger demand.
2. A clean-break option worth weighing if the current path turns out to be capped.

"first_steps" must start from what they already have — their customers, skills, channels, and revenue — rather than from zero. Be honest about switching costs: if leaving their current market would waste a real advantage they hold, say so.

${EXISTING_JUDGEMENT}`
  ],
  idea: [
    `This founder has the idea described above but has not built a business around it yet. Ground your read in the live market scan where one is given.

Return exactly 2 options, in this order:
1. Their idea, stacked against what the market actually wants right now. Keep the concept recognizable, but correct it where the evidence points somewhere else. "market_analysis" must state plainly where their idea lines up with real demand and where it doesn't. "success_likelihood" is your honest read on the idea as they described it.
2. The same idea narrowed to the wedge where their background gives them a genuine edge — smaller, sharper, faster to win.

"why_you" must tie back to their specific background, credentials, and unfair advantage. Engage with the competitors they already named where relevant, and test their claimed differentiator rather than repeating it. If the idea is chasing a shrinking, crowded, or thin market, say so in option 1 instead of softening it.`,

    `This founder has the idea described above but has not built a business around it yet. Ground your read in the live market scan where one is given.

Another analyst is separately covering their idea as stated and a narrowed version of it, so do NOT return either of those. Return exactly 2 adjacent options, in this order:
1. A higher-demand play in the same space that their skills, credentials, and customer access already support.
2. A different angle on the same underlying customer problem.

Both must be clearly distinct from the founder's idea as they described it. "why_you" must tie back to their specific background, credentials, and unfair advantage.`
  ],
  exploring: [
    `Generate exactly 2 tailored business ideas for this founder, chosen for the fastest realistic path to a first paying customer using skills and assets they already have. Honor their competition appetite. Respect their deal breakers and the industries they want to avoid — do not propose anything that violates either. Both must fit inside their available hours and budget.`,

    `Generate exactly 2 tailored business ideas for this founder. Another analyst is separately covering the fastest-to-revenue options built on their existing skills, so aim elsewhere: favor ideas with more leverage or a larger ceiling — productized, audience-based, or recurring-revenue models — that their background still supports. Honor their competition appetite, respect their deal breakers and the industries they want to avoid, and keep both within their available hours and budget. The two must use different business models from each other.`
  ]
};

// The model occasionally wraps the array in an object; accept the common shapes.
function toIdeaArray(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.ideas)) return v.ideas;
  if (v && Array.isArray(v.options)) return v.options;
  if (v && Array.isArray(v.paths)) return v.paths;
  if (v && typeof v === 'object' && v.name) return [v];
  return [];
}

async function generateIdeas(token, q, opts = {}) {
  const path = pathOf(q);
  const system = 'You are NoBossly, an expert startup advisor who matches founders with viable, realistic business paths tailored to their skills, constraints, and personality. You are candid — a founder is better served by an honest read on their odds than by encouragement.';
  const scan = opts.scan
    ? '\n\nLIVE MARKET SCAN (web search run moments ago, including a read of the founder\'s own website where they gave one — treat this as the current state of the market and ground your market_analysis, competitors, demand_score and success_likelihood in it). Where it contains a "business" field, that is the verified description of what this company actually does: use it, and do not substitute your own assumption based on the company name. Where it contains "segments", the business serves all of them:\n'
      + JSON.stringify(opts.scan)
    : '';
  const profile = profileSummaryText(q);

  const halves = await Promise.allSettled(BRIEFS[path].map(brief =>
    askJSON(token, system, `${profile}${scan}

${brief}

${IDEA_JSON_SPEC}`, 4500)
  ));

  const ideas = [];
  const errors = [];
  halves.forEach(h => {
    if (h.status === 'fulfilled') ideas.push(...toIdeaArray(h.value));
    else errors.push((h.reason && h.reason.message) || String(h.reason));
  });
  // Half a set beats an error page: only fail if both halves came back empty.
  if (!ideas.length) throw new Error(errors[0] || 'the AI returned no usable ideas. Please try again.');
  if (errors.length) console.error('idea generation partial failure:', errors.join(' | '));
  return ideas;
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

If the founder is already trading, build from their current traction rather than from zero, and follow these rules:
- Serve every segment the business actually has. If the profile lists several offerings, audiences, or job types, the positioning, ideal customer and pricing must account for all of them rather than only the most obvious one.
- If it is a marketplace or two-sided business, respect the sequencing: name which side is being built first and why, and do not price or plan as though both sides are already liquid.
- Ground projections in the founder's real current numbers, including any non-revenue metric they gave and its trend. State the assumption behind each projection so it can be checked. Do not present a projection as a target the founder must hit to justify continuing.
- Keep every field under 200 characters where it will be displayed as a label or chip: revenue_type, icp_archetype, pricing tier names and prices. Put the reasoning in the prose fields, not in the short ones.`;
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
