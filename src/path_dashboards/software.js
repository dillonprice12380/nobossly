// ⌨️ Apps & Software (docs/path-dashboards.md). Before launch the honest number
// is people asking for it (waitlist sign-ups); once it is live with users it is
// paying customers, and MRR beside it.
const { registry } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineMetric({ key: 'sw_waitlist', label: 'Waitlist sign-ups', unit: 'count', period: 'month',
  help: 'Total people on the waitlist or beta list at the end of the month.' });
registry.defineMetric({ key: 'sw_active', label: 'Active users', unit: 'count', period: 'month',
  help: 'People who used it this month — your own definition, kept the same every month.' });
registry.defineMetric({ key: 'sw_paying', label: 'Paying customers', unit: 'count', period: 'month' });
registry.defineMetric({ key: 'sw_mrr', label: 'Monthly recurring revenue', unit: 'money', period: 'month', fromIncome: 'recurring',
  help: 'What subscriptions bring in each month, at the end of the month.' });
registry.defineMetric({ key: 'sw_churn', label: 'Churn', unit: 'percent', period: 'month', higherIsBetter: false,
  help: 'Paying customers lost this month ÷ paying customers at the start of it.' });

registry.defineBoard({
  key: 'sw_roadmap', label: 'Feedback & roadmap', emoji: '🗺️', itemLabel: 'request',
  help: 'Every request users make, one card each. Add a vote each time someone else asks for the same thing.',
  stages: [
    { key: 'requested', label: 'Requested' },
    { key: 'planned', label: 'Planned' },
    { key: 'building', label: 'Building' },
    { key: 'shipped', label: 'Shipped', done: true }
  ],
  dueLabel: 'Target date',
  fields: [
    { key: 'votes', label: 'Times asked for', type: 'number' },
    { key: 'kind', label: 'Kind', type: 'select', options: ['Bug', 'Feature', 'Improvement', 'Question'] },
    { key: 'why', label: 'The problem behind it', type: 'longtext' }
  ]
});

registry.defineBoard({
  key: 'sw_beta', label: 'Beta testers', emoji: '🧪', itemLabel: 'tester',
  help: 'First users by name (first names or handles are enough). Activated means they got to the moment it is useful.',
  stages: [
    { key: 'invited', label: 'Invited' },
    { key: 'signed_up', label: 'Signed up' },
    { key: 'activated', label: 'Activated' },
    { key: 'paying', label: 'Paying', done: true }
  ],
  dueLabel: 'Follow up on',
  fields: [
    { key: 'source', label: 'Found us via', type: 'text' },
    { key: 'feedback', label: 'What they said', type: 'longtext' }
  ]
});

registry.defineBoard({
  key: 'sw_sales', label: 'Sales pipeline', emoji: '💼', itemLabel: 'deal',
  help: 'For selling to businesses: demo → trial → paid. The value is the yearly contract.',
  stages: [
    { key: 'lead', label: 'Lead' },
    { key: 'demo', label: 'Demo' },
    { key: 'trial', label: 'Trial' },
    { key: 'won', label: 'Paid', done: true }
  ],
  valueLabel: 'Yearly value', valueKind: 'money', dueLabel: 'Next step by',
  fields: [{ key: 'next_step', label: 'Next step', type: 'text' }]
});

defineWorksheet('sw_mvp_scope', {
  label: 'MVP scope', emoji: '✂️', layout: 'form',
  blurb: 'Must, should, won\'t. Keeps the first version small enough to ship.',
  titleLabel: 'Product or version', titlePlaceholder: 'e.g. v1 — invoicing for dog walkers',
  sections: [
    { key: 'problem', label: 'The one problem v1 solves', type: 'longtext' },
    { key: 'user', label: 'For exactly who', type: 'text' },
    { key: 'must', label: 'Must have', type: 'list', help: 'Without these it does not solve the problem at all. Aim for three to five.' },
    { key: 'should', label: 'Should have (after launch)', type: 'list' },
    { key: 'wont', label: 'Won\'t have (for now)', type: 'list', help: 'Write these down so you stop thinking about them.' },
    { key: 'success', label: 'How you will know v1 works', type: 'text', help: 'e.g. 10 people use it twice in a week' },
    { key: 'ship_by', label: 'Ship by', type: 'date' }
  ]
});

