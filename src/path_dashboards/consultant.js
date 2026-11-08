// 🧠 Coach or consultant (docs/path-dashboards.md). North star: paying clients
// this month. Discovery calls feed it; recorded client results become the
// proof that wins the next ones.
const { registry, format: { money } } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineMetric({ key: 'con_clients', label: 'Paying clients', unit: 'count', period: 'month',
  help: 'Clients you were paid by (or who were mid-package) this month.' });
registry.defineMetric({ key: 'con_revenue', label: 'Revenue', unit: 'money', period: 'month', fromIncome: 'all' });
registry.defineMetric({ key: 'con_calls', label: 'Discovery calls held', unit: 'count', period: 'month',
  help: 'Calls with someone who might buy — not chats with existing clients.' });
registry.defineMetric({ key: 'con_close_rate', label: 'Close rate', unit: 'percent', period: 'month',
  help: 'Calls that became paying clients ÷ calls held.' });

registry.defineBoard({
  key: 'con_calls', label: 'Discovery calls', emoji: '📞', itemLabel: 'call',
  help: 'Every conversation that could become a client. Note why each one was won or lost — the pattern is your next improvement.',
  stages: [
    { key: 'booked', label: 'Booked' },
    { key: 'held', label: 'Held' },
    { key: 'proposal', label: 'Proposal sent' },
    { key: 'won', label: 'Won', done: true },
    { key: 'lost', label: 'Not now', done: true }
  ],
  valueLabel: 'Package value', valueKind: 'money', dueLabel: 'Call or follow-up date',
  fields: [
    { key: 'source', label: 'Came from', type: 'select', options: ['Referral', 'Content', 'Talk or workshop', 'LinkedIn', 'Lead magnet', 'Cold outreach', 'Other'] },
    { key: 'problem', label: 'Their problem, in their words', type: 'longtext' },
    { key: 'why', label: 'Why won or lost', type: 'text' }
  ]
});

registry.defineBoard({
  key: 'con_roster', label: 'Clients & sessions', emoji: '🗂️', itemLabel: 'client',
  help: 'One card per client engagement. Record the result they got before you move it to Completed — it becomes a case study.',
  stages: [
    { key: 'onboarding', label: 'Onboarding' },
    { key: 'active', label: 'Active' },
    { key: 'wrapping', label: 'Wrapping up' },
    { key: 'completed', label: 'Completed', done: true }
  ],
  valueLabel: 'Package price', valueKind: 'money', dueLabel: 'Next session',
  fields: [
    { key: 'sessions_total', label: 'Sessions in the package', type: 'number' },
    { key: 'sessions_used', label: 'Sessions used', type: 'number' },
    { key: 'goal', label: 'Their goal', type: 'longtext' },
    { key: 'result', label: 'The result they got', type: 'longtext', placeholder: 'In numbers or their own words' }
  ]
});

defineWorksheet('con_offer', {
  label: 'Offer builder', emoji: '🎁', layout: 'form',
  blurb: 'Your signature offer — who it is for, the outcome, what is included and the price — with a smaller and a bigger option either side.',
  titleLabel: 'Offer name', titlePlaceholder: 'e.g. The 90-day Pricing Reset',
  sections: [
    { key: 'for_who', label: 'Who it is for', type: 'longtext', help: 'Specific enough that the right person thinks "that is me".' },
    { key: 'outcome', label: 'The outcome they get', type: 'longtext' },
    { key: 'included', label: 'What is included', type: 'list' },
    { key: 'length', label: 'How long it runs', type: 'text' },
    { key: 'price', label: 'Price', type: 'money' },
    { key: 'guarantee', label: 'Guarantee or promise', type: 'longtext', help: 'Only what you can keep. "Not a fit after the first session? Full refund" is a real guarantee.' },
    { key: 'small_name', label: 'Smaller offer (a way to start)', type: 'text', help: 'e.g. a single strategy session' },
    { key: 'small_price', label: 'Smaller offer price', type: 'money' },
    { key: 'big_name', label: 'Bigger offer (for those who want more)', type: 'text', help: 'e.g. done-with-you over six months' },
    { key: 'big_price', label: 'Bigger offer price', type: 'money' },
    { key: 'not_for', label: 'Who it is not for', type: 'list' }
  ],
  summary: d => {
    const out = [];
    if (d.price) out.push({ label: 'Clients a month for $5,000', value: Math.ceil(5000 / d.price) + ' at ' + money(d.price) });
    if (d.small_price && d.price) out.push({ label: 'Step up from smaller offer', value: (Math.round(d.price / d.small_price * 10) / 10) + '× the price' });
    return out;
  }
});

