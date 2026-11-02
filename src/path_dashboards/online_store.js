// 📦 Online store (docs/path-dashboards.md). North star: orders this month —
// at a margin, which is why every product gets a unit-economics sheet that
// takes off fees, shipping, packaging and ad cost before calling it profit.
const { registry, format: { money, percent } } = require('../engines');
const { defineWorksheet } = require('../workspace/worksheets');

registry.defineMetric({ key: 'shop_orders', label: 'Orders', unit: 'count', period: 'month' });
registry.defineMetric({ key: 'shop_revenue', label: 'Revenue', unit: 'money', period: 'month' });
registry.defineMetric({ key: 'shop_aov', label: 'Average order value', unit: 'money', period: 'month',
  help: 'Revenue ÷ orders.' });
registry.defineMetric({ key: 'shop_margin', label: 'Margin after costs', unit: 'percent', period: 'month',
  help: 'What was left after product, fees, shipping and ads, as a share of revenue.' });
registry.defineMetric({ key: 'shop_ad_spend', label: 'Ad spend', unit: 'money', period: 'month', higherIsBetter: false });

registry.defineBoard({
  key: 'shop_tests', label: 'Marketing tests', emoji: '📣', itemLabel: 'test',
  help: 'One card per channel or ad you try. Note the spend and the sales it brought, then keep it or kill it.',
  stages: [
    { key: 'idea', label: 'Idea' },
    { key: 'running', label: 'Running' },
    { key: 'keep', label: 'Keep', done: true },
    { key: 'kill', label: 'Kill', done: true }
  ],
  valueLabel: 'Spend', valueKind: 'money', dueLabel: 'Review on',
  fields: [
    { key: 'channel', label: 'Channel', type: 'select', options: ['TikTok', 'Instagram', 'Pinterest', 'Facebook', 'Google', 'Etsy ads', 'Amazon ads', 'Email', 'Influencer', 'Market or fair', 'Other'] },
    { key: 'sales', label: 'Sales it brought', type: 'number' },
    { key: 'revenue', label: 'Revenue it brought', type: 'money' },
    { key: 'learned', label: 'What you learned', type: 'longtext' }
  ]
});

registry.defineBoard({
  key: 'shop_suppliers', label: 'Suppliers', emoji: '🏭', itemLabel: 'supplier',
  help: 'Every supplier you look at, with cost, minimums and lead time. Order a sample before you list anything.',
  stages: [
    { key: 'found', label: 'Found' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'sample', label: 'Sample ordered' },
    { key: 'approved', label: 'Approved', done: true },
    { key: 'rejected', label: 'Rejected', done: true }
  ],
  valueLabel: 'Unit cost', valueKind: 'money', dueLabel: 'Sample due',
  fields: [
    { key: 'minimum', label: 'Minimum order', type: 'text' },
    { key: 'lead_time', label: 'Lead time', type: 'text' },
    { key: 'site', label: 'Website', type: 'url' },
    { key: 'quality', label: 'Sample quality', type: 'select', options: ['Not seen yet', 'Poor', 'Acceptable', 'Good', 'Excellent'] }
  ]
});

