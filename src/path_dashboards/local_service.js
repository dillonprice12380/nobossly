// 🚚 Local service (docs/path-dashboards.md). North star: jobs per week.
// Cleaning, gardening and grooming come back on a cycle, so regular customers
// get their own board with a next-visit date that lands on the calendar.
// Addresses are never stored — the contact filter would refuse them anyway —
// only the town or neighbourhood.
const { registry, format: { money } } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineMetric({ key: 'loc_jobs', label: 'Jobs done', unit: 'count', period: 'week' });
registry.defineMetric({ key: 'loc_revenue', label: 'Booked revenue', unit: 'money', period: 'month' });
registry.defineMetric({ key: 'loc_reviews', label: 'Reviews collected', unit: 'count', period: 'month',
  help: 'Total public reviews (Google, Nextdoor, Facebook…) at the end of the month.' });
registry.defineMetric({ key: 'loc_repeat', label: 'Repeat customers', unit: 'count', period: 'month',
  help: 'Customers this month who had used you before.' });

const AREA = { key: 'area', label: 'Area', type: 'text', placeholder: 'Town or neighbourhood — not the address' };

registry.defineBoard({
  key: 'loc_jobs', label: 'Jobs', emoji: '🧰', itemLabel: 'job',
  help: 'Every enquiry through to paid. Give booked jobs a date to see your week on the calendar.',
  stages: [
    { key: 'enquiry', label: 'Enquiry' },
    { key: 'quoted', label: 'Quoted' },
    { key: 'booked', label: 'Booked' },
    { key: 'done', label: 'Done' },
    { key: 'paid', label: 'Paid', done: true }
  ],
  valueLabel: 'Job value', valueKind: 'money', dueLabel: 'Job date',
  fields: [
    AREA,
    { key: 'service', label: 'Service', type: 'text' },
    { key: 'source', label: 'Found you via', type: 'select', options: ['Word of mouth', 'Google', 'Nextdoor', 'Facebook', 'Flyer or van', 'Repeat customer', 'Other'] },
    { key: 'review', label: 'Asked for a review', type: 'select', options: ['Not yet', 'Asked', 'Left one'] }
  ]
});

registry.defineBoard({
  key: 'loc_regulars', label: 'Regular customers', emoji: '🔁', itemLabel: 'customer',
  help: 'People on a cycle. Set the next visit date and they show up on the calendar, so nobody slips through.',
  stages: [
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'ended', label: 'Ended', done: true }
  ],
  valueLabel: 'Value per visit', valueKind: 'money', dueLabel: 'Next visit',
  fields: [
    AREA,
    { key: 'frequency', label: 'How often', type: 'select', options: ['Weekly', 'Every two weeks', 'Monthly', 'Every few months', 'Seasonal'] },
    { key: 'notes', label: 'Notes', type: 'longtext', placeholder: 'e.g. side gate code is with the customer, dog is friendly' }
  ]
});


defineWorksheet('loc_quote', {
  label: 'Quote builder', emoji: '🧮', layout: 'form',
  blurb: 'Labour, materials and call-out in one place, with the total worked out. Duplicate it for the next job.',
  titleLabel: 'Job', titlePlaceholder: 'e.g. Fence repair, Oak Park',
  sections: [
    { key: 'job', label: 'What the job is', type: 'longtext' },
    { key: 'hours', label: 'Labour hours', type: 'number' },
    { key: 'rate', label: 'Hourly rate', type: 'money' },
    { key: 'materials', label: 'Materials', type: 'money' },
    { key: 'markup', label: 'Markup on materials (%)', type: 'number', help: '10–20% covers your time buying and collecting them.' },
    { key: 'callout', label: 'Call-out or travel', type: 'money' },
    { key: 'minimum', label: 'Your minimum job', type: 'money' },
    { key: 'valid_until', label: 'Quote valid until', type: 'date' },
    { key: 'status', label: 'Status', type: 'select', options: ['Draft', 'Sent', 'Accepted', 'Declined'] }
  ],
  summary: d => {
    const labour = (d.hours || 0) * (d.rate || 0);
    const materials = (d.materials || 0) * (1 + (d.markup || 0) / 100);
    const sum = labour + materials + (d.callout || 0);
    if (!sum) return [];
    const total = Math.max(sum, d.minimum || 0);
    const out = [];
    if (labour) out.push({ label: 'Labour', value: money(labour) });
    if (materials) out.push({ label: 'Materials' + (d.markup ? ' with markup' : ''), value: money(materials) });
    out.push({ label: 'Quote total', value: money(total), tone: 'good' });
    if (d.minimum && sum < d.minimum) out.push({ label: 'Raised to your minimum job', value: money(d.minimum) });
    return out;
  }
});

