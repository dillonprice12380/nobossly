// The nine paths out of a day job, and the questions each one asks.
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
// Questions are DATA, not markup. Nine hand-written form branches would drift
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

// ---------- conditional questions ----------
//
// A question can carry `showIf: { other_question: [values] }` and is then only
// asked when that other question holds one of those values. The form renders it
// hidden and the browser reveals it; the server checks the same condition again
// on save, because a hidden field is a suggestion and a POST body is not.
function showIfSatisfied(question, answers) {
  const cond = question && question.showIf;
  if (!cond) return true;
  return Object.entries(cond).every(([name, allowed]) => {
    const v = answers ? answers[name] : undefined;
    return (Array.isArray(allowed) ? allowed : [allowed]).some(a => String(a) === String(v == null ? '' : v));
  });
}

// ---------- the creator audience bar ----------
//
// "How big is your audience" is two different questions. A social creator is
// measured in people who follow them, and sponsorship offers start arriving at
// roughly ten thousand. A publisher is measured in visits, and ad or affiliate
// revenue does not amount to anything until roughly fifty thousand a month.
// Asking one question in one unit gave a blogger with 40,000 readers a month
// the same read as an influencer with 40,000 followers, which is wrong in both
// directions.
//
// These are rules of thumb, not physics, and the Compass says so. But a creator
// planning without any number at all is planning in a vacuum, and "grow the
// audience" is not a plan you can tell you are winning.
const CREATOR_AUDIENCE = {
  'Social media creator or influencer': { kind: 'social', metric: 'followers', target: 10000 },
  'Video or podcast creator': { kind: 'social', metric: 'subscribers', target: 10000 },
  'Newsletter writer': { kind: 'social', metric: 'subscribers', target: 10000 },
  'Publisher or blogger': { kind: 'publisher', metric: 'monthly visitors', target: 50000 },
  // Undecided defaults to the follower bar: it is the lower of the two, so it
  // never tells someone they are further from a target than they really are.
  'Not sure yet': { kind: 'social', metric: 'followers', target: 10000 }
};
const CREATOR_TYPES = Object.keys(CREATOR_AUDIENCE);
const SOCIAL_CREATOR_TYPES = CREATOR_TYPES.filter(t => CREATOR_AUDIENCE[t].kind === 'social');
const PUBLISHER_CREATOR_TYPES = CREATOR_TYPES.filter(t => CREATOR_AUDIENCE[t].kind === 'publisher');

// The FLOOR of the band, deliberately — the opposite of the money buckets,
// which take the top. A budget of "$500-2,000" means they can spend up to
// $2,000, so the ceiling is the honest constraint. An audience of
// "1,000-10,000" means they definitely have at least 1,000, and crediting them
// with 10,000 would tell someone with 1,200 followers that they had cleared a
// bar they are nowhere near.
const AUDIENCE_FLOOR = {
  'none yet': 0,
  'under 1,000': 0,
  '1,000-10,000': 1000,
  '10,000-50,000': 10000,
  '50,000-250,000': 50000,
  '250,000+': 250000
};

const dashes = v => String(v == null ? '' : v).replace(/[\u2013\u2014]/g, '-').trim();

// What this creator's audience is measured in, how big it is, and the size at
// which it starts being worth money. Null for every path that is not a creator
// — nothing else on the site is built on audience scale.
function creatorAudience(q) {
  if (!q || q.founder_path !== 'creator') return null;
  const pa = q.path_answers || {};
  const type = String(pa.creator_type || '').trim();
  const spec = CREATOR_AUDIENCE[type] || CREATOR_AUDIENCE['Not sure yet'];
  const band = spec.kind === 'publisher' ? pa.monthly_traffic : pa.audience_size;
  const now = AUDIENCE_FLOOR[dashes(band).toLowerCase()];
  return {
    type: type || null,
    kind: spec.kind,
    metric: spec.metric,
    target: spec.target,
    now: now == null ? null : now,
    // Unknown is not the same as short: a creator who skipped the question has
    // not been told they are behind.
    met: now == null ? null : now >= spec.target
  };
}

