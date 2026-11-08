// 🔧 Physical product (docs/path-dashboards.md). Before launch there is no
// sales number yet: the development gates are the north star. Once selling,
// it is units sold, with margin beside it. The bill of materials checks the
// keystone rule — can you sell at half retail to a shop and still make money?
const { registry, format: { money, percent } } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineMetric({ key: 'prod_units', label: 'Units sold', unit: 'count', period: 'month' });
registry.defineMetric({ key: 'prod_revenue', label: 'Revenue', unit: 'money', period: 'month', fromIncome: 'all' });
registry.defineMetric({ key: 'prod_margin', label: 'Margin after costs', unit: 'percent', period: 'month' });
registry.defineMetric({ key: 'prod_preorders', label: 'Pre-orders and backers', unit: 'count', period: 'month',
  help: 'Total pre-orders or crowdfunding backers so far.' });
registry.defineMetric({ key: 'prod_pledged', label: 'Pledged or pre-sold', unit: 'money', period: 'month',
  help: 'Total money pledged or pre-sold so far.' });

registry.defineBoard({
  key: 'prod_retailers', label: 'Retailers', emoji: '🏬', itemLabel: 'shop',
  help: 'Shops and stockists, from first approach to reordering. The value is their opening order.',
  stages: [
    { key: 'approached', label: 'Approached' },
    { key: 'samples', label: 'Samples sent' },
    { key: 'ordered', label: 'First order' },
    { key: 'reordering', label: 'Reordering', done: true },
    { key: 'declined', label: 'Declined', done: true }
  ],
  valueLabel: 'Order value', valueKind: 'money', dueLabel: 'Follow up on',
  fields: [
    { key: 'kind', label: 'Kind of shop', type: 'select', options: ['Independent shop', 'Chain', 'Online retailer', 'Gift shop', 'Museum or gallery shop', 'Other'] },
    { key: 'terms', label: 'Terms', type: 'text', placeholder: 'e.g. wholesale, net 30; or sale or return' }
  ]
});

defineWorksheet('prod_bom', {
  label: 'Bill of materials & unit cost', emoji: '🧾', layout: 'form',
  blurb: 'Every part, the landed cost of one unit, and whether retail and wholesale prices leave room to make money.',
  titleLabel: 'Product and version', titlePlaceholder: 'e.g. Trail bottle v2 — 500-unit run',
  sections: [
    { key: 'parts', label: 'Parts and materials', type: 'list', help: 'One per line, with the cost per unit.' },
    { key: 'order_qty', label: 'Order quantity', type: 'number' },
    { key: 'unit_cost', label: 'Manufacturing cost per unit', type: 'money' },
    { key: 'packaging', label: 'Packaging per unit', type: 'money' },
    { key: 'freight', label: 'Freight per unit', type: 'money' },
    { key: 'duty', label: 'Duty and import fees per unit', type: 'money' },
    { key: 'tooling', label: 'One-off tooling or moulds', type: 'money' },
    { key: 'retail', label: 'Retail price', type: 'money' },
    { key: 'wholesale', label: 'Wholesale price', type: 'money', help: 'Shops usually expect around half of retail.' }
  ],
  summary: d => {
    const perUnit = (d.unit_cost || 0) + (d.packaging || 0) + (d.freight || 0) + (d.duty || 0);
    if (!perUnit) return [];
    const tooling = d.tooling && d.order_qty ? d.tooling / d.order_qty : 0;
    const landed = perUnit + tooling;
    const out = [{ label: 'Landed cost per unit' + (tooling ? ' (tooling spread over the run)' : ''), value: money(landed) }];
    if (d.order_qty) out.push({ label: 'Cash needed for the run', value: money(perUnit * d.order_qty + (d.tooling || 0)) });
    if (d.retail) {
      const m = (d.retail - landed) / d.retail * 100;
      out.push({ label: 'Margin selling direct', value: percent(Math.round(m)), tone: m >= 60 ? 'good' : m < 40 ? 'bad' : undefined });
    }
    const wholesale = d.wholesale || (d.retail ? d.retail / 2 : 0);
    if (wholesale) {
      const m = (wholesale - landed) / wholesale * 100;
      out.push({ label: 'Margin at wholesale' + (d.wholesale ? '' : ' (half of retail)'), value: percent(Math.round(m)), tone: m >= 40 ? 'good' : m < 25 ? 'bad' : undefined });
    }
    if (d.retail) {
      const ok = landed * 4 <= d.retail;
      out.push({ label: 'Retail at least 4× landed cost', value: ok ? 'Yes' : 'No — ' + money(landed * 4) + ' needed', tone: ok ? 'good' : 'bad' });
    }
    return out;
  }
});

