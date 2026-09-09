// A starting budget, built from the number the member already gave us.
//
// "Money you can put in to start" is a required question on every path. It is
// one of the five universal constraints; the fit test converts it to dollars
// and holds every idea against it, the Compass writes around it, and the coach
// carries it in context. The member answers it before they have seen anything
// else.
//
// And then /budget — a whole top-level tab, the one screen entirely about money
// — did not know it existed. It opened on "Add a category and limit below to
// start budgeting": a blank form asking someone to invent, by hand, a number
// they had already been made to declare. The one thing that would have filled
// it in ("Suggest a startup budget") sat behind the paywall, which is why a
// free member met an empty spreadsheet on a tab as prominent as the Compass.
//
// This is the free, deterministic half. No AI, no credits, no network: their
// declared band becomes dollars, and the dollars get split across the
// categories their path actually spends on. The paid AI budget still does what
// it always did — read the blueprint and write something specific — but it is
// no longer the difference between a usable tab and a blank one.

// The bands, as the questionnaire words them, in dollars. Deliberately the same
// numbers src/fit_library.js holds every idea against: a starter budget that
// disagreed with the fit test about what they can afford would be worse than no
// starter budget at all.
const BUDGET_USD = {
  '$0': 0,
  'under $500': 500,
  '$500-2,000': 2000,
  '$2,000-10,000': 10000,
  '$10,000+': 25000
};

// Where the first dollars actually go, by path. Weights, not amounts — they are
// scaled to whatever the member said they had. Each set is the same five-ish
// slots the path's own questionnaire asks about, so a plumber is not handed a
// line for "content tools" and a creator is not handed one for stock.
const SPLITS = {
  creator: [
    ['Design & Creative', 0.20], ['Software & SaaS', 0.25], ['Equipment & Hardware', 0.30],
    ['Advertising', 0.15], ['Buffer', 0.10]
  ],
  freelancer: [
    ['Software & SaaS', 0.25], ['Web Hosting & Domains', 0.10], ['Legal Fees', 0.20],
    ['Marketing', 0.25], ['Buffer', 0.20]
  ],
  consultant: [
    ['Software & SaaS', 0.20], ['Legal Fees', 0.20], ['Marketing', 0.25],
    ['Events & Conferences', 0.20], ['Buffer', 0.15]
  ],
  local_service: [
    ['Equipment & Hardware', 0.30], ['Vehicle & Fuel', 0.20], ['Insurance', 0.15],
    ['Advertising', 0.20], ['Buffer', 0.15]
  ],
  brick_mortar: [
    ['Rent & Workspace', 0.30], ['Inventory & Materials', 0.25], ['Equipment & Hardware', 0.15],
    ['Taxes & Licenses', 0.15], ['Buffer', 0.15]
  ],
  online_store: [
    ['Inventory & Materials', 0.35], ['Advertising', 0.25], ['Software & SaaS', 0.15],
    ['Shipping & Postage', 0.10], ['Buffer', 0.15]
  ],
  physical_product: [
    ['Manufacturing', 0.35], ['Packaging', 0.15], ['Shipping & Postage', 0.10],
    ['Advertising', 0.25], ['Buffer', 0.15]
  ],
  software: [
    ['Software & SaaS', 0.30], ['Web Hosting & Domains', 0.15], ['Design & Creative', 0.15],
    ['Marketing', 0.25], ['Buffer', 0.15]
  ]
};

// Everyone else, including 'exploring' and anyone who has not picked a path.
const DEFAULT_SPLIT = [
  ['Software & SaaS', 0.25], ['Marketing', 0.25], ['Legal Fees', 0.15],
  ['Equipment & Hardware', 0.20], ['Buffer', 0.15]
];

const norm = v => String(v == null ? '' : v).trim().toLowerCase();

// The declared band as a number, or null when they have not answered yet.
const dollarsFor = launchBudget => {
  const v = BUDGET_USD[norm(launchBudget)];
  return v === undefined ? null : v;
};

const splitFor = path => SPLITS[norm(path)] || DEFAULT_SPLIT;

// [{ category, monthly_limit }], or [] when there is nothing to split.
//
// The declared number is what they can put in to START — the whole thing, not a
// monthly figure — so it is spread over the first three months rather than
// handed over as a monthly allowance. A member who said "$500" and then saw
// $500/month suggested back would rightly stop trusting the number.
const MONTHS = 3;

function suggest(launchBudget, path) {
  const total = dollarsFor(launchBudget);
  if (!total) return [];                       // unanswered, or an honest $0
  const monthly = total / MONTHS;
  return splitFor(path).map(([category, weight]) => ({
    category,
    monthly_limit: Math.max(1, Math.round(monthly * weight))
  }));
}

module.exports = { suggest, dollarsFor, splitFor, BUDGET_USD, DEFAULT_SPLIT, SPLITS, MONTHS };
