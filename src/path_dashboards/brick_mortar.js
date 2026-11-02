// 🏪 Brick and mortar (docs/path-dashboards.md) — the largest config. The north
// star moves with the stage: while looking, it is money raised against money
// needed (the funding board); from the lease to opening day, it is the opening
// plan; once open, monthly takings, with rent as a share of takings beside it
// (the path's bar: rent under about 10% of takings).
const { registry, format: { money, percent } } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineMetric({ key: 'bm_takings', label: 'Takings', unit: 'money', period: 'month',
  help: 'Everything through the till this month, before costs.' });
registry.defineMetric({ key: 'bm_rent_share', label: 'Rent as a share of takings', unit: 'percent', period: 'month', higherIsBetter: false,
  help: 'Monthly rent ÷ takings. Under about 10% is healthy for most venues.' });
registry.defineMetric({ key: 'bm_customers', label: 'Customers', unit: 'count', period: 'week',
  help: 'Transactions, covers, appointments or visits — whichever your venue counts.' });
registry.defineMetric({ key: 'bm_avg_spend', label: 'Average spend', unit: 'money', period: 'month',
  help: 'Takings ÷ customers.' });
registry.defineMetric({ key: 'bm_staff_cost', label: 'Staff cost share', unit: 'percent', period: 'month', higherIsBetter: false,
  help: 'Wages and payroll costs ÷ takings.' });

registry.defineBoard({
  key: 'bm_sites', label: 'Site scout', emoji: '🔎', itemLabel: 'site',
  help: 'Every premises you look at, from listing to signed. Score your shortlist side by side in the site comparison.',
  stages: [
    { key: 'listed', label: 'Found' },
    { key: 'shortlist', label: 'Shortlisted' },
    { key: 'viewed', label: 'Viewed' },
    { key: 'offer', label: 'Offer in' },
    { key: 'signed', label: 'Signed', done: true },
    { key: 'passed', label: 'Passed on', done: true }
  ],
  valueLabel: 'Monthly rent', valueKind: 'money', dueLabel: 'Viewing or deadline',
  fields: [
    { key: 'area', label: 'Street or area', type: 'text' },
    { key: 'size', label: 'Size (sq ft)', type: 'number' },
    { key: 'footfall', label: 'Footfall', type: 'select', options: ['Very quiet', 'Quiet', 'Steady', 'Busy', 'Very busy'] },
    { key: 'parking', label: 'Parking and transport', type: 'select', options: ['None nearby', 'Some', 'Good'] },
    { key: 'condition', label: 'Condition', type: 'select', options: ['Shell — needs everything', 'Needs work', 'Ready to fit out', 'Previous similar business'] },
    { key: 'term', label: 'Lease terms offered', type: 'text', placeholder: 'e.g. 5 years, break at 3, 3 months rent-free' },
    { key: 'listing', label: 'Listing link', type: 'url' }
  ]
});

registry.defineBoard({
  key: 'bm_opening', label: 'Opening plan', emoji: '🗓️', itemLabel: 'task',
  help: 'Everything between the keys and day one. Give each a deadline and they line up on the calendar; note what each one waits on.',
  stages: [
    { key: 'todo', label: 'To do' },
    { key: 'doing', label: 'In progress' },
    { key: 'waiting', label: 'Waiting on others' },
    { key: 'done', label: 'Done', done: true }
  ],
  valueLabel: 'Cost', valueKind: 'money', dueLabel: 'Deadline',
  fields: [
    { key: 'area', label: 'Part of the plan', type: 'select', options: ['Permits and licences', 'Inspections', 'Fit-out', 'Equipment', 'Hiring', 'Stock and suppliers', 'Systems and payments', 'Marketing', 'Soft launch'] },
    { key: 'waits_on', label: 'Waits on', type: 'text', placeholder: 'e.g. building permit, landlord sign-off' },
    { key: 'who', label: 'Who is doing it', type: 'text' }
  ]
});

registry.defineBoard({
  key: 'bm_funding', label: 'Funding', emoji: '🏦', itemLabel: 'source',
  help: 'Every source of money for the opening: savings, loans, grants, investors. Drawn means it is in the account.',
  stages: [
    { key: 'researching', label: 'Researching' },
    { key: 'applied', label: 'Applied' },
    { key: 'approved', label: 'Approved' },
    { key: 'drawn', label: 'In the bank', done: true },
    { key: 'declined', label: 'Declined', done: true }
  ],
  valueLabel: 'Amount', valueKind: 'money', dueLabel: 'Decision expected',
  fields: [
    { key: 'kind', label: 'Kind', type: 'select', options: ['Own savings', 'Bank loan', 'SBA or government-backed loan', 'Grant', 'Investor', 'Family and friends', 'Crowdfunding', 'Equipment finance', 'Other'] },
    { key: 'terms', label: 'Terms', type: 'text', placeholder: 'e.g. 7.5% over 5 years, personal guarantee' }
  ]
});

