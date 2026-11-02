// What each path's dashboard is made of (docs/path-dashboards.md).
//
// Step 1 holds two things per path: the setup questions (the subpath plus the
// three or four path questions that change the dashboard), and how the shared
// workspace tools rank for that path — featured, available, or tucked away in
// the library. The path's own boards, numbers and checklists join this file in
// the next steps.
//
// Every tool stays reachable from the library whatever the path: a path
// decides what is featured, never what is allowed.

const paths = require('../paths');
const { registry, pipeline, metrics, checklists } = require('../engines');
const { missing } = require('../engines/errors');
const { WORKSHEETS } = require('../workspace/worksheets');

// Every path's own dashboard (steps 2–4). Each file declares its
// boards, metrics, checklists and worksheets when it loads.
const DASHBOARDS = {
  creator: require('./creator'),
  freelancer: require('./freelancer'),
  software: require('./software'),
  exploring: require('./exploring'),
  consultant: require('./consultant'),
  local_service: require('./local_service'),
  online_store: require('./online_store'),
  physical_product: require('./physical_product'),
  brick_mortar: require('./brick_mortar')
};

// Shared workspace tools. `href` is where the tool lives; `kind` marks the
// worksheet tools stored in workspace_docs.
const TOOLS = {
  lean_canvas:           { label: 'Lean Canvas',            emoji: '🧭', href: '/workspace/docs/lean_canvas', kind: true, blurb: 'Your idea on one page: problem, customer, solution, and how it makes money.' },
  business_model_canvas: { label: 'Business Model Canvas',  emoji: '🗺️', href: '/workspace/docs/business_model_canvas', kind: true, blurb: 'The nine building blocks of how the business runs, from partners to revenue.' },
  persona:               { label: 'Customer persona',       emoji: '👤', href: '/workspace/docs/persona', kind: true, blurb: 'Who you are for — their goals, frustrations, and what would make them buy.' },
  business_plan:         { label: 'Business plan',          emoji: '📄', href: '/workspace/docs/business_plan', kind: true, blurb: 'A plan a lender, partner or you-in-six-months can read in ten minutes.' },
  idea_refiner:          { label: 'Idea refiner',           emoji: '🔬', href: '/workspace/docs/idea_refiner', kind: true, blurb: 'Score an idea honestly, find the weak spot, and pick the smallest test.' },
  elevator_pitch:        { label: 'Elevator pitch',         emoji: '🎤', href: '/workspace/docs/elevator_pitch', kind: true, blurb: 'Say what you do in 30 seconds, and keep every version as it gets sharper.' },
  goals:                 { label: 'Goals',                  emoji: '🎯', href: '/workspace/goals', blurb: 'What you are aiming for, how you will know, and the next step.' },
  milestones:            { label: 'Milestones',             emoji: '🏁', href: '/workspace/milestones', blurb: 'Mark the moments that matter, in your own words.' },
  surveys:               { label: 'Surveys',                emoji: '📋', href: '/surveys', blurb: 'Ask customers or your audience, and see the answers add up.' },
  tasks:                 { label: 'Tasks',                  emoji: '✅', href: '/tasks', blurb: 'Everything on your plate, with due dates.' },
  money:                 { label: 'Money',                  emoji: '💰', href: '/budget', blurb: 'Income, budget and expenses in one place.' },
  quit:                  { label: 'Quit-Date Planner',      emoji: '🗓️', href: '/tools/quit-date', blurb: 'The month you can afford to hand in your notice.' },
  tax:                   { label: 'Tax Set-Aside',          emoji: '🧾', href: '/tools/tax', blurb: 'What to put aside from each payment, and your quarterly estimates.' },
  pricing:               { label: 'Pricing & Margin',       emoji: '🏷️', href: '/tools/pricing', blurb: 'The rate or price you need, and the true margin after fees.' },
  proof:                 { label: 'Proof Page',             emoji: '🌟', href: '/tools/proof', blurb: 'A public page with your work, testimonials and results.' },
  interviews:            { label: 'Customer interviews',    emoji: '🎙️', href: '/tools/interviews', blurb: 'Log conversations and see which problems keep coming up.' }
};
// Worksheets a path config adds (a proposal builder, an MVP scope) become
// tools like any other — featured on their path, in the library elsewhere.
Object.values(DASHBOARDS).forEach(d => (d.worksheets || []).forEach(k => {
  const w = WORKSHEETS[k];
  TOOLS[k] = { label: w.label, emoji: w.emoji, href: '/workspace/docs/' + k, kind: true, blurb: w.blurb };
}));

