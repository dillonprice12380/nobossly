// 💻 Freelancer (docs/path-dashboards.md). North star: billable income this
// month. The hours log keeps the rate honest — income ÷ hours worked is the
// rate you actually earn, whatever you quote.
const { registry } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineMetric({ key: 'fl_income', label: 'Billable income', unit: 'money', period: 'month', fromIncome: 'all',
  help: 'Money from client work this month. Type a number to use what you invoiced instead of what was paid.' });
registry.defineMetric({ key: 'fl_hours', label: 'Billable hours', unit: 'count', period: 'week',
  help: 'Hours you could put on an invoice. Admin, pitching and learning do not count.' });
registry.defineMetric({ key: 'fl_active_clients', label: 'Active clients', unit: 'count', period: 'month',
  help: 'Clients you did paid work for this month.' });
registry.defineMetric({ key: 'fl_outreach', label: 'Outreach touches', unit: 'count', period: 'week',
  help: 'Messages, follow-ups and proposals sent to people who might hire you.' });

registry.defineBoard({
  key: 'fl_clients', label: 'Client pipeline', emoji: '🧲', itemLabel: 'client',
  help: 'Every lead, from first message to paid. The value is what the job is worth.',
  stages: [
    { key: 'lead', label: 'Lead' },
    { key: 'talking', label: 'Talking' },
    { key: 'proposal', label: 'Proposal sent' },
    { key: 'won', label: 'Won' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'paid', label: 'Paid', done: true }
  ],
  valueLabel: 'Job value', valueKind: 'money', dueLabel: 'Next step by',
  fields: [
    { key: 'source', label: 'Came from', type: 'select', options: ['Referral', 'Upwork / Fiverr', 'LinkedIn', 'Cold outreach', 'Previous employer', 'My own audience', 'Other'] },
    { key: 'service', label: 'Service', type: 'text' },
    { key: 'next_step', label: 'Next step', type: 'text', placeholder: 'e.g. send revised quote' }
  ]
});

registry.defineBoard({
  key: 'fl_invoices', label: 'Invoices', emoji: '🧾', itemLabel: 'invoice',
  help: 'Sent, due, chased, paid. Put the due date on each so overdue ones stand out on the calendar.',
  stages: [
    { key: 'draft', label: 'To send' },
    { key: 'sent', label: 'Sent' },
    { key: 'overdue', label: 'Chasing' },
    { key: 'paid', label: 'Paid', done: true }
  ],
  valueLabel: 'Amount', valueKind: 'money', dueLabel: 'Due date',
  fields: [
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'number', label: 'Invoice number', type: 'text' }
  ]
});

defineWorksheet('fl_proposal', {
  label: 'Proposal & quote', emoji: '📨', layout: 'form',
  blurb: 'Scope, deliverables, timeline and price in one place. Duplicate a winning one as your next template.',
  titleLabel: 'Client or project', titlePlaceholder: 'e.g. Website refresh for a local bakery',
  sections: [
    { key: 'problem', label: 'What they need, in their words', type: 'longtext' },
    { key: 'outcome', label: 'What they get at the end', type: 'longtext', help: 'The result, not the hours.' },
    { key: 'deliverables', label: 'Deliverables', type: 'list' },
    { key: 'not_included', label: 'Not included', type: 'list', help: 'Saying this up front prevents scope creep.' },
    { key: 'timeline', label: 'Timeline', type: 'text', help: 'e.g. Two weeks from deposit' },
    { key: 'revisions', label: 'Rounds of revisions', type: 'number' },
    { key: 'price', label: 'Price', type: 'money' },
    { key: 'deposit', label: 'Deposit before starting', type: 'money', help: '30–50% is normal for new clients.' },
    { key: 'terms', label: 'Payment terms', type: 'text', help: 'e.g. Balance due within 14 days of delivery' },
    { key: 'status', label: 'Status', type: 'select', options: ['Draft', 'Sent', 'Accepted', 'Declined'] }
  ]
});

registry.defineChecklist({
  key: 'fl_contract', label: 'Contract essentials',
  help: 'A short written agreement for every job — an email both sides reply "agreed" to is better than nothing.',
  items: [
    { key: 'scope', label: 'Scope and deliverables, and what is not included' },
    { key: 'timeline', label: 'Timeline and what happens if the client is late with feedback' },
    { key: 'revisions', label: 'How many rounds of revisions, and the rate for extra ones' },
    { key: 'payment', label: 'Price, deposit and payment terms' },
    { key: 'ownership', label: 'Who owns the work, and when (usually on full payment)' },
    { key: 'cancel', label: 'What happens if either side cancels' },
    { key: 'template', label: 'Save it as a template you reuse', link: '/workspace/docs/fl_proposal' }
  ]
});

registry.defineChecklist({
  key: 'fl_paid', label: 'Getting paid',
  items: [
    { key: 'deposit', label: 'Ask new clients for a deposit before starting' },
    { key: 'invoice_tool', label: 'Pick one invoicing tool and use it for every client' },
    { key: 'terms', label: 'Put payment terms and a due date on every invoice' },
    { key: 'late_fee', label: 'Decide your late-payment policy and state it up front' },
    { key: 'chase', label: 'Chase on the due date, not two weeks later', link: '/workspace/boards/fl_invoices' },
    { key: 'tax', label: 'Put tax aside from every payment', link: '/tools/tax' }
  ]
});

registry.defineChecklist({
  key: 'fl_business', label: 'Set up as a business',
  help: 'Rules differ by country and state. Your local small-business office or an accountant can confirm what applies to you.',
  items: [
    { key: 'structure', label: 'Decide how you trade (sole proprietor, LLC, limited company…)' },
    { key: 'register', label: 'Register the business or your trading name if required' },
    { key: 'bank', label: 'Open a separate bank account for business money' },
    { key: 'records', label: 'Keep income and expenses in one place', link: '/budget' },
    { key: 'insurance', label: 'Check whether you need professional liability insurance' },
    { key: 'estimates', label: 'Know your quarterly estimated tax dates', link: '/tools/tax' }
  ]
});

module.exports = {
  slug: 'freelancer',
  intro: 'Sell a skill to clients — and keep the calendar full at a rate worth working for.',
  stages: [
    { answer: 'Not started' },
    { answer: 'A few one-off jobs' },
    { answer: 'Some regular clients' },
    { answer: 'Fully booked' },
    { answer: 'Turning work away' }
  ],
  northStar: () => 'fl_income',
  supporting: () => ['fl_hours', 'fl_active_clients', 'fl_outreach'],
  boards: () => ['fl_clients', 'fl_invoices'],
  checklists: () => ['fl_contract', 'fl_paid', 'fl_business'],
  worksheets: ['fl_proposal']
};
