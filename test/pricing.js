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

// ---------------------------------------------------------------------------
console.log('\nThe Stripe Price IDs are real and both halves are filled in:');

// The IDs live in the EnRoute Jobs, LLC account. Checked here so that a tier
// silently losing its promo Price (the state that made the markdown depend on
// the inline fallback) shows up as a failing test rather than as a full-price
// charge.
const idSql = read('migrations/2026-09-11_stripe_prices_enroute_account.sql');
// One stanza per tier. Split on the statement boundary so a missing ID in one
// tier cannot be covered by the IDs of the tier above it.
const stanzas = idSql.split('update pricing_tiers set').slice(1);
for (const key of Object.keys(WANT)) {
  const stanza = stanzas.find(t => new RegExp("where key = '" + key + "'").test(t)) || '';
  const ids = stanza.match(/\bprice_1[A-Za-z0-9]+/g) || [];
  ok(`${key} has both a list and a markdown Price ID`, ids.length === 2, ids.join(', ') || 'none');
  ok(`...and they are different Prices`, ids.length === 2 && ids[0] !== ids[1]);
}
const allIds = idSql.match(/\bprice_1[A-Za-z0-9]+/g) || [];
ok('all eight Prices are accounted for', allIds.length === 8, allIds.length + ' found');
ok('every Price ID belongs to the EnRoute Jobs, LLC account',
   allIds.length > 0 && allIds.every(id => /GYCkHj7ufX/.test(id)),
   'an ID from another Stripe account is rejected at checkout');
ok('no Price is reused across tiers', new Set(allIds).size === allIds.length);
ok('the migration says which amount each ID charges',
   Object.values(WANT).flat().every(c => idSql.includes(pricing.money(c).replace('$', '$') + '.00') ||
     idSql.includes('$' + (c / 100).toFixed(2))),
   'every amount appears as a comment beside its ID');

// ---------------------------------------------------------------------------
console.log('\nA rejected Price ID does not cost the sale:');

// The real failure this guards: pricing_tiers pointed at Prices from a Stripe
// account we no longer charge on. Every checkout 400'd. Here we make Stripe
// reject the Price for real and assert the member still reaches checkout, at
// the markdown price.
(function () {
  const path = require('path');
  const express = require('express');
  const root = path.join(__dirname, '..');
  const stub = (rel, exports) => {
    const file = require.resolve(path.join(root, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };

  const TIER = { key: 'month', name: 'Escape Monthly', price_cents: 1200, interval_label: 'per month',
    mode: 'subscription', is_active: true, stripe_price_id: 'price_fromTheWrongAccount',
    promo_price_cents: 600, promo_stripe_price_id: 'price_alsoWrong',
    promo_label: '2026/27 launch price', promo_ends_at: null };

  const fakeSb = () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
    maybeSingle: async () => ({ data: TIER }) }) }) }) }) });
  stub('src/supabase.js', { anonClient: fakeSb, serviceClient: fakeSb });
  stub('src/middleware/auth.js', {
    requireAuth: (req, _res, nxt) => { req.user = { id: 'u1', email: 'm@x.test' }; req.profile = {}; nxt(); },
    planOf: () => 'free'
  });

  delete require.cache[require.resolve(path.join(root, 'src/routes/billing.js'))];
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  const billing = require(path.join(root, 'src/routes/billing.js'));

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(billing.router || billing);

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = Object.fromEntries(new URLSearchParams(opts.body || ''));
    calls.push(body);
    if (body['line_items[0][price]']) {
      return { ok: false, json: async () => ({ error: { message: 'No such price: ' + body['line_items[0][price]'] } }) };
    }
    return { ok: true, json: async () => ({ url: 'https://checkout.stripe.test/ok' }) };
  };

  const server = app.listen(0, async () => {
    let res;
    try {
      res = await realFetch('http://127.0.0.1:' + server.address().port + '/billing/checkout/month',
        { method: 'POST', redirect: 'manual' });
    } finally { global.fetch = realFetch; server.close(); }

    const loc = res.headers.get('location') || '';
    ok('Stripe was asked for the catalog Price first',
       calls[0] && calls[0]['line_items[0][price]'] === 'price_alsoWrong', JSON.stringify(calls[0] || {}));
    ok('...and when it was rejected, checkout was retried inline', calls.length === 2, calls.length + ' call(s)');
    ok('...at the markdown price, not the list price',
       calls[1] && calls[1]['line_items[0][price_data][unit_amount]'] === '600',
       calls[1] && calls[1]['line_items[0][price_data][unit_amount]']);
    ok('...with no stale Price ID left alongside it',
       calls[1] && !calls[1]['line_items[0][price]']);
    ok('the member reaches Stripe rather than an error',
       loc === 'https://checkout.stripe.test/ok', loc);

    console.log(fail ? `\n${fail} failing` : '\nAll good');
    process.exit(fail ? 1 : 0);
  });
})();