const PATHS = [
  {
    slug: 'creator',
    label: 'Content creator',
    emoji: '🎬',
    blurb: 'You build an audience first — video, writing, podcasting, streaming — and money follows attention.',
    marketing: {
      headline: 'You are not short of ideas. You are short of a plan that survives week three.',
      subhead: 'NoBossly asks what kind of creator you are and then measures you in the right unit — followers if you are on social, monthly visitors if you publish — against the sizes where each actually starts paying: around 10,000 followers, around 50,000 visits a month. Then a ladder where the levels are real: first paid collaboration, first $1k month, the day the channel out-earns the job.',
      pains: [
        'You have posted before and stopped, and you are not sure why it did not stick.',
        'Everyone says "be consistent" without asking what time you get home.',
        'The advice is written for people who already have an audience — and it measures a blogger and an influencer with the same ruler.'
      ],
      truth: 'An audience is a slow asset, and a salary is what buys you the time to build one. Sponsorship money starts around 10,000 followers; ad and affiliate money starts around 50,000 visits a month. If your runway is three months, the plan has to earn well before either — and your fit test will say so out loud.'
    },
    core: [
      stageQuestion('Where are you with it?', [
        'Not started — no audience yet', 'Posting occasionally', 'Posting consistently, no income',
        'Earning something', 'This is my main income'
      ]),
      { name: 'creator_type', label: 'What kind of creator?', type: 'select', required: true,
        options: CREATOR_TYPES,
        hint: 'This decides which number your plan is measured in — an audience you follow, or traffic you receive.' },
      { name: 'platform', label: 'Main platform', type: 'select', required: true,
        options: ['YouTube', 'TikTok', 'Instagram', 'X / Twitter', 'LinkedIn', 'Twitch', 'Newsletter', 'Podcast', 'Blog', 'Undecided'] },
      { name: 'niche', label: 'What is it about?', type: 'text', required: true,
        placeholder: 'the narrower the better — "budget van builds", not "lifestyle"' },
      // A follower count and a monthly visitor count are not the same number and
      // do not become money at the same scale, so the question asked depends on
      // which kind of creator this is. showIf hides the one that does not apply.
      { name: 'audience_size', label: 'Followers or subscribers you have now', type: 'select',
        showIf: { creator_type: SOCIAL_CREATOR_TYPES },
        options: ['None yet', 'Under 1,000', '1,000–10,000', '10,000–50,000', '50,000–250,000', '250,000+'],
        hint: 'Sponsorship offers realistically start arriving around 10,000.' },
      { name: 'monthly_traffic', label: 'Monthly visitors you get now', type: 'select',
        showIf: { creator_type: PUBLISHER_CREATOR_TYPES },
        options: ['Under 1,000', '1,000–10,000', '10,000–50,000', '50,000–250,000', '250,000+'],
        hint: 'Ad and affiliate revenue realistically starts mattering around 50,000 a month.' },
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
    marketing: {
      headline: 'Freelancing is a business. Most freelancing advice treats it like a hobby with invoices.',
      subhead: 'NoBossly holds your rate against the hours you have outside your job and the income that would actually replace it, tells you plainly when the arithmetic does not work — then gives you the quests that fix it.',
      pains: [
        'You are busy in the evenings and still nowhere near replacing the salary.',
        'Every month starts from zero because the work is all one-off.',
        'You have never raised your rate because you do not know what happens if you do.'
      ],
      truth: 'Hours times rate is a hard ceiling, and while you have a job those hours are few. We do that multiplication in front of you — including what the number has to be before handing in your notice is arithmetic rather than nerve.'
    },
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
    marketing: {
      headline: 'You already know things people pay for. The hard part is charging for the outcome.',
      subhead: 'The job that is wearing you out is also where your expertise came from. NoBossly turns it into an offer with a named result and a price that follows it — then tests that offer against the evenings you actually have.',
      pains: [
        'You give away the good advice on the call and get paid for the paperwork.',
        'You price by the hour because naming a number for the result feels like nerve.',
        'You have a decade of results at work and nothing written down that is yours.'
      ],
      truth: 'An offer described as sessions and calls gets priced like sessions and calls. Your fit test asks whether you can name the outcome — because that one question decides your rate.'
    },
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
    marketing: {
      headline: 'The work is local. Almost none of the advice is.',
      subhead: 'NoBossly builds your fit test around the things that actually decide a local trade: your travel radius, your licensing, your kit, whether there is enough of the work near you — and whether enough of it happens outside your working hours to start before you quit.',
      pains: [
        'You can do the work. Finding it — around a shift pattern — is the part nobody teaches.',
        'You are quoting blind because you do not know your win rate.',
        'Half the day goes on driving you do not get paid for.'
      ],
      truth: 'Drive time is unpaid. A job type that only comes up twice a month within range cannot fill a week, and your fit test will ask that before you buy the van.'
    },
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
    marketing: {
      headline: 'The lease is the point of no return. Everything useful happens before you sign it.',
      subhead: 'This is the one path that usually asks you to quit first, so NoBossly puts the numbers in front of you before you sign anything — your break-even day, your rent ceiling at half the takings you hope for — and gives you ways to test the concept while you are still being paid.',
      pains: [
        'The landlord\'s footfall figure is the only footfall figure you have.',
        'You have a fit-out budget, no break-even number, and a salary you would be giving up.',
        'Everyone is encouraging and nobody has done the arithmetic with you.'
      ],
      truth: 'Rent is due whether anyone walks in or not. A concept that only breaks even when it is full is a concept that fails on a quiet Tuesday — so we ask about half capacity, not best case.'
    },
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
    blurb: 'You run the shop — sourcing, curating or reselling products rather than inventing them.',
    marketing: {
      headline: 'Selling is easy. Selling at a margin that survives advertising is the business.',
      subhead: 'NoBossly makes you cost a unit properly — product, shipping, packaging, fees, returns — and then asks the two questions that decide everything: is there anything left to find a buyer with, and can it be packed and posted in the hours you have?',
      pains: [
        'Orders are coming in, the bank account is not growing, and you still need the job.',
        'You are one of ten identical listings and price is the only lever left.',
        'You do not know your real margin, only your rough one.'
      ],
      truth: 'This is how online stores die: a product that sells fine and still loses money once ads are counted. Your fit test asks about it on day one, not in month nine.'
    },
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
    slug: 'physical_product',
    // Left off the public site on request. The path still works end to end for
    // anyone who picks it in the app; it simply has no landing page and does
    // not appear in the marketing path list.
    marketing: false,
    label: 'Physical product',
    emoji: '🔧',
    blurb: 'You make the thing itself — designing, prototyping and manufacturing something that did not exist.',
    core: [
      stageQuestion('Where are you with it?', [
        'Just an idea', 'Sketches or a concept', 'Prototype made',
        'Samples from a manufacturer', 'Selling it', 'In shops or retailers'
      ]),
      { name: 'product', label: 'What is the product?', type: 'text', required: true,
        placeholder: 'what it is and what it does, in one line' },
      { name: 'made_how', label: 'How it would be made', type: 'select', required: true,
        options: ['I make each one by hand', 'A small workshop or maker space', 'A contract manufacturer locally',
                  'A contract manufacturer overseas', '3D printed or print-on-demand', 'Not sure yet'] },
      { name: 'unit_cost_known', label: 'Do you know what one unit costs to make?', type: 'select', required: true,
        options: ['Yes, to the penny', 'Roughly', 'No'],
        hint: 'This is the number the whole business rests on. Everything else is downstream of it.' },
      { name: 'sell_where', label: 'Where it would sell', type: 'checks',
        options: ['Direct to people online', 'Wholesale to independent shops', 'Retail chains',
                  'Markets and fairs', 'Amazon or Etsy', 'Licensing it to a company'] }
    ],
    depth: [
      { name: 'moq', label: 'Smallest run a manufacturer would accept', type: 'select',
        options: ['Under 50', '50–250', '250–1,000', '1,000+', 'Have not asked yet'] },
      { name: 'tooling_cost', label: 'Up-front tooling or mould cost', type: 'select',
        options: ['None needed', 'Under $1,000', '$1,000–10,000', '$10,000+', 'Not quoted yet'] },
      { name: 'certification', label: 'Testing or certification it needs', type: 'checks',
        options: ['None', 'CE / UKCA', 'FDA or food safety', 'Electrical safety',
                  "Children's toy safety", 'Cosmetics regulations', 'Not sure'] },
      { name: 'ip_position', label: 'Protection you have or want', type: 'checks',
        options: ['Patent filed', 'Patent considered', 'Design registration', 'Trademark',
                  'None — being first is the plan'] }
    ]
  },

  {
    slug: 'software',
    label: 'Software or app',
    emoji: '⌨️',
    blurb: 'You build a product people use — a web app, mobile app, tool or plugin.',
    marketing: {
      headline: 'Building it was never the hard part.',
      subhead: 'NoBossly keeps the scope inside what you can actually build in evenings — your hands, no-code, or a budget — and weighs distribution as hard as the build, because that is what ends most software long before the day job does.',
      pains: [
        'The feature list keeps growing, the launch keeps moving, and Monday keeps arriving.',
        'You could build it. You have no idea how anyone would find it.',
        'You are not sure whether people use something else already, or nothing at all.'
      ],
      truth: '"Nothing" is usually wrong and always worth checking — a spreadsheet counts. Software with no distribution plan is a hobby with a deployment pipeline.'
    },
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
    marketing: {
      headline: 'Knowing you want out is enough to start. You do not need the idea yet.',
      subhead: 'Answer seven questions and NoBossly draws your Compass — your archetype, the hours and runway you genuinely have, and the territories where you actually hold an edge. It never picks for you.',
      pains: [
        'You want out of your job and every list of business ideas feels written for someone else.',
        'You have skills your employer profits from and no obvious way to sell them yourself.',
        'You are worried about picking wrong and losing a year of evenings to it.'
      ],
      truth: 'Most people do not need more ideas. They need a way to rule ideas out quickly, because the scarce thing is not inspiration — it is the evenings between now and getting out.'
    },
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

// Paths with a public landing page. A path can be live in the product without
// being marketed — see physical_product.
const MARKETED = PATHS.filter(p => p.marketing);
const isPath = slug => Object.prototype.hasOwnProperty.call(BY_SLUG, slug);
const get = slug => BY_SLUG[slug] || null;

// The full question list for a path, in the order it is asked. Universal
// constraints first — they are short, they are the same every time, and they
// are what the fit test is built from.
function coreQuestions(slug) {
  const p = get(slug);
  return p ? UNIVERSAL_CORE.concat(p.core) : UNIVERSAL_CORE.slice();
}

// The questions that belong to THIS path, as opposed to the six everyone
// answers. Not the same as "questions without a column": the exploring path's
// own questions (skills, the problem you keep noticing) legitimately write to
// existing columns, and filtering on that would have left its landing page
// showing a single card.
function ownQuestions(slug) {
  const p = get(slug);
  if (!p) return [];
  const universal = new Set(UNIVERSAL_CORE.map(q => q.name));
  return p.core.filter(q => !universal.has(q.name));
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
  PATHS, SLUGS, MARKETED, BY_SLUG, isPath, get, describe, stageOf, hasSubject,
  UNIVERSAL_CORE, UNIVERSAL_DEPTH,
  coreQuestions, ownQuestions, depthQuestions, depthSteps, totalSteps,
  REQUIRED_STEPS: 2,
  HOURS, BUDGET, RUNWAY, INCOME, WORK_STATUS,
  CREATOR_AUDIENCE, CREATOR_TYPES, SOCIAL_CREATOR_TYPES, PUBLISHER_CREATOR_TYPES, creatorAudience,
  showIfSatisfied
};