registry.defineBoard({
  key: 'bm_staff', label: 'Staffing plan', emoji: '👥', itemLabel: 'role',
  help: 'One card per role. The value is its monthly cost including payroll taxes, so you can see the wage bill before you hire.',
  stages: [
    { key: 'planned', label: 'Planned' },
    { key: 'advertising', label: 'Advertising' },
    { key: 'interviewing', label: 'Interviewing' },
    { key: 'hired', label: 'Hired', done: true }
  ],
  valueLabel: 'Monthly cost', valueKind: 'money', dueLabel: 'Start date',
  fields: [
    { key: 'hours', label: 'Hours a week', type: 'number' },
    { key: 'rate', label: 'Hourly rate', type: 'money' },
    { key: 'kind', label: 'Kind', type: 'select', options: ['Full time', 'Part time', 'Weekends', 'Seasonal', 'Contractor'] }
  ]
});

defineWorksheet('bm_site_compare', {
  label: 'Site comparison', emoji: '⚖️', layout: 'matrix',
  blurb: 'Score your shortlisted premises side by side on what matters for your venue.',
  titleLabel: 'Search', titlePlaceholder: 'e.g. Café premises, spring 2027',
  optionsLabel: 'Premises', optionsHelp: 'Two to five places you have viewed.',
  defaultCriteria: ['Rent against expected takings', 'Footfall', 'Size and layout', 'Condition and fit-out cost', 'Lease terms', 'Parking and transport', 'Competition nearby']
});

const sumOf = (d, keys) => keys.reduce((n, k) => n + (d[k] || 0), 0);
const STARTUP = ['deposit', 'legal', 'fitout', 'equipment', 'stock', 'licences', 'signage', 'launch', 'contingency'];

defineWorksheet('bm_startup', {
  label: 'Start-up & fit-out budget', emoji: '🧱', layout: 'form',
  blurb: 'Everything it costs to open the doors, plus months of running costs in the bank. Lenders will ask for exactly this.',
  titleLabel: 'Version', titlePlaceholder: 'e.g. Café — lender version',
  sections: [
    { key: 'deposit', label: 'Rent deposit and key money', type: 'money' },
    { key: 'legal', label: 'Legal and professional fees', type: 'money' },
    { key: 'fitout', label: 'Fit-out and building work', type: 'money' },
    { key: 'equipment', label: 'Equipment and furniture', type: 'money' },
    { key: 'stock', label: 'Opening stock', type: 'money' },
    { key: 'licences', label: 'Licences, permits and inspections', type: 'money' },
    { key: 'signage', label: 'Signage and branding', type: 'money' },
    { key: 'launch', label: 'Launch marketing', type: 'money' },
    { key: 'contingency', label: 'Contingency', type: 'money', help: 'Fit-outs almost always overrun. 10–20% of the fit-out is sensible.' },
    { key: 'monthly', label: 'Monthly running costs once open', type: 'money', help: 'Rent, staff, utilities, insurance, software, loan repayments.' },
    { key: 'reserve_months', label: 'Months of running costs to hold in reserve', type: 'number', help: 'Most venues take months to reach break-even. Three to six is common.' },
    { key: 'have', label: 'Money you already have for it', type: 'money' }
  ],
  summary: d => {
    const oneOff = sumOf(d, STARTUP);
    const reserve = (d.monthly || 0) * (d.reserve_months || 0);
    const need = oneOff + reserve;
    if (!need) return [];
    const out = [{ label: 'One-off costs to open', value: money(oneOff) }];
    if (reserve) out.push({ label: 'Running-cost reserve', value: money(reserve) });
    out.push({ label: 'Total needed', value: money(need), tone: 'good' });
    if (d.have) out.push({ label: d.have >= need ? 'Covered' : 'Still to raise', value: money(Math.abs(need - d.have)), tone: d.have >= need ? 'good' : 'bad' });
    if (d.fitout && !d.contingency) out.push({ label: 'No contingency yet', value: 'Add 10–20% of fit-out', tone: 'bad' });
    return out;
  }
});