// F = featured on the dashboard, A = available (listed), anything not named is
// in the library only. Order within each list is the order shown.
const PATHS = {
  creator: {
    setup: ['stage', 'platform', 'audience_size', 'monetization'],
    featured: ['persona', 'idea_refiner', 'goals', 'quit'],
    available: ['elevator_pitch', 'lean_canvas', 'surveys', 'proof', 'tax', 'money', 'tasks', 'milestones']
  },
  freelancer: {
    setup: ['stage', 'service', 'client_source', 'pricing_model'],
    featured: ['fl_proposal', 'pricing', 'persona', 'proof'],
    available: ['elevator_pitch', 'tax', 'quit', 'goals', 'money', 'tasks', 'milestones', 'lean_canvas', 'surveys']
  },
  consultant: {
    setup: ['stage', 'expertise', 'who_you_advise', 'ticket_comfort'],
    featured: ['con_offer', 'persona', 'elevator_pitch', 'proof'],
    available: ['pricing', 'surveys', 'con_lead_magnet', 'goals', 'tax', 'quit', 'money', 'tasks', 'milestones', 'lean_canvas']
  },
  local_service: {
    setup: ['stage', 'service', 'service_area', 'avg_job_value'],
    featured: ['loc_quote', 'loc_price_list', 'tax', 'money'],
    available: ['loc_equipment', 'pricing', 'goals', 'business_plan', 'persona', 'elevator_pitch', 'proof', 'tasks', 'milestones', 'quit']
  },
  brick_mortar: {
    setup: ['stage', 'venue_type', 'location_status', 'rent_capacity'],
    featured: ['business_plan', 'bm_breakeven', 'bm_startup', 'surveys'],
    available: ['bm_site_compare', 'business_model_canvas', 'persona', 'money', 'pricing', 'goals', 'tasks', 'milestones', 'lean_canvas', 'elevator_pitch', 'tax']
  },
  online_store: {
    setup: ['stage', 'product', 'goods_type', 'channel'],
    featured: ['shop_product', 'persona', 'tax', 'goals'],
    available: ['pricing', 'surveys', 'money', 'lean_canvas', 'business_plan', 'tasks', 'milestones', 'quit']
  },
  physical_product: {
    setup: ['stage', 'product', 'made_how', 'sell_where'],
    featured: ['prod_bom', 'surveys', 'persona', 'business_model_canvas'],
    available: ['prod_makers', 'business_plan', 'pricing', 'interviews', 'lean_canvas', 'money', 'goals', 'tasks', 'milestones']
  },
  software: {
    setup: ['stage', 'problem', 'can_build', 'who_pays'],
    featured: ['lean_canvas', 'sw_mvp_scope', 'interviews', 'surveys'],
    available: ['persona', 'sw_pricing', 'elevator_pitch', 'idea_refiner', 'business_plan', 'business_model_canvas', 'pricing', 'goals', 'tasks', 'milestones']
  },
  exploring: {
    setup: ['stage', 'skills', 'energizing_work'],
    featured: ['ex_inventory', 'ex_options', 'idea_refiner', 'surveys'],
    available: ['interviews', 'persona', 'goals', 'lean_canvas', 'tasks', 'milestones']
  }
};
const FALLBACK = {
  setup: [],
  featured: ['idea_refiner', 'goals', 'persona', 'lean_canvas'],
  available: ['business_model_canvas', 'business_plan', 'elevator_pitch', 'surveys', 'tasks', 'money', 'milestones']
};

const configFor = slug => PATHS[slug] || FALLBACK;

// The questions to ask right after a path is chosen, as question definitions
// from src/paths.js (the subpath question comes first, separately).
function setupQuestions(slug) {
  const own = paths.ownQuestions ? paths.ownQuestions(slug) : [];
  return configFor(slug).setup.map(name => own.find(q => q.name === name)).filter(Boolean);
}

// The workspace for a path: featured, then available, then the rest.
function workspaceFor(slug) {
  const c = configFor(slug);
  const named = new Set(c.featured.concat(c.available));
  const as = (keys, rank) => keys.filter(k => TOOLS[k]).map(k => Object.assign({ key: k, rank }, TOOLS[k]));
  return {
    featured: as(c.featured, 'featured'),
    available: as(c.available, 'available'),
    library: as(Object.keys(TOOLS).filter(k => !named.has(k)), 'library')
  };
}

