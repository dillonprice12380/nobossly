// A Monthly member can switch to Annual — on the processor that already bills
// them, never twice, and a failed charge must leave the plan exactly as it was.
//
// Nothing here touches the network or the database: Stripe is a stubbed fetch,
// PayPal's client is replaced, and Supabase is a recorder.
//
//   node test/plan-change.js

const fs = require('fs');
const path = require('path');

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.SUB_SYNC_SECRET = 'sync-secret';
process.env.PAYPAL_CLIENT_ID = 'id';
process.env.PAYPAL_CLIENT_SECRET = 'secret';
process.env.SITE_URL = 'https://nobossly.test';

let fail = 0;
const ok = (name, cond, note) => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && note ? '  — ' + note : ''}`); };

// ── fake Supabase ──
const TIERS = { year: { key: 'year', mode: 'subscription', price_cents: 4800, stripe_price_id: null, paypal_plan_id: 'P-YEAR', is_active: true } };
const rpcCalls = [];
const fakeClient = {
  rpc: async (fn, args) => { rpcCalls.push({ fn, args }); return { data: null, error: null }; },
  from: () => {
    const f = {};
    const q = { select: () => q, eq: (c, v) => { f[c] = v; return q; }, maybeSingle: async () => ({ data: TIERS[f.key] || null, error: null }) };
    return q;
  }
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { anonClient: () => fakeClient, serviceClient: () => fakeClient } };

const paypal = require('../src/paypal');
const billing = require('../src/routes/billing');
const applied = () => rpcCalls.filter(c => c.fn === 'apply_subscription').map(c => c.args);

// ── stubbed Stripe ──
const stripeCalls = [];
let stripeSub, stripeUpdate;
global.fetch = async (url, init) => {
  const call = { url: String(url), method: (init && init.method) || 'GET', body: Object.fromEntries(new URLSearchParams((init && init.body) || '')) };
  stripeCalls.push(call);
  const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
  if (call.method === 'GET') return reply(200, stripeSub);
  return typeof stripeUpdate === 'function' ? stripeUpdate(call) : reply(200, stripeUpdate);
};
const reset = () => { rpcCalls.length = 0; stripeCalls.length = 0; };
const posts = () => stripeCalls.filter(c => c.method === 'POST');

const ME = '11111111-1111-4111-8111-111111111111';
const future = new Date(Date.now() + 864e5).toISOString();
const monthly = (over) => Object.assign({ subscription_tier: 'month', subscription_status: 'active', subscription_period_end: future, stripe_subscription_id: 'sub_1' }, over);
const monthSub = () => ({ id: 'sub_1', status: 'active', cancel_at_period_end: false, items: { data: [{ id: 'si_1', price: { id: 'price_m', product: 'prod_1', recurring: { interval: 'month' } } }] } });
const yearEnd = '2027-10-29T00:00:00.000Z';
const updatedSub = () => ({ id: 'sub_1', status: 'active', items: { data: [{ id: 'si_1', current_period_end: Date.parse(yearEnd) / 1000 }] } });
const msg = to => decodeURIComponent((to.split('msg=')[1] || ''));

(async () => {
  console.log('\nStripe: Monthly to Annual:');
  reset(); stripeSub = monthSub(); stripeUpdate = updatedSub();
  let r = await billing.changePlan(monthly(), ME, 'year');
  let p = posts()[0] || { body: {} };
  ok('the subscription item is moved to the annual price', posts().length === 1 && /subscriptions\/sub_1$/.test(p.url) && p.body['items[0][id]'] === 'si_1');
  ok('...charging $48 a year on the same product', p.body['items[0][price_data][unit_amount]'] === '4800' && p.body['items[0][price_data][recurring][interval]'] === 'year' && p.body['items[0][price_data][product]'] === 'prod_1');
  ok('...crediting the unused month and starting the year today', p.body.proration_behavior === 'always_invoice' && p.body.billing_cycle_anchor === 'now');
  ok('...and a declined card changes nothing', p.body.payment_behavior === 'error_if_incomplete');
  const a = applied()[0] || {};
  ok('Premium follows: tier year, the new period end', applied().length === 1 && a.p_user === ME && a.p_tier === 'year' && a.p_status === 'active' && a.p_sub_id === 'sub_1' && a.p_period_end === yearEnd);
  ok('the member lands on their account', r.to === '/account?sub=switched');

  reset(); TIERS.year.stripe_price_id = 'price_year'; stripeSub = monthSub(); stripeUpdate = updatedSub();
  await billing.changePlan(monthly(), ME, 'year');
  p = posts()[0] || { body: {} };
  ok('a catalogue Price is used when the tier has one', p.body['items[0][price]'] === 'price_year' && !p.body['items[0][price_data][unit_amount]']);
  reset(); let n = 0;
  stripeSub = monthSub(); stripeUpdate = () => (++n === 1 ? { ok: false, status: 400, json: async () => ({ error: { message: 'No such price' } }) } : { ok: true, status: 200, json: async () => updatedSub() });
  r = await billing.changePlan(monthly(), ME, 'year');
  ok('a Price Stripe rejects falls back to the amount in the tier', posts().length === 2 && posts()[1].body['items[0][price_data][unit_amount]'] === '4800' && applied().length === 1);
  TIERS.year.stripe_price_id = null;

  reset(); stripeSub = monthSub(); stripeUpdate = () => ({ ok: false, status: 402, json: async () => ({ error: { message: 'Your card was declined.' } }) });
  r = await billing.changePlan(monthly(), ME, 'year');
  ok('a declined card leaves the plan alone and says why', !applied().length && /declined/.test(msg(r.to)) && r.to.startsWith('/pricing'));

  reset(); stripeSub = Object.assign(monthSub(), { items: { data: [{ id: 'si_1', price: { id: 'p', product: 'prod_1', recurring: { interval: 'year' } } }] } }); stripeUpdate = updatedSub();
  r = await billing.changePlan(monthly(), ME, 'year');
  ok('a subscription already on the annual price is not charged again', !posts().length && applied().length === 1 && applied()[0].p_tier === 'year');
  reset(); stripeSub = Object.assign(monthSub(), { cancel_at_period_end: true });
  r = await billing.changePlan(monthly(), ME, 'year');
  ok('a subscription that is ending cannot be switched', !posts().length && !applied().length && r.to.startsWith('/pricing'));
  reset(); stripeSub = Object.assign(monthSub(), { status: 'canceled' });
  r = await billing.changePlan(monthly(), ME, 'year');
  ok('...nor one Stripe has cancelled', !posts().length && !applied().length);

  console.log('\nWho may switch:');
  for (const [label, prof] of [
    ['an annual member', monthly({ subscription_tier: 'year' })],
    ['a member who has cancelled', monthly({ subscription_status: 'canceled' })],
    ['a lifetime member', monthly({ is_lifetime: true })],
    ['a free member', { subscription_status: null }]
  ]) {
    reset();
    r = await billing.changePlan(prof, ME, 'year');
    ok(label + ' cannot', !stripeCalls.length && !applied().length);
  }
  reset(); r = await billing.changePlan(monthly(), ME, 'month');
  ok('only Annual is a target (no downgrade through this route)', !stripeCalls.length && r.to === '/pricing');

  console.log('\nPayPal: Monthly to Annual:');
  const ppMember = monthly({ stripe_subscription_id: 'I-ABC' });
  const goodPlan = { status: 'ACTIVE', billing_cycles: [{ tenure_type: 'REGULAR', total_cycles: 0, frequency: { interval_unit: 'YEAR', interval_count: 1 }, pricing_scheme: { fixed_price: { value: '48.00', currency_code: 'USD' } } }] };
  let revised = null;
  paypal.getPlan = async () => goodPlan;
  paypal.reviseSubscription = async args => { revised = args; return { approveUrl: 'https://www.paypal.com/approve?x' }; };
  reset(); r = await billing.changePlan(ppMember, ME, 'year');
  ok('the member is sent to PayPal to approve the annual plan', revised && revised.id === 'I-ABC' && revised.planId === 'P-YEAR' && r.to === 'https://www.paypal.com/approve?x' && r.status === 303);
  ok('...Stripe is never called for a PayPal member, and nothing is granted yet', !stripeCalls.length && !applied().length);
  paypal.reviseSubscription = async () => ({ approveUrl: null });
  r = await billing.changePlan(ppMember, ME, 'year');
  ok('a change PayPal applied without approval returns to the site', r.to === '/billing/paypal/switched');
  paypal.reviseSubscription = async () => null;
  r = await billing.changePlan(ppMember, ME, 'year');
  ok('a refused change says so', r.to.startsWith('/pricing') && /PayPal/.test(msg(r.to)));
  revised = null; paypal.reviseSubscription = async a => { revised = a; return { approveUrl: 'https://www.paypal.com/x' }; };
  paypal.getPlan = async () => Object.assign({}, goodPlan, { billing_cycles: [Object.assign({}, goodPlan.billing_cycles[0], { pricing_scheme: { fixed_price: { value: '4.80', currency_code: 'USD' } } })] });
  r = await billing.changePlan(ppMember, ME, 'year');
  ok('a plan at the wrong price is never sold', !revised && r.to.startsWith('/pricing'));

  console.log('\nThe pricing page:');
  const ejs = require('ejs');
  const tiers = [
    { key: 'month', name: 'Premium Monthly', price_cents: 500, interval_label: 'per month', mode: 'subscription', tagline: '', offer: { cents: 500, listCents: 500, isPromo: false } },
    { key: 'year', name: 'Premium Annual', price_cents: 4800, interval_label: 'per year', mode: 'subscription', tagline: '', offer: { cents: 4800, listCents: 4800, isPromo: false } },
    { key: 'lifetime', name: 'Premium Lifetime', price_cents: 20000, interval_label: 'one-time', mode: 'payment', tagline: '', offer: { cents: 20000, listCents: 20000, isPromo: false } }];
  const render = extra => new Promise((res, rej) => ejs.renderFile(path.join(__dirname, '..', 'views/pricing.ejs'),
    Object.assign({ title: 't', metaDescription: 'm', tiers, freeFeatures: [], paidFeatures: [], msg: null, upgrade: null, premiumTools: [], user: { id: 'u' }, profile: {}, isPremium: true, paypalAvail: {}, payer: 'stripe' }, extra),
    { views: [path.join(__dirname, '..', 'views')] }, (e, h) => e ? rej(e) : res(h)));
  let html = await render({ currentTier: 'month', canSwitch: true });
  ok('a Monthly member sees Switch to Annual, and Monthly marked as their plan', /action="\/billing\/change\/year"/.test(html) && /Switch to Annual/.test(html) && /Your plan/.test(html));
  html = await render({ currentTier: 'year', canSwitch: false });
  ok('an Annual member sees Annual as theirs and no switch', !/billing\/change/.test(html) && /Your plan/.test(html));
  const form = (fs.readFileSync(path.join(__dirname, '..', 'views/pricing.ejs'), 'utf8').match(/<form[^\n]*\/billing\/change[^\n]*/g) || []);
  ok('the switch form bypasses Turbo (fetch cannot follow the redirect)', form.length === 1 && /data-turbo="false"/.test(form[0]));

  if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch(e => { console.error(e); process.exit(1); });
