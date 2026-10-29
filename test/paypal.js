// PayPal grants paid access from a return page and from a webhook, so: only
// NoBossly's own payments may unlock anything, the money must be right BEFORE it
// is taken, nothing in a request is trusted over what PayPal says, and one
// processor's member can never be sold the other's checkout.
//
// Nothing here touches the network or the database: PayPal's client and the
// Supabase client are replaced with recorders.
//
//   node test/paypal.js

const fs = require('fs');
const path = require('path');

process.env.PAYPAL_CLIENT_ID = 'test-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST';
process.env.SUB_SYNC_SECRET = 'sync-secret';

let fail = 0;
const ok = (name, cond, note) => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && note ? '  — ' + note : ''}`); };

// ── a fake Supabase: records rpc calls, answers pricing_tiers lookups ──
const TIERS = [
  { key: 'month', mode: 'subscription', price_cents: 500, paypal_plan_id: 'P-MONTH', is_active: true },
  { key: 'year', mode: 'subscription', price_cents: 4800, paypal_plan_id: 'P-YEAR', is_active: true },
  { key: 'lifetime', mode: 'payment', price_cents: 20000, paypal_plan_id: null, is_active: true }
];
const rpcCalls = [];
let holder = null; // who find_user_by_stripe_sub says owns a subscription
const fakeClient = {
  rpc: async (fn, args) => { rpcCalls.push({ fn, args }); return { data: fn === 'find_user_by_stripe_sub' ? holder : null, error: null }; },
  from: () => {
    const filters = [];
    const q = { select: () => q, eq: (c, v) => { filters.push([c, v]); return q; },
      maybeSingle: async () => ({ data: TIERS.find(t => filters.every(([c, v]) => t[c] === v)) || null, error: null }) };
    return q;
  }
};
const supabasePath = require.resolve('../src/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true,
  exports: { anonClient: () => fakeClient, serviceClient: () => fakeClient } };

const paypal = require('../src/paypal');
const realVerifyWebhook = paypal.verifyWebhook; // kept: the tests below replace it with a stub
const billing = require('../src/routes/billing');
const applied = () => rpcCalls.filter(c => c.fn === 'apply_subscription').map(c => c.args);
const reset = () => { rpcCalls.length = 0; holder = null; };

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const mine = billing.customIdFor(ME);

(async () => {
  console.log('\nCustom id ties a payment to a member — and only NoBossly\'s:');
  ok('a NoBossly custom id parses to the member', billing.parseCustom(mine) === ME);
  ok('another app\'s id is not ours', billing.parseCustom('enroute:' + ME) === null);
  ok('a bare uuid is not ours', billing.parseCustom(ME) === null);
  ok('junk and empty are not ours', billing.parseCustom('nobossly:x') === null && billing.parseCustom(null) === null);

  console.log('\nOne processor per member:');
  const stripeMember = { stripe_subscription_id: 'sub_123', subscription_status: 'active', subscription_period_end: new Date(Date.now() + 864e5).toISOString() };
  const paypalMember = { stripe_subscription_id: 'I-ABC', subscription_status: 'active', subscription_period_end: stripeMember.subscription_period_end };
  const free = { subscription_status: null };
  ok('processorOf tells them apart', billing.processorOf(stripeMember) === 'stripe' && billing.processorOf(paypalMember) === 'paypal' && billing.processorOf(free) === null);
  ok('a free member may buy with either', !billing.purchaseBlock(free, 'month', 'stripe') && !billing.purchaseBlock(free, 'month', 'paypal'));
  ok('a Stripe member cannot start a PayPal subscription', !!billing.purchaseBlock(stripeMember, 'month', 'paypal'));
  ok('a PayPal member cannot start a Stripe subscription', !!billing.purchaseBlock(paypalMember, 'year', 'stripe'));
  ok('a Stripe member steps up to lifetime on Stripe only',
    !billing.purchaseBlock(stripeMember, 'lifetime', 'stripe') && /Stripe/.test(billing.purchaseBlock(stripeMember, 'lifetime', 'paypal')));
  ok('a PayPal member steps up to lifetime on PayPal only',
    !billing.purchaseBlock(paypalMember, 'lifetime', 'paypal') && /PayPal/.test(billing.purchaseBlock(paypalMember, 'lifetime', 'stripe')));
  ok('a lifetime member buys nothing', !!billing.purchaseBlock({ is_lifetime: true }, 'lifetime', 'paypal'));

  console.log('\nSubscriptions are re-read from PayPal and checked:');
  const next = '2026-12-01T10:00:00Z';
  const sub = (over) => Object.assign({ id: 'I-1', status: 'ACTIVE', plan_id: 'P-MONTH', custom_id: mine, billing_info: { next_billing_time: next } }, over);
  const stubSub = s => { paypal.getSubscription = async () => s; };

  reset(); stubSub(sub());
  let r = await billing.settleSubscription('I-1', { expectUser: ME });
  let a = applied();
  ok('an active subscription unlocks the right member, tier and period',
    r.state === 'activated' && a.length === 1 && a[0].p_user === ME && a[0].p_tier === 'month' && a[0].p_status === 'active' &&
    a[0].p_sub_id === 'I-1' && a[0].p_period_end === new Date(next).toISOString() && a[0].p_secret === 'sync-secret');
  reset(); stubSub(sub({ plan_id: 'P-YEAR' }));
  await billing.settleSubscription('I-1', { expectUser: ME });
  ok('the tier comes from the plan, so Annual is Annual', applied()[0].p_tier === 'year');
  reset(); stubSub(sub({ custom_id: 'enroute:' + ME }));
  r = await billing.settleSubscription('I-1', {});
  ok('another app\'s subscription is ignored', r.state === 'ignored' && !applied().length);
  reset(); stubSub(sub({ custom_id: billing.customIdFor(OTHER) }));
  r = await billing.settleSubscription('I-1', { expectUser: ME });
  ok('someone else\'s subscription cannot be claimed from the return page', r.state === 'refused' && !applied().length);
  reset(); stubSub(sub({ plan_id: 'P-NOPE' }));
  r = await billing.settleSubscription('I-1', { expectUser: ME });
  ok('a plan no tier uses unlocks nothing', r.state === 'ignored' && !applied().length);
  reset(); stubSub(sub({ status: 'APPROVAL_PENDING' }));
  r = await billing.settleSubscription('I-1', { expectUser: ME });
  ok('approved-but-not-active waits (the webhook finishes it)', r.state === 'pending' && !applied().length);
  reset(); stubSub(sub({ status: 'ACTIVE', billing_info: { last_payment: { time: '2026-10-01T00:00:00Z' } } }));
  await billing.settleSubscription('I-1', {});
  ok('with no next billing time the period is the last payment plus a month', applied()[0].p_period_end === '2026-11-01T00:00:00.000Z');

  reset(); stubSub(sub({ status: 'CANCELLED' })); holder = ME;
  r = await billing.settleSubscription('I-1', {});
  a = applied();
  ok('a cancelled subscription keeps access to the paid period (status canceled)', r.state === 'ended' && a.length === 1 && a[0].p_status === 'canceled' && a[0].p_period_end === null && a[0].p_tier === null);
  reset(); stubSub(sub({ status: 'SUSPENDED' })); holder = ME;
  await billing.settleSubscription('I-1', {});
  ok('a suspended subscription goes past_due', applied()[0].p_status === 'past_due');
  reset(); stubSub(sub({ status: 'EXPIRED' })); holder = ME;
  await billing.settleSubscription('I-1', {});
  ok('an expired subscription expires', applied()[0].p_status === 'expired');
  reset(); stubSub(sub({ status: 'CANCELLED' })); holder = null;
  r = await billing.settleSubscription('I-1', {});
  ok('a cancellation for a subscription no member holds changes nothing', r.state === 'ignored' && !applied().length);

  console.log('\nLifetime orders are checked BEFORE the money is taken:');
  const order = (over, amount) => Object.assign({ id: 'O-1', status: 'APPROVED',
    purchase_units: [{ custom_id: mine, amount: { currency_code: 'USD', value: amount || '200.00' } }] }, over);
  const done = o => Object.assign({}, o, { status: 'COMPLETED', purchase_units: [Object.assign({}, o.purchase_units[0], { payments: { captures: [{ status: 'COMPLETED' }] } })] });
  let captured = 0;
  paypal.captureOrder = async () => { captured++; return { order: done(order()), declined: false }; };
  const stubOrder = o => { paypal.getOrder = async () => o; };

  reset(); captured = 0; stubOrder(order());
  r = await billing.settleOrder('O-1', { expectUser: ME });
  a = applied();
  ok('an approved $200 order is captured and unlocks lifetime', r.state === 'activated' && captured === 1 && a.length === 1 && a[0].p_user === ME && a[0].p_lifetime === true && a[0].p_tier === 'lifetime');
  reset(); captured = 0; stubOrder(order({}, '2.00'));
  r = await billing.settleOrder('O-1', { expectUser: ME });
  ok('an order for the wrong amount is refused and NEVER captured', r.state === 'refused' && captured === 0 && !applied().length);
  reset(); captured = 0; stubOrder(order({ purchase_units: [{ custom_id: mine, amount: { currency_code: 'EUR', value: '200.00' } }] }));
  r = await billing.settleOrder('O-1', { expectUser: ME });
  ok('...and so is one in another currency', r.state === 'refused' && captured === 0);
  reset(); captured = 0; stubOrder(order({ purchase_units: [{ custom_id: billing.customIdFor(OTHER), amount: { currency_code: 'USD', value: '200.00' } }] }));
  r = await billing.settleOrder('O-1', { expectUser: ME });
  ok('someone else\'s order cannot be claimed', r.state === 'refused' && captured === 0 && !applied().length);
  reset(); captured = 0; stubOrder(order({ purchase_units: [{ custom_id: 'enroute:xyz', amount: { currency_code: 'USD', value: '200.00' } }] }));
  r = await billing.settleOrder('O-1', {});
  ok('another app\'s order is ignored and never captured', r.state === 'ignored' && captured === 0);
  reset(); captured = 0; stubOrder(done(order()));
  r = await billing.settleOrder('O-1', { expectUser: ME });
  ok('an already-captured order unlocks without capturing twice', r.state === 'activated' && captured === 0 && applied().length === 1);
  reset(); captured = 0; paypal.captureOrder = async () => ({ order: null, declined: true }); stubOrder(order());
  r = await billing.settleOrder('O-1', { expectUser: ME });
  ok('a declined payment unlocks nothing', r.state === 'declined' && !applied().length);
  let cancelled = null; paypal.cancelSubscription = async id => { cancelled = id; return true; };
  reset(); paypal.captureOrder = async () => ({ order: done(order()), declined: false }); stubOrder(order());
  await billing.settleOrder('O-1', { expectUser: ME, profile: { stripe_subscription_id: 'I-OLD' } });
  ok('buying lifetime cancels the PayPal subscription that was billing', cancelled === 'I-OLD');

  console.log('\nThe webhook:');
  const post = async (event, { verified = true } = {}) => {
    paypal.verifyWebhook = async () => verified;
    const res = { code: 0, status(c) { this.code = c; return this; }, send() { return this; } };
    await billing.paypalWebhook({ body: Buffer.from(JSON.stringify(event)), get: () => '' }, res);
    return res.code;
  };
  reset(); stubSub(sub());
  ok('a forged delivery is refused and does nothing', (await post({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } }, { verified: false })) === 400 && !applied().length);
  reset(); stubSub(sub());
  ok('an activation unlocks the member even if they closed the tab',
    (await post({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } })) === 200 && applied().length === 1 && applied()[0].p_user === ME);
  reset(); stubSub(sub());
  await post({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-1' } });
  ok('a renewal payment re-reads the subscription it belongs to', applied().length === 1);
  reset(); stubSub(sub());
  await post({ event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: { id: 'I-1' } });
  ok('a merely created subscription is left alone', !applied().length);
  reset(); stubOrder(order()); paypal.captureOrder = async () => ({ order: done(order()), declined: false });
  await post({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'O-1' } });
  ok('an approved lifetime order is finished by the webhook', applied().length === 1 && applied()[0].p_lifetime === true);
  paypal.getSubscription = async () => { throw new paypal.Transient('PayPal is down'); };
  ok('a PayPal outage answers 5xx so PayPal redelivers', (await post({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } })) === 500);
  const noId = process.env.PAYPAL_WEBHOOK_ID; delete process.env.PAYPAL_WEBHOOK_ID;
  ok('with no PAYPAL_WEBHOOK_ID it refuses rather than trusting unsigned bodies', (await post({ event_type: 'X', resource: {} })) === 503);
  process.env.PAYPAL_WEBHOOK_ID = noId;

  console.log('\nPayPal\'s own helpers:');
  ok('money is formatted the way PayPal wants it', paypal.moneyValue(500) === '5.00' && paypal.moneyValue(20000) === '200.00' && paypal.toCents('4.80') === 480);
  ok('only paypal.com links are followed', paypal.isPaypalHost('https://www.paypal.com/x') && !paypal.isPaypalHost('https://paypal.com.evil.io/x') && !paypal.isPaypalHost('nonsense'));
  const terms = paypal.planTerms({ status: 'ACTIVE', billing_cycles: [{ tenure_type: 'REGULAR', total_cycles: 0,
    frequency: { interval_unit: 'MONTH', interval_count: 1 }, pricing_scheme: { fixed_price: { value: '5.00', currency_code: 'USD' } } }] });
  ok('a plan\'s real price and interval are read from it', terms.cents === 500 && terms.unit === 'MONTH' && terms.count === 1 && terms.status === 'ACTIVE');
  ok('a body that is not one JSON object is refused before it is sent to PayPal',
    (await realVerifyWebhook(() => '', '[1,2]')) === false && (await realVerifyWebhook(() => '', 'nope')) === false);

  console.log('\nWiring:');
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = src('server.js'), bill = src('src/routes/billing.js'), pricing = src('views/pricing.ejs');
  ok('the PayPal webhook gets the raw body, before the JSON parser',
    /app\.post\('\/billing\/paypal\/webhook', express\.raw\(\{ type: '\*\/\*' \}\), billing\.paypalWebhook\)/.test(server) &&
    server.indexOf('/billing/paypal/webhook') < server.indexOf('app.use(express.json())'));
  ok('the return page only ever settles for the signed-in member', /expectUser: req\.user\.id/.test(bill));
  ok('an order is checked before it is captured', bill.indexOf("not the Lifetime price; not capturing") < bill.indexOf('paypal.captureOrder(orderId)'));
  ok('a subscription plan is checked against the tier before it is sold', /does not match tier/.test(bill));
  ok('PayPal is hidden while a markdown runs (the plan has one fixed price)', /!\(t\.offer && t\.offer\.isPromo\)/.test(bill));
  const forms = pricing.match(/<form[^\n]*\/billing\/paypal\/checkout[^\n]*/g) || [];
  ok('the PayPal buttons are found and bypass Turbo (fetch cannot follow the redirect to PayPal)', forms.length === 1 && /data-turbo="false"/.test(forms[0]));
  ok('the Stripe button is still there', /<form[^\n]*\/billing\/checkout\/[^\n]*data-turbo="false"/.test(pricing));

  if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch(e => { console.error(e); process.exit(1); });