defineWorksheet('con_lead_magnet', {
  label: 'Lead magnet', emoji: '🧲', layout: 'form',
  blurb: 'One free, useful thing that starts conversations with the right people.',
  titleLabel: 'Name', titlePlaceholder: 'e.g. The 10-minute pricing audit',
  sections: [
    { key: 'for_who', label: 'Who it is for', type: 'text' },
    { key: 'problem', label: 'The one problem it helps with', type: 'longtext' },
    { key: 'format', label: 'Format', type: 'select', options: ['Checklist', 'Template', 'Short guide', 'Quiz or scorecard', 'Mini course', 'Free workshop', 'Free call'] },
    { key: 'next_step', label: 'What it invites them to do next', type: 'text', help: 'e.g. book a discovery call' },
    { key: 'share', label: 'Where you will share it', type: 'list' }
  ]
});

registry.defineChecklist({
  key: 'con_scope', label: 'Credentials and scope',
  help: 'Be clear about what you are qualified to do, and say it before anyone pays.',
  items: [
    { key: 'credentials', label: 'List your credentials and experience, honestly' },
    { key: 'scope', label: 'Write down what you do and do not help with' },
    { key: 'referral', label: 'Know who you refer people to when it is outside your scope' },
    { key: 'disclaimer', label: 'Add a plain disclaimer to your site and agreement' },
    { key: 'proof', label: 'Collect results with permission to share them', link: '/tools/proof' }
  ]
});

registry.defineChecklist({
  key: 'con_claims', label: 'What you can and cannot claim',
  help: 'Health and money advice is regulated in most places. When unsure, check with the professional body or regulator for your field and area.',
  items: [
    { key: 'no_diagnose', label: 'Health: no diagnosing, treating or prescribing unless licensed to' },
    { key: 'no_cure', label: 'Health: no promises to cure or reverse conditions' },
    { key: 'no_specific_advice', label: 'Finance: no specific investment, tax or legal advice unless licensed to' },
    { key: 'no_guarantee', label: 'No guaranteed results, earnings or returns' },
    { key: 'testimonials', label: 'Testimonials show typical results, or say clearly that they are not typical', link: 'https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews' },
    { key: 'insurance', label: 'Check whether you need professional liability insurance' }
  ]
});

registry.defineChecklist({
  key: 'con_agreements', label: 'Agreements',
  items: [
    { key: 'agreement', label: 'A short client agreement: scope, sessions, price, refunds' },
    { key: 'cancellation', label: 'A cancellation and rescheduling policy' },
    { key: 'confidentiality', label: 'Confidentiality — and its limits' },
    { key: 'waiver', label: 'Health and fitness: a waiver and a pre-start questionnaire' },
    { key: 'records', label: 'Decide where client notes live and how long you keep them' }
  ]
});

registry.defineChecklist({
  key: 'con_booking', label: 'Booking and payment',
  items: [
    { key: 'calendar', label: 'A booking link for discovery calls' },
    { key: 'call_script', label: 'A simple call structure: their situation, the goal, the gap, the offer' },
    { key: 'payment', label: 'Take payment before the first session' },
    { key: 'plans', label: 'Decide whether you offer payment plans' },
    { key: 'tax', label: 'Put tax aside from every payment', link: '/tools/tax' }
  ]
});


module.exports = {
  slug: 'consultant',
  intro: 'Turn what you know into paid outcomes for clients.',
  stages: [
    { answer: 'Not started' },
    { answer: 'Advised a few people informally' },
    { answer: 'Been paid for it once or twice' },
    { answer: 'Regular paying clients' },
    { answer: 'This is my main income' }
  ],
  northStar: () => 'con_clients',
  supporting: () => ['con_revenue', 'con_calls', 'con_close_rate'],
  boards: () => ['con_calls', 'con_roster'],
  checklists: ({ subpath }) => ['con_scope']
    .concat(subpath === 'health' || subpath === 'finance' ? ['con_claims'] : [])
    .concat(['con_agreements', 'con_booking']),
  worksheets: ['con_offer', 'con_lead_magnet']
};
