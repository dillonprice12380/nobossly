// The one number each path is measured by.
//
// Every path has a leading indicator — the thing that moves before the money
// does, in that path's own unit. A creator is measured in followers or in
// monthly visitors, a software business in paying customers, a plumber in jobs
// a week. "Grow the business" is not something you can tell you are winning;
// "you need 20 customers at $50" is.
//
// There are two shapes here and the difference matters:
//
//   EXTERNAL bars are the same for everyone, set by someone other than the
//   member — platforms and advertisers decide when a following is worth
//   sponsoring, landlords and margins decide what rent a shop can carry. These
//   are constants, and hardcoding them is correct.
//
//   DERIVED bars come from the member's own answers. A freelancer's rate has no
//   universal right answer: it falls out of the hours they have and the money
//   they need. Hardcoding "charge $75" would be wrong for half of them.
//
// The money target for the derived paths is $1,000 a month — not an invented
// figure, but the platform's own Level 8 rung, the point at which this reads as
// income rather than a hobby. Everything scales linearly from there, so someone
// aiming to replace a whole salary can multiply.

const paths = require('./paths');

// Level 8: "hit a $1k month". The ladder already decided what the first
// meaningful money number is; the traction maths should not invent a second one.
const MONTHLY_TARGET_USD = 1000;

// Freelance and consulting hours are not all billable. Sales, admin, invoicing
// and the work you do not get paid for take roughly 40% of any week — a widely
// used planning figure, and the reason "I have 10 hours" is not "10 billable".
const BILLABLE_SHARE = 0.6;
const WEEKS_PER_MONTH = 4.3;

// Retail rent is conventionally held under about 10% of gross revenue; above
// that the lease is running the business. Hospitality is usually quoted a
// little lower. This is the bar that makes a rent figure mean something.
const RENT_SHARE_OF_REVENUE = 0.10;

// A product that only doubles its cost has nothing left once a wholesaler and a
// retailer each take a cut, so it can only ever be sold direct.
const MARGIN_STACK_MULTIPLE = 3;

// Committed buyers before money is spent that cannot be recovered — a lease, a
// tooling bill, a minimum order. Not an industry constant; a deliberately small
// number chosen to be reachable while still being real people who said yes.
const PROOF_BEFORE_COMMITMENT = 25;

// No client over half your income. Above that you have a job with worse rights
// and no notice period, which on a site about leaving jobs is worth naming.
const MAX_CLIENT_SHARE = 0.5;

// ---------- reading the bands ----------
//
// Questionnaire answers are bands, so they have to be turned into numbers. The
// direction differs by what the band means, and getting it backwards produces
// confidently wrong advice:
//
//   A band describing what someone HAS reads as its FLOOR. "$100-250 a job"
//   means at least $100, and crediting them with $250 would understate how many
//   jobs they need.
//
//   A band describing what someone can SPEND reads as its ceiling — that is
//   what BUDGET_USD in fit_library.js does, and why it is separate from this.
const dashes = v => String(v == null ? '' : v).replace(/[–—]/g, '-').trim();
const key = v => dashes(v).toLowerCase();

const MONEY_FLOOR = {
  // Job value, order value, engagement price. A closed band reads as its floor;
  // an OPEN-BOTTOM band ("under $100") has a floor of zero, which is not a
  // number you can divide by, so it reads as half its top instead — the
  // conservative half of the range it actually describes.
  'under $10': 5, 'under $20': 10, 'under $100': 50, 'under $500': 250,
  '$10-30': 10, '$20-40': 20, '$30-100': 30, '$40-100': 40,
  '$100-250': 100, '$100-500': 100, '$250-500': 250, '$250+': 250,
  '$500-1,500': 500, '$500-2,000': 500, '$500+': 500,
  '$1,500+': 1500, '$1,500-3,000': 1500, '$2,000-10,000': 2000,
  '$3,000-6,000': 3000, '$6,000+': 6000, '$10,000+': 10000
};

const MARGIN_FLOOR = {
  'under 30%': 0.15, '30-50%': 0.30, '50-70%': 0.50, '70%+': 0.70, 'not sure yet': null
};

const money = n => '$' + Number(n).toLocaleString('en-US');
const num = v => { const n = MONEY_FLOOR[key(v)]; return n == null ? null : n; };

// Round a customer/job count up — you cannot have 4.2 clients, and rounding
// down would quietly understate the work.
const countFor = unitValue => (unitValue > 0 ? Math.ceil(MONTHLY_TARGET_USD / unitValue) : null);

// ---------- per-path traction ----------

function freelancerTraction(q, facts) {
  const hours = facts.hours_per_week;
  if (!hours) return null;
  const billable = Math.max(1, Math.round(hours * BILLABLE_SHARE * WEEKS_PER_MONTH));
  const rate = Math.ceil(MONTHLY_TARGET_USD / billable);
  return {
    unit: 'your hourly rate',
    kind: 'derived',
    target: rate,
    display: money(rate) + ' an hour',
    detail: `${billable} billable hours a month out of the ${hours} a week you have`,
    now: null, met: null
  };
}