// Whether a member has answered the setup for their path yet.
function needsSetup(profile) {
  if (!profile || !profile.path || !PATHS[profile.path]) return false;
  const hasSub = (paths.subpathsOf(profile.path) || []).length ? !!profile.subpath : true;
  const answers = profile.path_answers;
  const answered = answers && typeof answers === 'object' && Object.keys(answers).length > 0;
  return !hasSub || (Object.prototype.hasOwnProperty.call(profile, 'path_answers') && !answered);
}

// ------------------------------------------------------------------------
// The path's own dashboard: stage, number, boards and checklists.

const dashboardFor = slug => DASHBOARDS[slug] || null;

function contextOf(profile) {
  const answers = (profile && profile.path_answers && typeof profile.path_answers === 'object') ? profile.path_answers : {};
  return { subpath: (profile && profile.subpath) || null, stage: answers.stage || null, answers };
}

// What the path declares for this member, as plain lists of definitions —
// enough for links on the workspace hub without touching the database.
function pathItemsFor(profile) {
  const d = dashboardFor(profile && profile.path);
  if (!d) return null;
  const ctx = contextOf(profile);
  const north = d.northStar(ctx);
  return {
    boards: d.boards(ctx).map(registry.board),
    metrics: [north].concat(d.supporting(ctx)).filter(Boolean).map(registry.metric),
    checklists: d.checklists(ctx).map(registry.checklist)
  };
}

// Where the member is on the path's stages, and the next real-world step.
function stageOf(d, ctx) {
  const i = d.stages.findIndex(s => s.answer === ctx.stage);
  return {
    list: d.stages.map(s => s.answer),
    index: i,
    current: i >= 0 ? d.stages[i] : null,
    next: i >= 0 ? d.stages[i].next : d.stages[0].next,
    href: i >= 0 ? d.stages[i].href || null : null
  };
}

// A board can be the north star — fixed (exploring's experiments) or by stage
// (brick and mortar: funding, then the opening plan).
const northBoardOf = (d, ctx) => (typeof d.northStarBoard === 'function' ? d.northStarBoard(ctx) : d.northStarBoard) || null;

// Everything the dashboard panel shows, loaded in one go. Any one piece that
// fails on a missing table marks the panel "being set up" instead of failing
// the whole dashboard; any other error is logged and that piece is skipped.
async function panelFor(sb, userId, profile, now = new Date()) {
  const d = dashboardFor(profile && profile.path);
  if (!d) return null;
  const ctx = contextOf(profile);
  let notReady = false;
  const safe = p => p.catch(e => {
    if (missing(e)) notReady = true; else console.error('[path dashboard]', e.message || e);
    return null;
  });
  const north = d.northStar(ctx);
  // Before there is a number to log (a product still in development), a path
  // can make a checklist its north star instead.
  const northList = d.northStarChecklist ? d.northStarChecklist(ctx) : null;
  const northBoardKey = northBoardOf(d, ctx);
  const [northCard, supporting, northBoard, northChecklist, boards, lists] = await Promise.all([
    north ? safe(metrics.card(sb, userId, north, 6, now)) : null,
    Promise.all(d.supporting(ctx).map(k => safe(metrics.card(sb, userId, k, 6, now)))),
    northBoardKey ? safe(pipeline.summary(sb, userId, northBoardKey)) : null,
    northList ? safe(checklists.progress(sb, userId, northList, now)) : null,
    Promise.all(d.boards(ctx).filter(k => k !== northBoardKey).map(k => safe(pipeline.summary(sb, userId, k)))),
    Promise.all(d.checklists(ctx).filter(k => k !== northList).map(k => safe(checklists.progress(sb, userId, k, now))))
  ]);
  return {
    slug: d.slug, intro: d.intro, stage: stageOf(d, ctx),
    north: northCard, northBoard, northChecklist,
    supporting: supporting.filter(Boolean),
    boards: boards.filter(Boolean),
    checklists: lists.filter(Boolean),
    notReady
  };
}

module.exports = { TOOLS, PATHS, DASHBOARDS, configFor, setupQuestions, workspaceFor, needsSetup,
  dashboardFor, contextOf, pathItemsFor, stageOf, panelFor, northBoardOf };