defineWorksheet('sw_pricing', {
  label: 'Pricing tiers', emoji: '💳', layout: 'form',
  blurb: '$5 × 200 customers or $500 × 2? Plan the tiers and see how many customers each goal needs.',
  titleLabel: 'Plan name', titlePlaceholder: 'e.g. Launch pricing',
  sections: [
    { key: 'goal', label: 'Monthly revenue goal', type: 'money' },
    { key: 't1_name', label: 'Tier 1 name', type: 'text' },
    { key: 't1_price', label: 'Tier 1 price per month', type: 'money' },
    { key: 't1_includes', label: 'Tier 1 includes', type: 'list' },
    { key: 't2_name', label: 'Tier 2 name', type: 'text' },
    { key: 't2_price', label: 'Tier 2 price per month', type: 'money' },
    { key: 't2_includes', label: 'Tier 2 includes', type: 'list' },
    { key: 't3_name', label: 'Tier 3 name', type: 'text' },
    { key: 't3_price', label: 'Tier 3 price per month', type: 'money' },
    { key: 't3_includes', label: 'Tier 3 includes', type: 'list' },
    { key: 'free', label: 'Free plan or trial', type: 'select', options: ['No free option', 'Free trial', 'Free plan', 'Not sure yet'] },
    { key: 'notes', label: 'Why these prices', type: 'longtext', help: 'What do the alternatives cost? What is the problem worth to them?' }
  ]
});

registry.defineChecklist({
  key: 'sw_validate', label: 'Before you build',
  items: [
    { key: 'problem', label: 'Write the problem in one sentence a customer would say' },
    { key: 'interviews', label: 'Talk to ten people who have it', link: '/tools/interviews' },
    { key: 'would_pay', label: 'Hear "I would pay for that" from three of them, unprompted' },
    { key: 'alternatives', label: 'List what they use today, and what it costs them' },
    { key: 'scope', label: 'Cut v1 down to the musts', link: '/workspace/docs/sw_mvp_scope' },
    { key: 'waitlist', label: 'Put up a one-page waitlist and share it' }
  ]
});

registry.defineChecklist({
  key: 'sw_launch', label: 'Launch',
  items: [
    { key: 'onboarding', label: 'Watch five people sign up without helping them' },
    { key: 'payments', label: 'Take a real payment end to end' },
    { key: 'privacy', label: 'Publish a privacy policy and terms' },
    { key: 'analytics', label: 'Decide what "active user" means, and measure it' },
    { key: 'welcome_email', label: 'Write the welcome email' },
    { key: 'waitlist_email', label: 'Email the waitlist on launch day' },
    { key: 'directories', label: 'List it in three directories or communities your users read' },
    { key: 'feedback_loop', label: 'Put every request on the roadmap board', link: '/workspace/boards/sw_roadmap' }
  ]
});

const LIVE = ['Live with users', 'Paying customers'];

module.exports = {
  slug: 'software',
  intro: 'Build software people use — and then pay for.',
  stages: [
    { answer: 'Just an idea' },
    { answer: 'Designing it' },
    { answer: 'Building it' },
    { answer: 'Live with no users' },
    { answer: 'Live with users' },
    { answer: 'Paying customers' }
  ],
  northStar: ({ stage }) => (stage === 'Paying customers' ? 'sw_paying' : LIVE.includes(stage) ? 'sw_active' : 'sw_waitlist'),
  supporting: ({ stage }) => (stage === 'Paying customers' ? ['sw_mrr', 'sw_active', 'sw_churn']
    : LIVE.includes(stage) ? ['sw_paying', 'sw_mrr'] : ['sw_active']),
  boards: ({ subpath }) => ['sw_roadmap', 'sw_beta'].concat(subpath === 'saas' ? ['sw_sales'] : []),
  checklists: () => ['sw_validate', 'sw_launch'],
  worksheets: ['sw_mvp_scope', 'sw_pricing']
};
