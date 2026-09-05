// The eight paths a founder can take, and the questions each one asks.
//
// Onboarding used to branch on STAGE — already in business, have an idea, still
// exploring — and then ask everyone the same generic questions. A content
// creator and a plumber filled in the same form, which is why the answers were
// thin enough that the Compass had to guess.
//
// A path is what KIND of business someone is building. It is declared, not
// inferred, which makes it the most trustworthy signal in the product: the fit
// criteria, the Compass, and the tailored challenges all key off it.
//
// Questions are DATA, not markup. Eight hand-written form branches would drift
// apart within a month; one renderer over these definitions cannot.
//
// Each question is:
//   { name, label, type, options?, hint?, required?, col?, placeholder? }
//
// `col` names an existing questionnaire_responses column. Those are the
// universal constraint questions — budget, hours, runway, income, deal breakers
// — and they must keep writing to their own columns because the fit-criteria
// library matches on exactly those facts. Everything without a `col` is
// path-specific and lands in the path_answers jsonb.

const HOURS = ['<5', '5-10', '10-20', '20-40', '40+'];
const BUDGET = ['$0', 'Under $500', '$500-2,000', '$2,000-10,000', '$10,000+'];
const RUNWAY = ['None — need income now', '1-3 months', '3-6 months', '6-12 months', '12+ months'];
const INCOME = ['Side income ($500+/mo)', 'Replace part of salary', 'Replace full salary', 'Build something big'];
const WORK_STATUS = ['Employed full-time', 'Employed part-time', 'Freelancing', 'Between jobs', 'Student', 'Parent / caregiver'];
const SCALE = ['1', '2', '3', '4', '5'];

// Asked on every path, in this order, before the path's own questions. These
// are constraints rather than ambitions, and they are what the fit test is
// built from — which is why they are universal.
const UNIVERSAL_CORE = [
  { name: 'founder_name', col: 'founder_name', label: 'Your first name', type: 'text', required: true },
  { name: 'hours_per_week', col: 'hours_per_week', label: 'Hours a week you can genuinely give this', type: 'select', options: HOURS, required: true },
  { name: 'launch_budget', col: 'launch_budget', label: 'Money you can put in to start', type: 'select', options: BUDGET, required: true },
  { name: 'runway', col: 'runway', label: 'How long you could go without this earning', type: 'select', options: RUNWAY, required: true },
  { name: 'income_year1', col: 'income_year1', label: 'What it needs to earn to be worth it', type: 'select', options: INCOME, required: true },
  { name: 'deal_breakers', col: 'deal_breakers', label: 'Deal breakers — things you will not do', type: 'csv',
    placeholder: 'e.g. cold calling, being on camera, holding stock',
    hint: 'These become hard rules in your fit test, so be honest rather than brave.' }
];

// Asked on every path in the optional depth steps.
const UNIVERSAL_DEPTH = [
  { name: 'work_status', col: 'work_status', label: 'Current work status', type: 'select', options: WORK_STATUS },
  { name: 'location', col: 'location', label: 'Where are you based?', type: 'text', placeholder: 'City, country' },
  { name: 'credentials', col: 'credentials', label: 'Credentials or qualifications', type: 'text',
    placeholder: 'degrees, licences, certifications', hint: 'An idea that uses one of these starts ahead of an idea that does not.' },
  { name: 'tech_level', col: 'tech_level', label: 'Comfort with technical tools (1–5)', type: 'select', options: SCALE },
  { name: 'sales_comfort', col: 'sales_comfort', label: 'Comfort with selling (1–5)', type: 'select', options: SCALE },
  { name: 'unfair_advantage', col: 'unfair_advantage', label: 'Your unfair advantage', type: 'textarea',
    placeholder: 'access, reputation, an audience, a skill few have' },
  { name: 'customer_access', col: 'customer_access', label: 'People you can already reach', type: 'textarea',
    placeholder: 'a group, a list, a network, an employer' },
  { name: 'biggest_fear', col: 'biggest_fear', label: 'What worries you most about this', type: 'textarea' },
  { name: 'motivation', col: 'motivation', label: "What's actually driving you", type: 'textarea' }
];

// Every path asks where the founder is with it. This is the stage axis, kept as
// one question inside the path rather than as a separate wall — a creator with
// 40k followers and one with none need different advice, and the "already
// running it" case is where the most valuable users are.
const stageQuestion = (label, options) => ({
  name: 'stage', label, type: 'select', options, required: true
});