function consultantTraction(q, facts) {
  const pa = q.path_answers || {};
  const ticket = num(pa.ticket_comfort);
  if (ticket == null) return null;
  const perMonth = countFor(ticket);
  return {
    unit: 'engagements a month',
    kind: 'derived',
    target: perMonth,
    display: perMonth === 1 ? 'one engagement a month' : perMonth + ' engagements a month',
    detail: `at the ${money(ticket)} you said you could name without flinching`,
    now: null, met: null
  };
}

function localServiceTraction(q, facts) {
  const pa = q.path_answers || {};
  const job = num(pa.avg_job_value);
  if (job == null) return null;
  const perMonth = countFor(job);
  return {
    unit: 'jobs a month',
    kind: 'derived',
    target: perMonth,
    display: perMonth + ' jobs a month',
    detail: `at ${money(job)} a job, which is about ${Math.ceil(perMonth / WEEKS_PER_MONTH)} a week`,
    now: null, met: null
  };
}

function onlineStoreTraction(q, facts) {
  const pa = q.path_answers || {};
  const aov = num(pa.avg_order_value);
  const margin = MARGIN_FLOOR[key(pa.gross_margin)];
  if (aov == null || margin == null) return null;
  const contribution = aov * margin;
  const orders = countFor(contribution);
  if (!orders) return null;
  return {
    unit: 'orders a month',
    kind: 'derived',
    target: orders,
    display: orders + ' orders a month',
    detail: `at ${money(aov)} an order keeping ${Math.round(margin * 100)}%, which is ${money(Math.round(contribution))} of margin each`,
    now: null, met: null
  };
}

function softwareTraction(q, facts) {
  const pa = q.path_answers || {};
  const price = num(pa.expected_price);
  if (price == null) return null;
  const customers = countFor(price);
  return {
    unit: 'paying customers',
    kind: 'derived',
    target: customers,
    display: customers + ' paying customers',
    detail: `at ${money(price)} a month each` + (pa.who_pays ? `, selling to ${String(pa.who_pays).toLowerCase()}` : ''),
    now: null, met: null
  };
}

function brickMortarTraction(q, facts) {
  const pa = q.path_answers || {};
  const rent = num(pa.rent_capacity);
  if (rent == null) return null;
  const revenue = Math.round(rent / RENT_SHARE_OF_REVENUE);
  return {
    unit: 'monthly takings',
    kind: 'external',
    target: revenue,
    display: money(revenue) + ' a month through the till',
    detail: `rent should sit under ${Math.round(RENT_SHARE_OF_REVENUE * 100)}% of takings, and you said you could carry ${money(rent)}`,
    now: null, met: null
  };
}

function physicalProductTraction() {
  return {
    unit: 'markup over unit cost',
    kind: 'external',
    target: MARGIN_STACK_MULTIPLE,
    display: MARGIN_STACK_MULTIPLE + '× what it costs to make',
    detail: 'a wholesaler and a retailer each take a cut before the customer pays',
    now: null, met: null
  };
}

// The creator bar is external and already modelled in paths.js, where the
// questionnaire needs it too. Reuse it rather than describing it twice.
function creatorTraction(q) {
  const a = paths.creatorAudience(q);
  if (!a || a.now == null && a.target == null) return null;
  return {
    unit: a.metric,
    kind: 'external',
    target: a.target,
    display: Number(a.target).toLocaleString('en-US') + ' ' + a.metric,
    detail: a.now == null ? 'the size where that unit starts paying'
                          : 'you are at ' + Number(a.now).toLocaleString('en-US'),
    now: a.now, met: a.met
  };
}

const BUILDERS = {
  creator: creatorTraction,
  freelancer: freelancerTraction,
  consultant: consultantTraction,
  local_service: localServiceTraction,
  brick_mortar: brickMortarTraction,
  online_store: onlineStoreTraction,
  physical_product: physicalProductTraction,
  software: softwareTraction
  // 'exploring' has none, deliberately: there is no business to have traction
  // in yet, and inventing a number for someone still choosing would be noise.
};

// The traction read for one member, or null where the path has no bar or the
// answers it needs are missing. Never guesses — a missing answer returns null
// rather than a number pulled out of the air, because a wrong bar is worse
// advice than no bar.
function tractionFor(q, facts) {
  if (!q) return null;
  const build = BUILDERS[q.founder_path];
  if (!build) return null;
  try { return build(q, facts || {}) || null; } catch (_) { return null; }
}

module.exports = {
  tractionFor,
  MONTHLY_TARGET_USD, BILLABLE_SHARE, WEEKS_PER_MONTH, RENT_SHARE_OF_REVENUE,
  MARGIN_STACK_MULTIPLE, PROOF_BEFORE_COMMITMENT, MAX_CLIENT_SHARE,
  MONEY_FLOOR, MARGIN_FLOOR, BUILDERS
};