defineWorksheet('prod_makers', {
  label: 'Manufacturer comparison', emoji: '🏭', layout: 'matrix',
  blurb: 'Score the manufacturers you are talking to on price, minimums, lead time, sample quality and how well they communicate.',
  titleLabel: 'What you are sourcing', titlePlaceholder: 'e.g. Bottle body and lid',
  optionsLabel: 'Manufacturers', optionsHelp: 'Two to five you have quotes or samples from.',
  defaultCriteria: ['Unit price', 'Minimum order', 'Lead time', 'Sample quality', 'Communication', 'Certifications']
});

registry.defineChecklist({
  key: 'prod_gates', label: 'Development gates',
  help: 'Each gate has a clear "done". Do not pay for tooling until the gates before it are ticked.',
  items: [
    { key: 'problem', label: 'The problem it solves, in one sentence a buyer would say' },
    { key: 'demand', label: 'Twenty people say they would buy it — ideally by pre-ordering', link: '/surveys' },
    { key: 'sketch', label: 'Sketches or a 3D model with dimensions' },
    { key: 'prototype', label: 'A working prototype, however rough' },
    { key: 'tested', label: 'Ten people have used the prototype and you changed it because of them' },
    { key: 'cost', label: 'Landed cost known, and the price leaves a margin', link: '/workspace/docs/prod_bom' },
    { key: 'samples', label: 'Production samples approved from a manufacturer', link: '/workspace/docs/prod_makers' },
    { key: 'compliance', label: 'Safety and labelling rules for your category checked' },
    { key: 'first_run', label: 'First production run ordered' }
  ]
});

registry.defineChecklist({
  key: 'prod_compliance', label: 'Compliance and labelling',
  help: 'Rules depend on the product and where it is sold. These are the US regulators; other countries have their own.',
  items: [
    { key: 'category', label: 'Find the safety rules for your product category', link: 'https://www.cpsc.gov/Business--Manufacturing' },
    { key: 'children', label: 'Made for children? Third-party testing and a Children\'s Product Certificate are required before selling', help: 'Search "children\'s products" on the CPSC business pages.' },
    { key: 'cosmetics', label: 'Cosmetics or skincare: check FDA cosmetics rules and ingredient labelling', link: 'https://www.fda.gov/cosmetics' },
    { key: 'electronics', label: 'Electronics: check FCC equipment authorisation', link: 'https://www.fcc.gov/engineering-technology/laboratory-division/general/equipment-authorization' },
    { key: 'labels', label: 'Labels: what it is, what it is made of, where it was made, who to contact' },
    { key: 'insurance', label: 'Product liability insurance before you sell', expires: true }
  ]
});

registry.defineChecklist({
  key: 'prod_ip', label: 'Name and design protection',
  items: [
    { key: 'name_search', label: 'Search the name before you print it on anything', link: 'https://www.uspto.gov/trademarks/search' },
    { key: 'domain', label: 'Get the domain and social handles' },
    { key: 'nda', label: 'Use an NDA when you send designs to manufacturers' },
    { key: 'ownership', label: 'Get in writing that you own the design and any moulds you paid for' },
    { key: 'patent', label: 'If it is genuinely new, talk to a patent attorney before showing it publicly' }
  ]
});

const SELLING = ['Selling it', 'In shops or retailers'];
const LATE = ['Samples from a manufacturer'];

module.exports = {
  slug: 'physical_product',
  intro: 'Design a real product, get it made, and get it into people\'s hands.',
  stages: [
    { answer: 'Just an idea' },
    { answer: 'Sketches or a concept' },
    { answer: 'Prototype made' },
    { answer: 'Samples from a manufacturer' },
    { answer: 'Selling it' },
    { answer: 'In shops or retailers' }
  ],
  northStar: ({ stage }) => (SELLING.includes(stage) ? 'prod_units' : LATE.includes(stage) ? 'prod_preorders' : null),
  northStarChecklist: ({ stage }) => (SELLING.includes(stage) || LATE.includes(stage) ? null : 'prod_gates'),
  supporting: ({ stage }) => (SELLING.includes(stage) ? ['prod_revenue', 'prod_margin'] : LATE.includes(stage) ? ['prod_pledged'] : []),
  boards: ({ stage }) => (SELLING.includes(stage) || LATE.includes(stage) ? ['prod_retailers'] : []),
  checklists: () => ['prod_gates', 'prod_compliance', 'prod_ip'],
  worksheets: ['prod_bom', 'prod_makers']
};