const PATHS = [
  {
    slug: 'creator',
    label: 'Content creator',
    emoji: '🎬',
    blurb: 'You build an audience first — video, writing, podcasting, streaming — and money follows attention.',
    core: [
      stageQuestion('Where are you with it?', [
        'Not started — no audience yet', 'Posting occasionally', 'Posting consistently, no income',
        'Earning something', 'This is my main income'
      ]),
      { name: 'platform', label: 'Main platform', type: 'select', required: true,
        options: ['YouTube', 'TikTok', 'Instagram', 'X / Twitter', 'LinkedIn', 'Twitch', 'Newsletter', 'Podcast', 'Blog', 'Undecided'] },
      { name: 'niche', label: 'What is it about?', type: 'text', required: true,
        placeholder: 'the narrower the better — "budget van builds", not "lifestyle"' },
      { name: 'audience_size', label: 'Audience you have now', type: 'select', required: true,
        options: ['None yet', 'Under 1,000', '1,000–10,000', '10,000–100,000', '100,000+'] },
      { name: 'monetization', label: 'How you think it makes money', type: 'checks',
        options: ['Sponsorships', 'Affiliate', 'My own product', 'Memberships', 'Platform ad revenue', 'Services off the back of it', 'Not sure yet'] }
    ],
    depth: [
      { name: 'cadence', label: 'Posting rhythm you could hold for a year', type: 'select',
        options: ['Daily', 'A few times a week', 'Weekly', 'Every other week', 'Monthly'] },
      { name: 'on_camera', label: 'Are you willing to be on camera?', type: 'select', options: ['Yes', 'Voice only', 'No — faceless'] },
      { name: 'back_catalogue', label: 'What you already have', type: 'textarea', placeholder: 'existing posts, an email list, a following elsewhere' },
      { name: 'differentiator', label: 'Why someone follows you instead of the others', type: 'textarea' }
    ]
  },

  {
    slug: 'freelancer',
    label: 'Freelancer',
    emoji: '💻',
    blurb: 'You sell a skill and do the work yourself — design, writing, development, editing, admin.',
    core: [
      stageQuestion('Where are you with it?', [
        'Not started', 'A few one-off jobs', 'Some regular clients', 'Fully booked', 'Turning work away'
      ]),
      { name: 'service', label: 'What do you actually do for people?', type: 'text', required: true,
        placeholder: 'e.g. Webflow builds for property agents' },
      { name: 'experience', label: 'How long you have done this work', type: 'select', required: true,
        options: ['Learning it now', 'Under a year', '1–3 years', '3–10 years', '10+ years'] },
      { name: 'client_source', label: 'Where clients come from now', type: 'checks',
        options: ['Nowhere yet', 'Referrals', 'Upwork / Fiverr', 'LinkedIn', 'Cold outreach', 'A previous employer', 'My own audience'] },
      { name: 'pricing_model', label: 'How you would rather charge', type: 'select',
        options: ['Hourly', 'Per project', 'Monthly retainer', 'Not sure yet'] }
    ],
    depth: [
      { name: 'current_rate', label: 'What you charge now', type: 'text', placeholder: 'e.g. $60/hr, or $2,500 a project' },
      { name: 'portfolio_url', label: 'Portfolio or work samples', type: 'url', placeholder: 'https://' },
      { name: 'capacity', label: 'Clients you could handle at once', type: 'select', options: ['1', '2–3', '4–6', '7+'] },
      { name: 'niche_choice', label: 'An industry you know better than most', type: 'text',
        hint: 'Specialists charge more than generalists, and get found more easily.' }
    ]
  },

  {
    slug: 'consultant',
    label: 'Coach or consultant',
    emoji: '🧠',
    blurb: 'You sell judgement rather than hours — advising, coaching, or fixing a problem others cannot.',
    core: [
      stageQuestion('Where are you with it?', [
        'Not started', 'Advised a few people informally', 'Been paid for it once or twice',
        'Regular paying clients', 'This is my main income'
      ]),
      { name: 'expertise', label: 'What do you know that others pay for?', type: 'text', required: true,
        placeholder: 'e.g. getting dental practices to fill their calendar' },
      { name: 'who_you_advise', label: 'Who you would advise', type: 'text', required: true,
        placeholder: 'their job and their situation, not just "small businesses"' },
      { name: 'outcome', label: 'The outcome you deliver', type: 'textarea', required: true,
        placeholder: 'What is measurably different after working with you?',
        hint: 'Consultants who name an outcome charge for it. Ones who name a process charge by the hour.' },
      { name: 'proof', label: 'Proof you can do it', type: 'select', required: true,
        options: ['A formal credential', 'Years doing the job', 'Results for clients', 'My own results', 'Nothing yet'] }
    ],
    depth: [
      { name: 'delivery', label: 'How you would deliver it', type: 'checks',
        options: ['1:1 coaching', 'Group programme', 'Course', 'Done-with-you', 'Done-for-you', 'Retainer advisory'] },
      { name: 'ticket_comfort', label: 'Highest price you could say out loud without flinching', type: 'select',
        options: ['Under $500', '$500–2,000', '$2,000–10,000', '$10,000+'] },
      { name: 'case_studies', label: 'Results you could point to', type: 'textarea' },
      { name: 'referral_source', label: 'Who could send you clients', type: 'textarea' }
    ]
  },

  {
    slug: 'local_service',
    label: 'Local service',
    emoji: '🚚',
    blurb: 'You go to the customer — trades, cleaning, landscaping, mobile grooming, repairs.',
    core: [
      stageQuestion('Where are you with it?', [
        'Not started', 'A few jobs for people I know', 'Regular work coming in',
        'Booked out', 'Running it with help'
      ]),
      { name: 'service', label: 'The service', type: 'text', required: true, placeholder: 'e.g. gutter clearing and roof checks' },
      { name: 'service_area', label: 'How far you would travel', type: 'select', required: true,
        options: ['My town only', 'Up to 10 miles', 'Up to 25 miles', 'Up to 50 miles', 'The whole region'] },
      { name: 'qualified', label: 'Licensing and insurance', type: 'select', required: true,
        options: ['Fully licensed and insured', 'Licensed, not insured', 'Working on it', 'Not needed for this work', 'Not sure what I need'] },
      { name: 'equipment', label: 'Vehicle and kit', type: 'select', required: true,
        options: ['Have everything', 'Have some of it', 'Have nothing yet', 'Would rent or borrow'] }
    ],
    depth: [
      { name: 'trade_skill', label: 'Can you do the work yourself?', type: 'select',
        options: ['Yes, it is my trade', 'Yes, self-taught', 'Partly', 'No — I would hire'] },
      { name: 'seasonality', label: 'Is the work seasonal?', type: 'select',
        options: ['Steady all year', 'Busier in summer', 'Busier in winter', 'Very seasonal'] },
      { name: 'local_competition', label: 'Who already does this locally', type: 'textarea' },
      { name: 'how_found', label: 'How people find this service near you', type: 'checks',
        options: ['Google search', 'Facebook groups', 'Nextdoor', 'Word of mouth', 'Checkatrade / Angi / directories', 'Van signage', 'Flyers'] }
    ]
  },

  {
    slug: 'brick_mortar',
    label: 'Brick and mortar',
    emoji: '🏪',
    blurb: 'A place people come to — a shop, café, salon, studio, gym or bar.',
    core: [
      stageQuestion('Where are you with it?', [
        'Just an idea', 'Looking at premises', 'Signed or about to sign a lease',
        'Fitting out', 'Open and trading'
      ]),
      { name: 'venue_type', label: 'What kind of place', type: 'select', required: true,
        options: ['Shop / retail', 'Café or coffee shop', 'Restaurant or takeaway', 'Bar', 'Salon or barber',
                  'Gym or studio', 'Workshop', 'Clinic', 'Other'] },
      { name: 'location_status', label: 'Premises', type: 'select', required: true,
        options: ['Nothing yet', 'Scouting areas', 'Viewing places', 'Offer in', 'Lease signed', 'Already trading'] },
      { name: 'rent_capacity', label: 'Monthly rent you could carry', type: 'select', required: true,
        options: ['Under $500', '$500–1,500', '$1,500–3,000', '$3,000–6,000', '$6,000+', 'No idea yet'] },
      { name: 'fitout_budget', label: 'Money for fit-out and stock, on top of rent', type: 'select', required: true,
        options: ['Under $5,000', '$5,000–20,000', '$20,000–50,000', '$50,000–150,000', '$150,000+', 'Would need finance'] }
    ],
    depth: [
      { name: 'permits', label: 'Licences and permits you will need', type: 'checks',
        options: ['Food hygiene', 'Alcohol licence', 'Health department', 'Change of use / planning',
                  'Fire safety', 'Music licence', 'None that I know of', 'Not sure'] },
      { name: 'staffing', label: 'Staff from day one', type: 'select',
        options: ['Just me', 'Me plus part-time help', '2–5 staff', '6+ staff'] },
      { name: 'footfall_or_destination', label: 'Will people pass it, or come for it?', type: 'select',
        options: ['Passing trade', 'A destination people seek out', 'Both'] },
      { name: 'hours', label: 'Opening hours you could sustain', type: 'textarea', placeholder: 'and who covers them when you are not there' }
    ]
  },

  {
    slug: 'online_store',
    label: 'Online store',
    emoji: '📦',
    blurb: 'You sell products online — physical goods, or digital ones like templates and courses.',
    core: [
      stageQuestion('Where are you with it?', [
        'Just an idea', 'Product chosen, nothing listed', 'Listed, no sales yet',
        'A few sales', 'Selling regularly'
      ]),
      { name: 'product', label: 'What you would sell', type: 'text', required: true },
      { name: 'goods_type', label: 'Physical or digital', type: 'select', required: true,
        options: ['Physical products', 'Digital products', 'Both'] },
      { name: 'sourcing', label: 'Where the product comes from', type: 'select', required: true,
        options: ['I make it myself', 'Wholesale', 'Print on demand', 'Dropship', 'A manufacturer would make it', 'I would create the digital files'] },
      { name: 'channel', label: 'Where you would sell it', type: 'checks',
        options: ['My own site', 'Etsy', 'Amazon', 'eBay', 'TikTok Shop', 'Instagram', 'Wholesale to shops', 'Markets and fairs'] }
    ],
    depth: [
      { name: 'inventory_capital', label: 'Money you could tie up in stock', type: 'select',
        options: ['None — it must be made to order', 'Under $500', '$500–2,000', '$2,000–10,000', '$10,000+'] },
      { name: 'fulfilment', label: 'Who packs and ships', type: 'select',
        options: ['Me, from home', 'A fulfilment service', 'The supplier', 'Nothing to ship — digital'] },
      { name: 'margin_known', label: 'Do you know your margin per unit?', type: 'select',
        options: ['Yes, to the penny', 'Roughly', 'No'] },
      { name: 'brand_or_commodity', label: 'Is it a brand or a commodity?', type: 'textarea',
        placeholder: 'If someone can buy the same thing cheaper elsewhere, what makes them buy yours?' }
    ]
  },

  {
    slug: 'software',
    label: 'Software or app',
    emoji: '⌨️',
    blurb: 'You build a product people use — a web app, mobile app, tool or plugin.',
    core: [
      stageQuestion('Where are you with it?', [
        'Just an idea', 'Designing it', 'Building it', 'Live with no users', 'Live with users', 'Paying customers'
      ]),
      { name: 'problem', label: 'The problem it solves', type: 'textarea', required: true,
        placeholder: 'Whose problem, and what they do about it today.' },
      { name: 'can_build', label: 'Can you build it?', type: 'select', required: true,
        options: ['Yes, I code', 'Partly — with no-code tools', 'Partly — with AI help', 'No, I would need someone'] },
      { name: 'platform_target', label: 'Where it runs', type: 'select', required: true,
        options: ['Web app', 'iOS', 'Android', 'Both mobile platforms', 'Browser extension', 'Desktop', 'API or integration'] },
      { name: 'who_pays', label: 'Who pays for it', type: 'select', required: true,
        options: ['Consumers', 'Small businesses', 'Larger companies', 'Not sure yet'] }
    ],
    depth: [
      { name: 'pricing_shape', label: 'How it would charge', type: 'select',
        options: ['Monthly subscription', 'Annual subscription', 'One-off purchase', 'Usage-based', 'Free with paid tier', 'Not sure'] },
      { name: 'prototype', label: 'What exists so far', type: 'select',
        options: ['Nothing', 'Sketches or a spec', 'A design', 'A working prototype', 'A live product'] },
      { name: 'build_budget', label: 'If you had to pay someone to build it', type: 'select',
        options: ['I would build it myself', 'Under $2,000', '$2,000–10,000', '$10,000–50,000', 'I would need a co-founder'] },
      { name: 'existing_tools', label: 'What people use instead today', type: 'textarea',
        hint: '"Nothing" is usually wrong and always worth checking — a spreadsheet counts.' }
    ]
  },

  {
    slug: 'exploring',
    label: 'Still figuring it out',
    emoji: '🧭',
    blurb: 'You know you want to build something, but not what yet. Start here and the Compass narrows it down.',
    core: [
      stageQuestion('How set are you on doing something?', [
        'Just curious', 'Serious, but no idea yet', 'Weighing up a few options', 'Ready to commit once I pick'
      ]),
      { name: 'skills', col: 'skills', label: 'Your top skills', type: 'csv', required: true,
        placeholder: 'writing, sales, spreadsheets, fixing things…' },
      { name: 'energizing_work', col: 'energizing_work', label: 'Work that gives you energy', type: 'checks',
        options: ['Creating things', 'Helping people', 'Solving problems', 'Teaching', 'Selling & persuading', 'Organizing & systems'] },
      { name: 'industry_field', col: 'industry_field', label: 'Field you know best', type: 'text', required: true,
        placeholder: 'e.g. healthcare, retail, logistics' },
      { name: 'problem_pain', col: 'problem_pain', label: 'A problem you keep noticing', type: 'textarea',
        placeholder: 'Something that annoys you or people around you.' }
    ],
    depth: [
      { name: 'hobbies', col: 'hobbies', label: 'What you do outside work', type: 'csv' },
      { name: 'superpower', col: 'superpower', label: 'What people come to you for', type: 'text' },
      { name: 'avoid_industries', col: 'avoid_industries', label: 'Anything you would not work in', type: 'text' },
      { name: 'ideal_day', col: 'ideal_day', label: 'What a good working day looks like', type: 'textarea' },
      { name: 'success_definition', col: 'success_definition', label: 'What would make this a success', type: 'textarea' }
    ]
  }
];

