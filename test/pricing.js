// What we advertise and what we charge have to be the same number.
//
// The 2026/27 markdown is 50% off every tier. It is stored beside the list
// price rather than over it — promo_price_cents next to price_cents — so the
// full price and its Stripe Price ID survive the promotion and ending it is
// clearing one field. That only works if every reader goes through
// src/pricing.js offerFor(). A page rendering price_cents while checkout
// charges promo_price_cents, or the reverse, is the one bug this area cannot
// have, and it would be invisible until a customer complained.
//
//   node test/pricing.js

const fs = require('fs');
const path = require('path');
const pricing = require('../src/pricing');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
console.log('\nA markdown applies only when it is real and current:');

const base = { key: 'month', price_cents: 1200, stripe_price_id: 'price_full' };
const at = s => new Date(s);

ok('no markdown charges the list price',
   pricing.offerFor(base).cents === 1200 && !pricing.offerFor(base).isPromo);
ok('...and uses the list Stripe Price', pricing.offerFor(base).stripePriceId === 'price_full');

const promo = Object.assign({}, base, { promo_price_cents: 600, promo_label: '50% off' });
ok('a markdown charges the markdown', pricing.offerFor(promo).cents === 600);
ok('...and still reports what it was worth', pricing.offerFor(promo).listCents === 1200);
ok('...and the saving', pricing.offerFor(promo).saved === 600);

ok('a markdown with no Stripe Price still applies',
   pricing.offerFor(promo).isPromo && pricing.offerFor(promo).stripePriceId === null,
   'checkout builds the line item inline, so it can go live before the Price exists');
ok('...and uses the markdown Price once it exists',
   pricing.offerFor(Object.assign({}, promo, { promo_stripe_price_id: 'price_promo' })).stripePriceId === 'price_promo');
ok('a markdown NEVER falls back to the list Stripe Price',
   pricing.offerFor(promo).stripePriceId !== base.stripe_price_id,
   'that would charge full price while the page advertises half');

ok('an expired markdown is off',
   !pricing.offerFor(Object.assign({}, promo, { promo_ends_at: '2020-01-01' }), at('2026-09-11')).isPromo);
ok('a future end date is still on',
   pricing.offerFor(Object.assign({}, promo, { promo_ends_at: '2030-01-01' }), at('2026-09-11')).isPromo);
ok('no end date is open-ended, not expired',
   pricing.offerFor(Object.assign({}, promo, { promo_ends_at: null })).isPromo,
   'a date nobody chose is a date that expires by surprise');
ok('a zero-price markdown is honoured, not treated as absent',
   pricing.offerFor(Object.assign({}, base, { promo_price_cents: 0 })).cents === 0,
   '0 is falsy — the check has to be against null');

console.log('\nMoney reads the way the page has always rendered it:');
for (const [cents, want] of [[1200, '$12'], [600, '$6'], [1450, '$14.50'], [4850, '$48.50'], [17500, '$175'], [35000, '$350']]) {
  ok(`${cents} -> ${want}`, pricing.money(cents) === want, pricing.money(cents));
}

// ---------------------------------------------------------------------------
console.log('\nThe page and the checkout read the same source:');

const billing = read('src/routes/billing.js');
ok('checkout asks pricing.js what this costs', /const offer = pricing\.offerFor\(tier\)/.test(billing));
ok('...charges the offer amount', /unit_amount\]'\] = String\(offer\.cents\)/.test(billing));
ok('...and uses the offer\'s Stripe Price', /params\['line_items\[0\]\[price\]'\] = offer\.stripePriceId/.test(billing));
ok('checkout never reads tier.price_cents directly', !/String\(tier\.price_cents\)/.test(billing),
   'during a markdown that is the crossed-out number');
ok('checkout never reads tier.stripe_price_id directly', !/= tier\.stripe_price_id/.test(billing));
ok('the pricing page is given offers, not raw rows', /tiers: pricing\.withOffer\(tiers\)/.test(billing));
ok('a markdown sale is marked on the Stripe session', /metadata\[promo\]/.test(billing),
   'so a refund or a dispute can tell which price was in force');

// Rendered, not grepped: what matters is the number a customer reads, not
// which local variable the template happened to use.
const ejs = require('ejs');
const VIEW = path.join(ROOT, 'views/pricing.ejs');
const renderPricing = tiers => ejs.render(read('views/pricing.ejs'), {
  currentPath: '/pricing', user: null, settings: {}, notifications: [], profile: null,
  title: 'Pricing', tiers, plan: null, upgrade: null, msg: null,
  freeFeatures: ['f'], paidFeatures: ['p']
}, { filename: VIEW });

const headline = html => [...html.matchAll(/<p class="price">([\s\S]*?)<\/p>/g)]
  .map(m => m[1].replace(/<span class="was">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
const struck = html => [...html.matchAll(/<span class="was">([^<]*)<\/span>/g)].map(m => m[1].trim());

const marked = pricing.withOffer([{ key: 'month', name: 'Escape Monthly', price_cents: 1200,
  interval_label: 'per month', promo_price_cents: 600, promo_label: '2026/27 launch price — 50% off' }]);
const markedHtml = renderPricing(marked);
ok('during a markdown the headline price is the markdown',
   headline(markedHtml).some(h => h.startsWith('$6')), headline(markedHtml).join(' / '));
ok('...the list price is shown struck through', struck(markedHtml).includes('$12'), struck(markedHtml).join(', '));
ok('...and the markdown is named', /2026\/27 launch price/.test(markedHtml));

const plain = pricing.withOffer([{ key: 'lifetime', name: 'Escape Lifetime', price_cents: 35000,
  interval_label: 'one-time' }]);
const plainHtml = renderPricing(plain);
ok('with no markdown the headline is the list price',
   headline(plainHtml).some(h => h.startsWith('$350')), headline(plainHtml).join(' / '));
ok('...and nothing is struck through', struck(plainHtml).length === 0);

// A caller that hands over a raw row must not take the page down — that is how
// the Compass went out.
ok('a tier with no offer attached still renders at list price',
   headline(renderPricing([{ key: 'month', name: 'M', price_cents: 1200, interval_label: 'per month' }]))
     .some(h => h.startsWith('$12')));

ok('the strike-through has a style to render with', /\.price \.was/.test(read('public/css/style.css')));

// ---------------------------------------------------------------------------
console.log('\nThe markdown is what it says it is:');

// The four tiers and their intended numbers. Checked against the migration so
// a typo in a price is caught here rather than by a customer.
const WANT = { month: [1200, 600], quarter: [2900, 1450], year: [9700, 4850], lifetime: [35000, 17500] };
const sql = read('migrations/2026-09-11_markdown_pricing.sql');
ok('the migration halves the price rather than hardcoding four numbers',
   /promo_price_cents = price_cents \/ 2/.test(sql), 'no arithmetic for anyone to get wrong');
ok('...for every tier', Object.keys(WANT).every(k => new RegExp("'" + k + "'").test(sql)),
   Object.keys(WANT).join(', '));
ok('...open-ended, not expiring on a date nobody chose', /promo_ends_at = null/.test(sql));
for (const [key, [list, want]] of Object.entries(WANT)) {
  const got = pricing.offerFor({ key, price_cents: list, promo_price_cents: Math.floor(list / 2) });
  ok(`${key}: ${pricing.money(list)} -> ${pricing.money(got.cents)}`, got.cents === want,
     `expected ${pricing.money(want)}`);
}

console.log(fail ? `\n${fail} failing` : '\nAll good');
process.exit(fail ? 1 : 0);