defineWorksheet('bm_breakeven', {
  label: 'Break-even calculator', emoji: '⚖️', layout: 'form',
  blurb: 'How many customers a day you need to cover rent, staff and costs — before you sign anything.',
  titleLabel: 'Scenario', titlePlaceholder: 'e.g. High Street site, 6 days a week',
  sections: [
    { key: 'rent', label: 'Monthly rent', type: 'money' },
    { key: 'staff', label: 'Monthly staff cost', type: 'money', help: 'Including payroll taxes. Your staffing plan has the total.' },
    { key: 'other_fixed', label: 'Other monthly fixed costs', type: 'money', help: 'Utilities, insurance, software, loan repayments, your own pay.' },
    { key: 'avg_spend', label: 'Average spend per customer', type: 'money' },
    { key: 'cost_pct', label: 'Cost of what you sell (%)', type: 'number', help: 'Ingredients, stock or products as a share of the price. Cafés often 25–35%; retail 40–60%; services low.' },
    { key: 'days', label: 'Days open per month', type: 'number' },
    { key: 'expected', label: 'Customers a day you expect', type: 'number' }
  ],
  summary: d => {
    const fixed = sumOf(d, ['rent', 'staff', 'other_fixed']);
    if (!fixed || !d.avg_spend) return [];
    const perCustomer = d.avg_spend * (1 - (d.cost_pct || 0) / 100);
    if (perCustomer <= 0) return [{ label: 'Each sale loses money', value: 'Check price and cost %', tone: 'bad' }];
    const perMonth = Math.ceil(fixed / perCustomer);
    const takings = perMonth * d.avg_spend;
    const out = [
      { label: 'Kept from each customer after costs', value: money(perCustomer) },
      { label: 'Customers a month to break even', value: perMonth.toLocaleString('en-US') }
    ];
    if (d.days) out.push({ label: 'Customers a day to break even', value: String(Math.ceil(perMonth / d.days)), tone: 'good' });
    out.push({ label: 'Takings needed a month', value: money(takings) });
    if (d.rent) {
      const share = d.rent / takings * 100;
      out.push({ label: 'Rent at break-even takings', value: percent(Math.round(share)), tone: share > 15 ? 'bad' : share <= 10 ? 'good' : undefined });
    }
    if (d.expected && d.days) {
      const profit = (d.expected * d.days) * perCustomer - fixed;
      out.push({ label: 'At your expected customers', value: (profit >= 0 ? 'Profit ' : 'Loss ') + money(Math.abs(profit)) + ' a month', tone: profit >= 0 ? 'good' : 'bad' });
    }
    return out;
  }
});

registry.defineChecklist({
  key: 'bm_lease', label: 'Lease review',
  help: 'A commercial lease is one of the biggest commitments you will make. Have a lawyer read it before you sign.',
  items: [
    { key: 'use', label: 'The permitted use clause allows exactly what you will do (food, alcohol, treatments…)' },
    { key: 'term', label: 'The length, and a break clause you can actually use' },
    { key: 'rent_reviews', label: 'How and when the rent can go up' },
    { key: 'repairs', label: 'Who pays for repairs, the roof, and shared areas' },
    { key: 'fitout_ok', label: 'Landlord consent for your fit-out, and whether you must remove it when you leave' },
    { key: 'hours', label: 'Opening hours and signage are allowed' },
    { key: 'zoning', label: 'Zoning allows your business at this address (check with the city, not only the agent)' },
    { key: 'guarantee', label: 'Whether you are asked for a personal guarantee, and for how much' },
    { key: 'rent_free', label: 'Ask for rent-free months to cover the fit-out' },
    { key: 'lawyer', label: 'A lawyer has reviewed it' }
  ]
});

registry.defineChecklist({
  key: 'bm_permits', label: 'Licences and permits',
  help: 'What you need depends on your venue and your city and state. Your city\'s small-business or permit office can give you the full list — ask early, some take months.',
  items: [
    { key: 'list', label: 'Get the full permit list from your city\'s business or permit office' },
    { key: 'business_licence', label: 'Business licence or registration', expires: true },
    { key: 'occupancy', label: 'Certificate of occupancy for the premises' },
    { key: 'building', label: 'Building permits for the fit-out' },
    { key: 'fire', label: 'Fire safety inspection' },
    { key: 'signage', label: 'Sign permit' },
    { key: 'music', label: 'Music licence if you play music to customers', expires: true },
    { key: 'sales_tax', label: 'Seller\'s permit for sales tax, if your state needs one' }
  ]
});