const BY_SLUG = {};
PATHS.forEach(p => { BY_SLUG[p.slug] = p; });

const SLUGS = PATHS.map(p => p.slug);
const isPath = slug => Object.prototype.hasOwnProperty.call(BY_SLUG, slug);
const get = slug => BY_SLUG[slug] || null;

// The full question list for a path, in the order it is asked. Universal
// constraints first — they are short, they are the same every time, and they
// are what the fit test is built from.
function coreQuestions(slug) {
  const p = get(slug);
  return p ? UNIVERSAL_CORE.concat(p.core) : UNIVERSAL_CORE.slice();
}

function depthQuestions(slug) {
  const p = get(slug);
  return (p ? p.depth : []).concat(UNIVERSAL_DEPTH);
}

// Depth is paged so it never becomes one enormous form. Four to a step keeps
// each one under a minute, which is the whole point of it being optional.
const PER_DEPTH_STEP = 4;
const depthSteps = slug => {
  const all = depthQuestions(slug);
  const out = [];
  for (let i = 0; i < all.length; i += PER_DEPTH_STEP) out.push(all.slice(i, i + PER_DEPTH_STEP));
  return out;
};

// 1 chooser + 1 core + however many depth pages this path needs.
const totalSteps = slug => 2 + depthSteps(slug).length;

