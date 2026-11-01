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
    featured: ['persona', 'pricing', 'elevator_pitch', 'proof'],
    available: ['tax', 'quit', 'goals', 'money', 'tasks', 'milestones', 'lean_canvas', 'surveys']
  },
  consultant: {
    setup: ['stage', 'expertise', 'who_you_advise', 'ticket_comfort'],
    featured: ['persona', 'elevator_pitch', 'pricing', 'surveys'],
    available: ['proof', 'goals', 'tax', 'quit', 'money', 'tasks', 'milestones', 'lean_canvas']
  },
  local_service: {
    setup: ['stage', 'service', 'service_area', 'avg_job_value'],
    featured: ['pricing', 'tax', 'money', 'goals'],
    available: ['business_plan', 'persona', 'elevator_pitch', 'proof', 'tasks', 'milestones', 'quit']
  },
  brick_mortar: {
    setup: ['stage', 'venue_type', 'location_status', 'rent_capacity'],
    featured: ['business_plan', 'business_model_canvas', 'persona', 'surveys'],
    available: ['money', 'pricing', 'goals', 'tasks', 'milestones', 'lean_canvas', 'elevator_pitch', 'tax']
  },
  online_store: {
    setup: ['stage', 'product', 'goods_type', 'channel'],
    featured: ['pricing', 'persona', 'tax', 'goals'],
    available: ['surveys', 'money', 'lean_canvas', 'business_plan', 'tasks', 'milestones', 'quit']
  },
  physical_product: {
    setup: ['stage', 'product', 'made_how', 'sell_where'],
    featured: ['business_model_canvas', 'persona', 'surveys', 'business_plan'],
    available: ['pricing', 'interviews', 'lean_canvas', 'money', 'goals', 'tasks', 'milestones']
  },
  software: {
    setup: ['stage', 'problem', 'can_build', 'who_pays'],
    featured: ['lean_canvas', 'persona', 'interviews', 'surveys'],
    available: ['elevator_pitch', 'idea_refiner', 'business_plan', 'business_model_canvas', 'pricing', 'goals', 'tasks', 'milestones']
  },
  exploring: {
    setup: ['stage', 'skills', 'energizing_work'],
    featured: ['idea_refiner', 'surveys', 'goals', 'persona'],
    available: ['lean_canvas', 'interviews', 'tasks', 'milestones']
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

module.exports = { TOOLS, PATHS, configFor, setupQuestions, workspaceFor, needsSetup };
