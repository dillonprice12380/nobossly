// PayPal Premium checkout: the pure helpers, then the real routes' decisions run
// against a fake PayPal and a fake Supabase (global fetch is replaced, nothing
// leaves the machine).
//
// The things that must never happen:
//   * Premium granted for a subscription on the wrong PayPal plan, a plan that
//     sells a different price, or a payment that has not happened;
//   * Premium granted to the wrong member, or for another app's PayPal object;
//   * a webhook that PayPal has not vouched for changing anyone's plan;
//   * Lifetime charged at a price other than the one on offer.
//
//   node test/paypal.js

process.env.SUPABASE_URL = 'https://fake.supabase.test';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUB_SYNC_SECRET = 'sync-secret';
process.env.PAYPAL_CLIENT_ID = 'cid';
process.env.PAYPAL_CLIENT_SECRET = 'csecret';
process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
process.env.SITE_URL = 'https://nobossly.test';

const fs = require('fs');
const path = require('path');
const plan = require('../src/paypalPlan');

let fail = 0;
const ok = (name, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail !== undefined ? '  — ' + detail : ''}`); };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const MONTH_PLAN = 'P-1XT24633L8241682JNLRY2GY';
const YEAR_PLAN = 'P-6R276282EC310145KNLRY2WQ';

const planOf = (id, cents, unit) => ({
  id, status: 'ACTIVE',
  billing_cycles: [{ tenure_type: 'REGULAR', total_cycles: 0, frequency: { interval_unit: unit, interval_count: 1 },
    pricing_scheme: { fixed_price: { currency_code: 'USD', value: (cents / 100).toFixed(2) } } }],
  payment_preferences: { setup_fee: { currency_code: 'USD', value: '0.0' } }
});

// ---------------------------------------------------------------------------
console.log('\nCustom ids only ever point at NoBossly:');
ok('a NoBossly id parses', JSON.stringify(plan.parseCustomId(plan.customId(U1, 'month'))) === JSON.stringify({ userId: U1, tier: 'month' }));
ok('all three tiers parse', ['month', 'year', 'lifetime'].every(t => plan.parseCustomId(plan.customId(U1, t))));
ok("EnRoute's bare user id is not ours", plan.parseCustomId(U1) === null);
ok("EnRoute's company ids are not ours", plan.parseCustomId('c:' + U1) === null && plan.parseCustomId('p:' + U1) === null);
ok('an unknown tier is refused', plan.parseCustomId(`nobossly:${U1}:forever`) === null);
ok('a non-uuid user is refused', plan.parseCustomId('nobossly:bob:month') === null);
ok('trailing junk is refused', plan.parseCustomId(`nobossly:${U1}:month:extra`) === null && plan.parseCustomId(`nobossly:${U1}:month `) === null);
ok('non-strings are refused', plan.parseCustomId(null) === null && plan.parseCustomId(42) === null);

console.log('\nA PayPal plan must sell exactly what we advertise:');
const m = (p, e) => plan.planMismatch(p, Object.assign({ amountCents: 500, currency: 'usd', interval: 'month' }, e || {}));
ok('the monthly plan at $5.00 every 1 month matches', m(planOf(MONTH_PLAN, 500, 'MONTH')) === null);
ok('the annual plan at $48.00 every 1 year matches', m(planOf(YEAR_PLAN, 4800, 'YEAR'), { amountCents: 4800, interval: 'year' }) === null);
ok('a missing plan is refused', m(null) !== null);
ok('a switched-off plan is refused', m(Object.assign(planOf('P-X', 500, 'MONTH'), { status: 'INACTIVE' })) !== null);
ok('the wrong price is refused', m(planOf('P-X', 600, 'MONTH')) !== null);
ok('a markdown price the plan does not sell is refused', m(planOf('P-X', 500, 'MONTH'), { amountCents: 250 }) !== null);
ok('a yearly plan sold as monthly is refused', m(planOf('P-X', 500, 'YEAR')) !== null);
ok('a monthly plan sold as yearly is refused', m(planOf('P-X', 4800, 'MONTH'), { amountCents: 4800, interval: 'year' }) !== null);
ok('the wrong currency is refused', m(planOf('P-X', 500, 'MONTH'), { currency: 'eur' }) !== null);
const trial = planOf('P-X', 500, 'MONTH'); trial.billing_cycles.unshift({ tenure_type: 'TRIAL', frequency: { interval_unit: 'MONTH', interval_count: 1 }, pricing_scheme: { fixed_price: { currency_code: 'USD', value: '0.00' } } });
ok('a free trial is refused', m(trial) !== null);
const setup = planOf('P-X', 500, 'MONTH'); setup.payment_preferences.setup_fee = { currency_code: 'USD', value: '10.00' };
ok('a set-up fee is refused', m(setup) !== null);
const fixed = planOf('P-X', 500, 'MONTH'); fixed.billing_cycles[0].total_cycles = 3;
ok('a plan that stops after a few cycles is refused', m(fixed) !== null);
ok('every 2 months is refused', m(Object.assign(planOf('P-X', 500, 'MONTH'), { billing_cycles: [Object.assign({}, planOf('P-X', 500, 'MONTH').billing_cycles[0], { frequency: { interval_unit: 'MONTH', interval_count: 2 } })] })) !== null);

console.log('\nAccess follows a real payment:');
const paidSub = (over) => Object.assign({ id: 'I-SUB', plan_id: MONTH_PLAN, status: 'ACTIVE', custom_id: plan.customId(U1, 'month'),
  billing_info: { last_payment: { amount: { currency_code: 'USD', value: '5.00' }, time: '2026-10-29T12:00:00Z' }, next_billing_time: '2026-11-29T12:00:00Z', failed_payments_count: 0 } }, over || {});
const exp = { amountCents: 500, currency: 'usd' };
const pp1 = plan.paidPeriod(paidSub(), exp);
ok('a completed $5 payment is a paid month', pp1.paid && pp1.end === '2026-11-29T12:00:00.000Z');
ok('an approved subscription with no payment is not paid', !plan.paidPeriod(paidSub({ billing_info: {} }), exp).paid);
ok('an underpayment is not paid', !plan.paidPeriod(paidSub({ billing_info: { last_payment: { amount: { currency_code: 'USD', value: '1.00' }, time: '2026-10-29T12:00:00Z' }, next_billing_time: '2026-11-29T12:00:00Z' } }), exp).paid);
ok('no next billing time is not paid', !plan.paidPeriod(paidSub({ billing_info: { last_payment: { amount: { currency_code: 'USD', value: '5.00' }, time: '2026-10-29T12:00:00Z' } } }), exp).paid);
ok('ACTIVE → active', plan.statusFromPayPal(paidSub()) === 'active');
ok('ACTIVE with a failed payment → past_due', plan.statusFromPayPal(paidSub({ billing_info: { failed_payments_count: 1 } })) === 'past_due');
ok('SUSPENDED → past_due, CANCELLED → canceled, EXPIRED → expired',
  plan.statusFromPayPal({ status: 'SUSPENDED' }) === 'past_due' && plan.statusFromPayPal({ status: 'CANCELLED' }) === 'canceled' && plan.statusFromPayPal({ status: 'EXPIRED' }) === 'expired');
ok('APPROVAL_PENDING and APPROVED change nothing', plan.statusFromPayPal({ status: 'APPROVAL_PENDING' }) === null && plan.statusFromPayPal({ status: 'APPROVED' }) === null);
ok('capture ids are read from refund links', plan.captureIdFromLinks([{ rel: 'self', href: 'https://api.paypal.com/v2/payments/refunds/R1' }, { rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAP123' }]) === 'CAP123');
ok('the lifetime floor is the cheaper of list and markdown', plan.lifetimeFloorCents({ price_cents: 20000, promo_price_cents: 10000 }) === 10000 && plan.lifetimeFloorCents({ price_cents: 20000 }) === 20000);

// ---------------------------------------------------------------------------
// A fake PayPal and a fake Supabase behind global fetch.
const world = {};
function reset() {
  Object.assign(world, {
    tiers: {
      month: { key: 'month', name: 'Premium Monthly', mode: 'subscription', price_cents: 500, paypal_plan_id: MONTH_PLAN, is_active: true, promo_price_cents: null, promo_ends_at: null },
      year: { key: 'year', name: 'Premium Annual', mode: 'subscription', price_cents: 4800, paypal_plan_id: YEAR_PLAN, is_active: true, promo_price_cents: null, promo_ends_at: null },
      lifetime: { key: 'lifetime', name: 'Premium Lifetime', mode: 'payment', price_cents: 20000, paypal_plan_id: null, is_active: true, promo_price_cents: null, promo_ends_at: null }
    },
    plans: { [MONTH_PLAN]: planOf(MONTH_PLAN, 500, 'MONTH'), [YEAR_PLAN]: planOf(YEAR_PLAN, 4800, 'YEAR'), 'P-ENROUTE': planOf('P-ENROUTE', 800, 'MONTH') },
    subs: {}, orders: {}, captures: {}, sales: {},
    holder: null, rpc: [], paypalCalls: [], captured: [], cancelled: [], badSignature: false, createdOrders: [], profileRow: { paypal_subscription_id: null, stripe_customer_id: null }
  });
}
reset();

const json = (body, status) => ({ ok: (status || 200) < 300, status: status || 200, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body, headers: new Headers({ 'content-type': 'application/json' }) });

global.fetch = async (url, init) => {
  url = String(url); init = init || {};
  const method = init.method || 'GET';
  const body = init.body ? (() => { try { return JSON.parse(init.body); } catch (_) { return init.body; } })() : undefined;
  if (url.startsWith('https://api-m.paypal.com')) {
    const p = url.replace('https://api-m.paypal.com', '');
    world.paypalCalls.push(method + ' ' + p);
    if (p === '/v1/oauth2/token') return json({ access_token: 'tok', expires_in: 3600 });
    let mm;
    if ((mm = /^\/v1\/billing\/subscriptions\/([^/]+)\/cancel$/.exec(p))) { world.cancelled.push(mm[1]); return json(undefined, 204); }
    if ((mm = /^\/v1\/billing\/subscriptions\/([^/]+)$/.exec(p))) return world.subs[mm[1]] ? json(world.subs[mm[1]]) : json({}, 404);
    if ((mm = /^\/v1\/billing\/plans\/([^/]+)$/.exec(p))) return world.plans[mm[1]] ? json(world.plans[mm[1]]) : json({}, 404);
    if ((mm = /^\/v1\/payments\/sale\/([^/]+)$/.exec(p))) return world.sales[mm[1]] ? json(world.sales[mm[1]]) : json({}, 404);
    if ((mm = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(p))) {
      const o = world.orders[mm[1]]; if (!o) return json({}, 404);
      world.captured.push(mm[1]);
      o.status = 'COMPLETED';
      o.purchase_units[0].payments = { captures: [{ id: 'CAP-' + mm[1], status: world.captureStatus || 'COMPLETED', custom_id: o.purchase_units[0].custom_id, amount: o.purchase_units[0].amount }] };
      return json(o, 201);
    }
    if (p === '/v2/checkout/orders' && method === 'POST') { world.createdOrders.push(body); return json({ id: 'ORD-NEW', links: [{ rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=ORD-NEW' }] }, 201); }
    if ((mm = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(p))) return world.orders[mm[1]] ? json(world.orders[mm[1]]) : json({}, 404);
    if ((mm = /^\/v2\/payments\/captures\/([^/]+)$/.exec(p))) return world.captures[mm[1]] ? json(world.captures[mm[1]]) : json({}, 404);
    if (p === '/v1/notifications/verify-webhook-signature') return json({ verification_status: world.badSignature ? 'FAILURE' : 'SUCCESS' });
    if (p === '/v1/billing/subscriptions' && method === 'POST') return json({ id: 'I-NEW', links: [{ rel: 'approve', href: 'https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1' }] }, 201);
    return json({ message: 'unexpected ' + p }, 500);
  }
  if (url.startsWith('https://fake.supabase.test/rest/v1/rpc/')) {
    const fn = url.split('/rpc/')[1];
    world.rpc.push({ fn, args: body });
    if (fn === 'find_user_by_paypal_sub') return json(world.holder);
    if (fn === 'revoke_paypal_lifetime') return json(U1);
    return json(null, 200);
  }
  if (url.startsWith('https://fake.supabase.test/rest/v1/pricing_tiers')) {
    const k = /key=eq\.([a-z]+)/.exec(url);
    return json(k ? world.tiers[k[1]] || null : Object.values(world.tiers));
  }
  if (url.startsWith('https://fake.supabase.test/rest/v1/profiles')) return json(world.profileRow);
  return json({ message: 'unexpected ' + url }, 500);
};

const pb = require('../src/routes/paypal_billing');
const applies = () => world.rpc.filter(c => c.fn === 'apply_paypal_subscription');
const mkres = () => ({ code: 0, status(c) { this.code = c; return this; }, send(t) { this.body = t; return this; }, redirect(a, b) { this.to = b || a; this.code = b ? a : 302; return this; } });
const sig = {};
const mkreq = (event) => ({ body: Buffer.from(JSON.stringify(event)), get: n => sig[n] || 'x' });

(async () => {
  console.log('\nSubscriptions are granted only when they are right:');
  reset(); world.subs['I-SUB'] = paidSub();
  let r = await pb.syncSubscription('I-SUB', { expectUser: U1 });
  ok('a paid subscription on the monthly plan is granted', r.result === 'granted', JSON.stringify(r));
  const a = applies()[0] && applies()[0].args;
  ok('...to the member named in custom_id, as the month tier, until the next billing time',
    a && a.p_user === U1 && a.p_tier === 'month' && a.p_status === 'active' && a.p_sub_id === 'I-SUB' && a.p_period_end === '2026-11-29T12:00:00.000Z' && a.p_lifetime === false, JSON.stringify(a));
  ok('...using the shared sync secret', a && a.p_secret === 'sync-secret');

  reset(); world.subs['I-SUB'] = paidSub({ plan_id: 'P-ENROUTE' });
  r = await pb.syncSubscription('I-SUB');
  ok("a subscription on another plan (EnRoute's) is refused", r.result === 'refused' && applies().length === 0, JSON.stringify(r));

  reset(); world.subs['I-SUB'] = paidSub({ plan_id: YEAR_PLAN });
  r = await pb.syncSubscription('I-SUB');
  ok('a monthly custom_id on the annual plan is refused', r.result === 'refused' && applies().length === 0);

  reset(); world.plans[MONTH_PLAN] = planOf(MONTH_PLAN, 100, 'MONTH'); world.subs['I-SUB'] = paidSub();
  r = await pb.syncSubscription('I-SUB');
  ok('a plan whose price was changed to $1 is refused', r.result === 'refused' && applies().length === 0);

  reset(); world.subs['I-SUB'] = paidSub({ billing_info: {} });
  r = await pb.syncSubscription('I-SUB');
  ok('approved but not yet charged is pending, not granted', r.result === 'pending' && applies().length === 0);

  reset(); world.subs['I-SUB'] = paidSub({ custom_id: U1 });
  r = await pb.syncSubscription('I-SUB');
  ok("another app's subscription (bare user id) is ignored", r.result === 'ignored' && applies().length === 0);

  reset(); world.subs['I-SUB'] = paidSub();
  r = await pb.syncSubscription('I-SUB', { expectUser: U2 });
  ok("someone else's subscription cannot be claimed from another account", r.result === 'refused' && applies().length === 0);

  reset(); world.subs['I-SUB'] = paidSub({ status: 'CANCELLED' }); world.holder = null;
  r = await pb.syncSubscription('I-SUB');
  ok('a cancellation for a subscription nobody holds changes nothing', r.result === 'ignored' && applies().length === 0);

  reset(); world.subs['I-SUB'] = paidSub({ status: 'CANCELLED' }); world.holder = U1;
  r = await pb.syncSubscription('I-SUB');
  ok('a cancellation for the member who holds it marks them canceled (access runs to period end)',
    r.result === 'updated' && applies()[0].args.p_status === 'canceled' && applies()[0].args.p_period_end === null && applies()[0].args.p_user === U1);

  reset(); world.subs['I-SUB'] = paidSub({ status: 'SUSPENDED' }); world.holder = U1;
  await pb.syncSubscription('I-SUB');
  ok('a suspended subscription becomes past_due', applies()[0] && applies()[0].args.p_status === 'past_due');

  reset(); world.tiers.year; world.subs['I-Y'] = paidSub({ id: 'I-Y', plan_id: YEAR_PLAN, custom_id: plan.customId(U1, 'year'),
    billing_info: { last_payment: { amount: { currency_code: 'USD', value: '48.00' }, time: '2026-10-29T12:00:00Z' }, next_billing_time: '2027-10-29T12:00:00Z' } });
  r = await pb.syncSubscription('I-Y');
  ok('the annual plan is granted for a year', r.result === 'granted' && applies()[0].args.p_tier === 'year' && applies()[0].args.p_period_end === '2027-10-29T12:00:00.000Z');

  console.log('\nLifetime is charged at the price on offer, and only then granted:');
  const order = (over) => Object.assign({ id: 'ORD-1', status: 'APPROVED', purchase_units: [{ custom_id: plan.customId(U1, 'lifetime'), amount: { currency_code: 'USD', value: '200.00' } }] }, over || {});

  reset(); world.orders['ORD-1'] = order();
  r = await pb.settleOrder('ORD-1', { expectUser: U1 });
  ok('an approved $200 order is captured and Lifetime granted', r.result === 'granted' && world.captured.length === 1, JSON.stringify(r));
  const la = applies()[0] && applies()[0].args;
  ok('...as lifetime, with the capture id kept for refunds', la && la.p_lifetime === true && la.p_tier === 'lifetime' && la.p_capture_id === 'CAP-ORD-1' && la.p_user === U1, JSON.stringify(la));

  reset(); world.orders['ORD-1'] = order({ purchase_units: [{ custom_id: plan.customId(U1, 'lifetime'), amount: { currency_code: 'USD', value: '1.00' } }] });
  r = await pb.settleOrder('ORD-1');
  ok('an order for $1 is never captured', r.result === 'refused' && world.captured.length === 0 && applies().length === 0);

  reset(); world.tiers.lifetime.promo_price_cents = 10000; world.orders['ORD-1'] = order({ purchase_units: [{ custom_id: plan.customId(U1, 'lifetime'), amount: { currency_code: 'USD', value: '100.00' } }] });
  r = await pb.settleOrder('ORD-1');
  ok('during a markdown the markdown price is what gets captured', r.result === 'granted' && world.captured.length === 1);

  reset(); world.orders['ORD-1'] = order({ purchase_units: [{ custom_id: plan.customId(U1, 'lifetime'), amount: { currency_code: 'USD', value: '100.00' } }] });
  r = await pb.settleOrder('ORD-1');
  ok('a stale markdown price after the markdown ended is not captured', r.result === 'refused' && world.captured.length === 0);

  reset(); world.orders['ORD-1'] = order({ purchase_units: [{ custom_id: 'some-other-order', amount: { currency_code: 'USD', value: '200.00' } }] });
  r = await pb.settleOrder('ORD-1');
  ok("another app's order is ignored, not captured", r.result === 'ignored' && world.captured.length === 0 && applies().length === 0);

  reset(); world.orders['ORD-1'] = order();
  r = await pb.settleOrder('ORD-1', { expectUser: U2 });
  ok("someone else's order cannot be claimed from another account", r.result === 'refused' && world.captured.length === 0 && applies().length === 0);

  reset(); world.orders['ORD-1'] = order({ status: 'CREATED' });
  r = await pb.settleOrder('ORD-1');
  ok('an order the buyer never approved is pending', r.result === 'pending' && world.captured.length === 0 && applies().length === 0);

  reset(); world.captureStatus = 'PENDING'; world.orders['ORD-1'] = order();
  r = await pb.settleOrder('ORD-1');
  ok('a capture that is still pending is not granted yet', r.result === 'pending' && applies().length === 0);

  reset(); world.captures['CAP-9'] = { id: 'CAP-9', status: 'COMPLETED', custom_id: plan.customId(U1, 'lifetime'), amount: { currency_code: 'USD', value: '200.00' } };
  r = await pb.settleCaptureById('CAP-9');
  ok('a completed capture arriving by webhook grants Lifetime', r.result === 'granted' && applies()[0].args.p_capture_id === 'CAP-9');

  reset(); world.captures['CAP-9'] = { id: 'CAP-9', status: 'COMPLETED', custom_id: plan.customId(U1, 'lifetime'), amount: { currency_code: 'USD', value: '5.00' } };
  r = await pb.settleCaptureById('CAP-9');
  ok('...but not an underpayment', r.result === 'refused' && applies().length === 0);

  console.log('\nThe webhook obeys only PayPal:');
  reset(); world.badSignature = true; world.subs['I-SUB'] = paidSub();
  let res = mkres();
  await pb.webhook(mkreq({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-SUB' } }), res);
  ok('a delivery PayPal does not vouch for is refused (400) and changes nothing', res.code === 400 && applies().length === 0);

  reset(); world.subs['I-SUB'] = paidSub();
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-SUB' } }), res);
  ok('a verified activation is applied', res.code === 200 && applies().length === 1);

  reset(); world.subs['I-SUB'] = paidSub();
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE1', billing_agreement_id: 'I-SUB' } }), res);
  ok('a verified renewal payment is applied', res.code === 200 && applies().length === 1);

  reset();
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-UNKNOWN' } }), res);
  ok('an unknown subscription is acknowledged and ignored', res.code === 200 && applies().length === 0);

  reset(); world.captures['CAP1'] = { id: 'CAP1', status: 'REFUNDED' };
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF1', links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAP1' }] } }), res);
  const rev = world.rpc.filter(c => c.fn === 'revoke_paypal_lifetime');
  ok('a fully refunded Lifetime payment takes Lifetime back', res.code === 200 && rev.length === 1 && rev[0].args.p_capture_id === 'CAP1');

  reset(); world.captures['CAP1'] = { id: 'CAP1', status: 'PARTIALLY_REFUNDED' };
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF1', links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAP1' }] } }), res);
  ok('a partial refund leaves Lifetime alone', world.rpc.filter(c => c.fn === 'revoke_paypal_lifetime').length === 0);

  reset(); world.holder = U1;
  world.sales['SALE1'] = { id: 'SALE1', state: 'refunded', billing_agreement_id: 'I-SUB', create_time: '2026-10-29T12:00:30Z' };
  world.subs['I-SUB'] = paidSub();
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'PAYMENT.SALE.REFUNDED', resource: { id: 'REF1', sale_id: 'SALE1' } }), res);
  ok("refunding the latest subscription payment ends that membership and stops billing",
    res.code === 200 && world.cancelled.includes('I-SUB') && applies()[0] && applies()[0].args.p_status === 'expired');

  reset(); world.holder = U1;
  world.sales['SALE0'] = { id: 'SALE0', state: 'refunded', billing_agreement_id: 'I-SUB', create_time: '2026-08-29T12:00:00Z' };
  world.subs['I-SUB'] = paidSub();
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'PAYMENT.SALE.REFUNDED', resource: { id: 'REF1', sale_id: 'SALE0' } }), res);
  ok('refunding an older month does not cut off the current one', world.cancelled.length === 0 && applies().length === 0);

  // PayPal being down must make PayPal retry, not lose the event.
  reset();
  const realFetch = global.fetch;
  global.fetch = async (u, i) => String(u).includes('/v1/billing/subscriptions/') ? json({}, 503) : realFetch(u, i);
  world.subs['I-SUB'] = paidSub();
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-SUB' } }), res);
  ok('a PayPal outage answers 5xx so PayPal retries', res.code === 500);
  global.fetch = realFetch;

  console.log('\nWithout credentials nothing is offered or accepted:');
  const keep = process.env.PAYPAL_WEBHOOK_ID;
  delete process.env.PAYPAL_WEBHOOK_ID; reset(); world.subs['I-SUB'] = paidSub();
  res = mkres();
  await pb.webhook(mkreq({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-SUB' } }), res);
  ok('with no PAYPAL_WEBHOOK_ID every delivery is refused (fails closed)', res.code === 400 && applies().length === 0);
  process.env.PAYPAL_WEBHOOK_ID = keep;
  const id = process.env.PAYPAL_CLIENT_ID; delete process.env.PAYPAL_CLIENT_ID;
  ok('without PAYPAL_CLIENT_ID PayPal is not ready', pb.ready() === false);
  process.env.PAYPAL_CLIENT_ID = id;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  ok('without the service role key PayPal is not ready (a payment could not be applied)', pb.ready() === false);
  process.env.SUPABASE_SERVICE_ROLE_KEY = svc;
  ok('with everything set PayPal is ready', pb.ready() === true);

  console.log('\nThe pages:');
  const pricingView = read('views/pricing.ejs');
  const accountView = read('views/account.ejs');
  const ppForms = [...pricingView.match(/<form[^\n]*\/billing\/paypal\/checkout[^\n]*/g) || []];
  ok('the PayPal checkout form is on the pricing page', ppForms.length === 1);
  ok('...and bypasses Turbo, because it redirects to paypal.com', ppForms.every(f => /data-turbo="false"/.test(f)));
  ok('...and only shows when PayPal can take the payment', /paypalEnabled/.test(pricingView));
  ok('...and only for tiers PayPal can sell', /t\.mode === 'payment' \|\| t\.paypal_plan_id/.test(pricingView));
  ok('a PayPal member is pointed to PayPal, not the Stripe portal', /paypal_subscription_id/.test(accountView));
  const billingSrc = read('src/routes/billing.js');
  ok('cancelling a PayPal membership goes through PayPal', /paypalBilling\.cancelFor/.test(billingSrc));
  ok('buying Lifetime with a card also ends a PayPal subscription', (billingSrc.match(/paypalBilling\.endPaypalFor/g) || []).length === 2);
  const server = read('server.js');
  ok('the PayPal webhook is mounted with the raw body, before the JSON parser',
    server.indexOf("'/billing/paypal/webhook', express.raw") > 0 && server.indexOf("'/billing/paypal/webhook'") < server.indexOf('express.json()'));
  const mig = read('migrations/2026-10-29_paypal_payments.sql');
  ok('the migration protects the new profile columns from member edits', /new\.paypal_subscription_id\s+:= old\.paypal_subscription_id/.test(mig) && /new\.paypal_capture_id\s+:= old\.paypal_capture_id/.test(mig));
  ok('...and the new billing functions are service-role only', !/grant\s+execute[^;]*\bto\s+(anon|authenticated|public)/i.test(mig));
  ok('...and Stripe grants let go of a PayPal subscription', /paypal_subscription_id = case when p_sub_id is not null then null/.test(mig));

  if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch(e => { console.error(e); process.exit(1); });