// A readable profile block for the AI, built from whatever the founder actually
// answered on their own path. Replaces the three hand-written blocks that only
// covered the old stage split — those could not describe a creator's follower
// count or a brick-and-mortar founder's rent ceiling at all.
function describe(q) {
  if (!q) return '';
  const path = get(q.founder_path);
  const pa = q.path_answers || {};
  const lines = [];
  const push = (label, v) => {
    if (v === null || v === undefined) return;
    const t = Array.isArray(v) ? v.join(', ') : String(v).trim();
    if (t) lines.push(label + ': ' + t);
  };

  lines.push('Path: ' + (path ? path.label : (q.founder_path || 'unknown')));
  UNIVERSAL_CORE.concat(UNIVERSAL_DEPTH).forEach(qq => push(qq.label, q[qq.col]));
  if (path) {
    path.core.concat(path.depth).forEach(qq => push(qq.label, qq.col ? q[qq.col] : pa[qq.name]));
  }
  return lines.join('\n');
}

// How far along they are, from their path's own stage question. Every path asks
// it, but each phrases the options in its own vocabulary, so this reads the
// shape of the answer rather than matching exact strings.
function stageOf(q) {
  const raw = String(((q && q.path_answers) || {}).stage || '').toLowerCase();
  if (!raw) return 'unknown';
  if (/main income|turning work away|booked out|selling regularly|paying customers|open and trading|running it with help/.test(raw)) return 'running';
  if (/earning|first few sales|a few sales|regular|live with users|some regular/.test(raw)) return 'earning';
  if (/launched|listed|posting|building|fitting out|signed|offer in|a few (jobs|one-off)|advised a few/.test(raw)) return 'started';
  return 'idea';
}

// True once there is a real business to search the live market about. A founder
// still choosing a direction has no subject for a market scan.
const hasSubject = q => !!(q && q.founder_path && q.founder_path !== 'exploring');

module.exports = {
  PATHS, SLUGS, BY_SLUG, isPath, get, describe, stageOf, hasSubject,
  UNIVERSAL_CORE, UNIVERSAL_DEPTH,
  coreQuestions, depthQuestions, depthSteps, totalSteps,
  REQUIRED_STEPS: 2,
  HOURS, BUDGET, RUNWAY, INCOME, WORK_STATUS
};