registry.defineChecklist({
  key: 'bm_food', label: 'Food and drink',
  help: 'Your local health department sets the rules and inspects before you open.',
  items: [
    { key: 'plan_review', label: 'Submit your kitchen plans to the health department before building' },
    { key: 'health_permit', label: 'Food service or health permit', expires: true },
    { key: 'food_handler', label: 'Food safety certification for the manager and food handler cards for staff', expires: true },
    { key: 'inspection', label: 'Pass the pre-opening health inspection' },
    { key: 'allergens', label: 'Allergen information ready for every item' },
    { key: 'liquor', label: 'Liquor licence if you serve alcohol — apply very early', expires: true }
  ]
});

registry.defineChecklist({
  key: 'bm_salon', label: 'Salon and treatment rules',
  items: [
    { key: 'establishment', label: 'Salon or establishment licence from your state board', expires: true },
    { key: 'staff_licences', label: 'Every stylist or therapist holds a current licence', expires: true },
    { key: 'sanitation', label: 'Sanitation and disinfection procedures written down' },
    { key: 'consultation', label: 'Consultation and patch-test records for chemical services' }
  ]
});

registry.defineChecklist({
  key: 'bm_fitness', label: 'Gym and studio rules',
  items: [
    { key: 'waiver', label: 'Member waiver and health questionnaire' },
    { key: 'instructors', label: 'Instructor certifications and first aid', expires: true },
    { key: 'equipment', label: 'Equipment inspection and maintenance log' },
    { key: 'capacity', label: 'Class capacity that matches the fire code' }
  ]
});

registry.defineChecklist({
  key: 'bm_insurance', label: 'Insurance',
  items: [
    { key: 'liability', label: 'General liability', expires: true },
    { key: 'property', label: 'Property and contents, including your fit-out', expires: true },
    { key: 'interruption', label: 'Business interruption', expires: true },
    { key: 'workers', label: 'Workers\' compensation once you employ anyone', expires: true },
    { key: 'lease_required', label: 'Any insurance your lease requires, with the landlord named if asked' }
  ]
});

registry.defineChecklist({
  key: 'bm_opening_week', label: 'Opening week',
  items: [
    { key: 'pos', label: 'Till and card payments tested with real transactions' },
    { key: 'training', label: 'Staff trained, with a run-through of a busy hour' },
    { key: 'soft_launch', label: 'A soft launch for friends, family and neighbours before the public opening' },
    { key: 'stock', label: 'Enough stock for twice the trade you expect' },
    { key: 'google', label: 'Google Business Profile with hours, photos and the opening date', link: 'https://www.google.com/business/' },
    { key: 'neighbours', label: 'Introduce yourself to neighbouring businesses' },
    { key: 'local_press', label: 'Tell local press, newsletters and community groups' },
    { key: 'feedback', label: 'A way to collect feedback in the first month', link: '/surveys' }
  ]
});

const OPEN = 'Open and trading';
const BUILDING = ['Signed or about to sign a lease', 'Fitting out'];
const VENUE = { food: 'bm_food', bar: 'bm_food', salon: 'bm_salon', fitness: 'bm_fitness' };

module.exports = {
  slug: 'brick_mortar',
  intro: 'Open a place people walk into — and keep the rent a small share of what comes through the till.',
  stages: [
    { answer: 'Just an idea', next: 'Work out break-even: how many customers a day the rent you can afford would need.' },
    { answer: 'Looking at premises', next: 'Score your shortlist side by side, and have the full start-up budget before you make an offer.' },
    { answer: 'Signed or about to sign a lease', next: 'Have a lawyer review the lease, then get the permit list from your city — some take months.' },
    { answer: 'Fitting out', next: 'Put every task between now and day one on the opening plan, with deadlines.' },
    { answer: 'Open and trading', next: 'Log takings every month and get rent under about 10% of them.' }
  ],
  northStar: ({ stage }) => (stage === OPEN ? 'bm_takings' : null),
  northStarBoard: ({ stage }) => (stage === OPEN ? null : BUILDING.includes(stage) ? 'bm_opening' : 'bm_funding'),
  supporting: ({ stage }) => (stage === OPEN ? ['bm_rent_share', 'bm_customers', 'bm_avg_spend', 'bm_staff_cost'] : []),
  boards: ({ stage }) => (stage === OPEN ? ['bm_staff']
    : BUILDING.includes(stage) ? ['bm_opening', 'bm_funding', 'bm_staff']
    : ['bm_funding', 'bm_sites']),
  checklists: ({ subpath, stage }) => {
    const venue = VENUE[subpath] ? [VENUE[subpath]] : [];
    if (stage === OPEN) return ['bm_insurance'].concat(venue);
    return ['bm_lease', 'bm_permits'].concat(venue, ['bm_insurance', 'bm_opening_week']);
  },
  worksheets: ['bm_startup', 'bm_breakeven', 'bm_site_compare']
};