defineWorksheet('shop_product', {
  label: 'Product & unit economics', emoji: '🏷️', layout: 'form',
  blurb: 'One per product: what it really costs to sell one, and what is left. Make one for each channel if fees differ.',
  titleLabel: 'Product', titlePlaceholder: 'e.g. A5 linen notebook — Etsy',
  sections: [
    { key: 'channel', label: 'Channel', type: 'select', options: ['My own site', 'Etsy', 'Amazon', 'eBay', 'TikTok Shop', 'Instagram', 'Wholesale', 'Markets and fairs', 'Other'] },
    { key: 'price', label: 'Selling price', type: 'money' },
    { key: 'shipping_charged', label: 'Shipping charged to the customer', type: 'money' },
    { key: 'cost', label: 'Product cost (materials or wholesale)', type: 'money' },
    { key: 'hours', label: 'Hours to make one (handmade)', type: 'number' },
    { key: 'hourly', label: 'Your hourly rate for that time', type: 'money' },
    { key: 'fee_pct', label: 'Platform and payment fees (%)', type: 'number', help: 'Add up listing, transaction and payment processing fees as a percentage of the sale.' },
    { key: 'fee_fixed', label: 'Fixed fees per order', type: 'money' },
    { key: 'shipping', label: 'Shipping cost to you', type: 'money' },
    { key: 'packaging', label: 'Packaging', type: 'money' },
    { key: 'ad_cost', label: 'Ad cost per sale', type: 'money' },
    { key: 'stock', label: 'In stock', type: 'number' },
    { key: 'reorder_at', label: 'Reorder when stock reaches', type: 'number' }
  ],
  summary: d => {
    if (!d.price) return [];
    const takings = d.price + (d.shipping_charged || 0);
    const fees = takings * (d.fee_pct || 0) / 100 + (d.fee_fixed || 0);
    const labour = (d.hours || 0) * (d.hourly || 0);
    const costs = (d.cost || 0) + labour + fees + (d.shipping || 0) + (d.packaging || 0) + (d.ad_cost || 0);
    const profit = takings - costs;
    const pct = takings ? profit / takings * 100 : 0;
    const out = [
      { label: 'Takings per order', value: money(takings) },
      { label: 'Fees', value: money(fees) },
      { label: 'All costs' + (labour ? ' (including your time)' : ''), value: money(costs) },
      { label: 'Profit per order', value: money(profit), tone: profit > 0 ? 'good' : 'bad' },
      { label: 'Margin', value: percent(Math.round(pct * 10) / 10), tone: pct >= 30 ? 'good' : pct < 15 ? 'bad' : undefined }
    ];
    if (profit > 0) out.push({ label: 'Orders a month for $1,000 profit', value: String(Math.ceil(1000 / profit)) });
    if (Number.isFinite(d.stock) && Number.isFinite(d.reorder_at) && d.stock <= d.reorder_at) out.push({ label: 'Stock', value: 'Time to reorder', tone: 'bad' });
    return out;
  }
});

registry.defineChecklist({
  key: 'shop_setup', label: 'Store setup',
  items: [
    { key: 'channel', label: 'Pick one channel to start on' },
    { key: 'photos', label: 'Photos: one clean main image, one in use, one showing size' },
    { key: 'title', label: 'Titles and tags in the words customers search for' },
    { key: 'description', label: 'A description that answers the questions people would ask' },
    { key: 'margin', label: 'Check every product makes money after all costs', link: '/workspace/docs/shop_product' },
    { key: 'policies', label: 'Shipping, returns and contact policies published' },
    { key: 'test_order', label: 'Place a test order end to end' }
  ]
});

registry.defineChecklist({
  key: 'shop_tax', label: 'Tax basics',
  help: 'Sales tax rules depend on where you and your customers are, and change. Marketplaces often collect it for you; your own site may not.',
  items: [
    { key: 'permit', label: 'Check whether your state needs a seller\'s permit before you sell' },
    { key: 'marketplace', label: 'Check which sales taxes your marketplace collects for you' },
    { key: 'own_site', label: 'If you sell on your own site, turn on tax collection where required' },
    { key: 'records', label: 'Keep every order, fee and cost in one place', link: '/budget' },
    { key: 'income_tax', label: 'Put income tax aside from profit', link: '/tools/tax' }
  ]
});

registry.defineChecklist({
  key: 'shop_policies', label: 'Returns and shipping',
  items: [
    { key: 'returns', label: 'Decide your returns window and who pays return postage' },
    { key: 'damaged', label: 'Decide what happens with damaged or lost parcels' },
    { key: 'times', label: 'State processing and delivery times honestly' },
    { key: 'tracking', label: 'Use tracked shipping above a value you choose' },
    { key: 'digital', label: 'Digital products: say clearly what the buyer gets and the licence' }
  ]
});

const SUPPLIED = ['wholesale', 'dropship', 'print'];

module.exports = {
  slug: 'online_store',
  intro: 'Sell products online — and keep enough of each sale to make it worth it.',
  stages: [
    { answer: 'Just an idea', next: 'Choose one product and work out what is left after every cost before you buy stock.' },
    { answer: 'Product chosen, nothing listed', next: 'List it on one channel with three good photos this week.' },
    { answer: 'Listed, no sales yet', next: 'Make your first sale: share it with ten people who would genuinely want it.' },
    { answer: 'A few sales', next: 'Find the one channel that sells, and run small marketing tests there.' },
    { answer: 'Selling regularly', next: 'Hit a $1,000 profit month, then a second product for the customers you already have.' }
  ],
  northStar: () => 'shop_orders',
  supporting: () => ['shop_revenue', 'shop_margin', 'shop_aov'],
  boards: ({ subpath }) => ['shop_tests'].concat(SUPPLIED.includes(subpath) ? ['shop_suppliers'] : []),
  checklists: () => ['shop_setup', 'shop_tax', 'shop_policies'],
  worksheets: ['shop_product']
};