defineWorksheet('loc_price_list', {
  label: 'Service area & prices', emoji: '📍', layout: 'form',
  blurb: 'Where you work, your call-out radius, your minimum job and your standard prices — so quoting takes a minute.',
  titleLabel: 'Name', titlePlaceholder: 'e.g. 2027 prices',
  sections: [
    { key: 'area', label: 'Area you cover', type: 'text' },
    { key: 'radius', label: 'Call-out radius (miles)', type: 'number' },
    { key: 'callout', label: 'Call-out charge', type: 'money' },
    { key: 'minimum', label: 'Minimum job', type: 'money' },
    { key: 'rate', label: 'Standard hourly rate', type: 'money' },
    { key: 'services', label: 'Services and prices', type: 'list', help: 'One per line, e.g. "Lawn cut, small garden — $40"' },
    { key: 'extras', label: 'Extras and surcharges', type: 'list', help: 'e.g. weekends +25%, waste removal $30' }
  ]
});

defineWorksheet('loc_equipment', {
  label: 'Equipment & start-up costs', emoji: '🛠️', layout: 'form',
  blurb: 'What you have, what you need to buy or rent, and what it costs before the first job.',
  titleLabel: 'Name', titlePlaceholder: 'e.g. Starting kit',
  sections: [
    { key: 'have', label: 'Already have', type: 'list' },
    { key: 'buy', label: 'Need to buy', type: 'list', help: 'One per line, with a rough price.' },
    { key: 'rent', label: 'Rent or borrow instead', type: 'list' },
    { key: 'buy_total', label: 'Cost to buy', type: 'money' },
    { key: 'other_startup', label: 'Other start-up costs', type: 'money', help: 'Licences, insurance, website, uniform, signage.' },
    { key: 'monthly', label: 'Monthly running costs', type: 'money', help: 'Fuel, insurance, phone, subscriptions.' },
    { key: 'avg_job', label: 'Average job value', type: 'money' }
  ],
  summary: d => {
    const startup = (d.buy_total || 0) + (d.other_startup || 0);
    const out = [];
    if (startup) out.push({ label: 'Start-up total', value: money(startup) });
    if (startup && d.avg_job) out.push({ label: 'Jobs to pay it back', value: String(Math.ceil(startup / d.avg_job)) });
    if (d.monthly && d.avg_job) out.push({ label: 'Jobs a month to cover running costs', value: String(Math.ceil(d.monthly / d.avg_job)) });
    return out;
  }
});

registry.defineChecklist({
  key: 'loc_licences', label: 'Licences and insurance',
  help: 'What you need depends on your trade and where you work — your city or county licensing office is the place to check. Add renewal dates so nothing lapses.',
  items: [
    { key: 'check', label: 'Check which licences your trade needs where you work' },
    { key: 'business_licence', label: 'Local business licence or registration', expires: true },
    { key: 'trade_licence', label: 'Trade licence or certification, if your work needs one', expires: true },
    { key: 'liability', label: 'General liability insurance', expires: true },
    { key: 'tools_cover', label: 'Cover for your tools and equipment', expires: true },
    { key: 'background', label: 'Background check, if you work in homes or with children or pets', expires: true },
    { key: 'certs', label: 'Any safety certificates (e.g. pesticide, gas, electrical)', expires: true }
  ]
});

registry.defineChecklist({
  key: 'loc_vehicle', label: 'Vehicle and travel',
  items: [
    { key: 'business_use', label: 'Tell your insurer the vehicle is used for business', expires: true },
    { key: 'mileage', label: 'Log business miles — they are usually deductible', link: '/tools/tax' },
    { key: 'kit', label: 'A tidy, organised kit so jobs start on time' },
    { key: 'signage', label: 'Your name and number on the vehicle (optional, but it gets calls)' }
  ]
});

registry.defineChecklist({
  key: 'loc_first_job', label: 'Before the first job',
  items: [
    { key: 'prices', label: 'Write your price list and minimum job', link: '/workspace/docs/loc_price_list' },
    { key: 'quote', label: 'Have a quote template ready', link: '/workspace/docs/loc_quote' },
    { key: 'payment', label: 'Decide how customers pay you, and when' },
    { key: 'terms', label: 'Simple terms: cancellations, deposits, what happens if it rains' },
    { key: 'profile', label: 'A free Google Business Profile', link: 'https://www.google.com/business/' },
    { key: 'reviews', label: 'A short message asking for a review after every job' },
    { key: 'photos', label: 'Before and after photos of every job (with permission)' }
  ]
});

module.exports = {
  slug: 'local_service',
  intro: 'Do good work for people nearby — and fill the week with it.',
  stages: [
    { answer: 'Not started', next: 'Set your prices and minimum job, then do three jobs for people you know — and ask each for a review.' },
    { answer: 'A few jobs for people I know', next: 'Get your first job from a stranger: a Google Business Profile and five reviews usually do it.' },
    { answer: 'Regular work coming in', next: 'Turn one-off customers into regulars on a cycle — it smooths out the weeks.' },
    { answer: 'Booked out', next: 'Raise your prices for new customers, or narrow your area so less of the day is driving.' },
    { answer: 'Running it with help', next: 'Write down how each job is done so a helper can do it without you.' }
  ],
  northStar: () => 'loc_jobs',
  supporting: () => ['loc_revenue', 'loc_repeat', 'loc_reviews'],
  boards: () => ['loc_jobs', 'loc_regulars'],
  checklists: () => ['loc_licences', 'loc_vehicle', 'loc_first_job'],
  worksheets: ['loc_quote', 'loc_price_list', 'loc_equipment']
};
