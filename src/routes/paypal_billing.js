// PayPal checkout for Premium, beside Stripe (src/routes/billing.js).
//
//   Monthly / Annual   a PayPal subscription on the plan stored in
//                      pricing_tiers.paypal_plan_id
//   Lifetime           a one-time PayPal order, captured when the member returns
//
// Nothing the browser or a webhook payload says is believed. Every grant is
// decided from what PayPal returns when we ask it directly:
//   * the subscription / order is fetched from PayPal by id,
//   * its custom_id (stamped by us, "nobossly:<user>:<tier>") says whose it is,
//   * its plan must be THIS tier's plan, and that plan must sell exactly the
//     price and interval pricing_tiers says,
//   * access follows an actual completed payment, not an approval click.
// Webhooks are verified with PayPal (fail closed) and then only used as a
// nudge to re-read the object they name.

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const premium = require('../premium');
const pricing = require('../pricing');
const pp = require('../paypal');
const plan = require('../paypalPlan');
const { anonClient, serviceClient } = require('../supabase');

const SUB_SECRET = () => process.env.SUB_SYNC_SECRET || '';
const SITE = () => (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');
const CURRENCY = 'usd';

// The PayPal grants run over the service role only (the functions are not
// EXECUTE-able by anon). No service role key means no PayPal checkout: better
// to say so than to take a payment that cannot be applied.
function svc() {
  try { return serviceClient(); } catch (_) { return null; }
}
const ready = () => pp.isEnabled() && !!SUB_SECRET() && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

async function rpc(fn, args) {
  const sb = svc();
  if (!sb) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const { data, error } = await sb.rpc(fn, Object.assign({ p_secret: SUB_SECRET() }, args));
  if (error) throw new Error(fn + ': ' + error.message);
  return data;
}

async function applyPaypal(userId, { tier, status, subId, periodEnd, lifetime, captureId }) {
  await rpc('apply_paypal_subscription', {
    p_user: userId, p_tier: tier || null, p_status: status || null,
    p_sub_id: subId || null, p_period_end: periodEnd || null,
    p_lifetime: !!lifetime, p_capture_id: captureId || null
  });
}

const findBySub = subId => rpc('find_user_by_paypal_sub', { p_sub_id: subId });

// Any tier, active or not: an inactive tier still has members to keep paying.
async function tierRow(key) {
  const sb = svc() || anonClient();
  const { data, error } = await sb.from('pricing_tiers').select('*').eq('key', key).maybeSingle();
  if (error) throw new Error('pricing_tiers: ' + error.message);
  return data;
}

// ─── Reading PayPal into profiles ───────────────────────────────────────────

// Re-read a subscription from PayPal and make the member's plan match it.
// → { result: 'granted' | 'updated' | 'pending' | 'ignored' | 'refused', reason?, userId? }
async function syncSubscription(subId, opts) {
  opts = opts || {};
  const sub = await pp.getSubscription(subId);
  if (!sub) return { result: 'ignored', reason: 'unknown subscription' };
  const cid = plan.parseCustomId(sub.custom_id);
  if (!cid || cid.tier === 'lifetime') return { result: 'ignored', reason: 'not a NoBossly subscription' };
  if (opts.expectUser && cid.userId !== opts.expectUser) return { result: 'refused', reason: 'belongs to another member' };

  const tier = await tierRow(cid.tier);
  if (!tier || !tier.paypal_plan_id || sub.plan_id !== tier.paypal_plan_id) {
    console.error(`[paypal] subscription ${subId} is on plan ${sub.plan_id}, not the ${cid.tier} plan — ignored`);
    return { result: 'refused', reason: 'not the NoBossly plan for this tier' };
  }
  const planObj = await pp.getPlan(sub.plan_id);
  const bad = plan.planMismatch(planObj, { amountCents: tier.price_cents, currency: CURRENCY, interval: cid.tier === 'year' ? 'year' : 'month' });
  if (bad) {
    console.error(`[paypal] plan ${sub.plan_id} does not match the ${cid.tier} tier (${bad}) — subscription ${subId} not applied`);
    return { result: 'refused', reason: bad };
  }

  const status = plan.statusFromPayPal(sub);
  if (!status) return { result: 'pending', reason: 'subscription ' + (sub.status || 'unknown') };

  if (status === 'active') {
    const period = plan.paidPeriod(sub, { amountCents: tier.price_cents, currency: CURRENCY });
    if (!period.paid) return { result: 'pending', reason: period.reason };
    await applyPaypal(cid.userId, { tier: cid.tier, status: 'active', subId, periodEnd: period.end });
    return { result: 'granted', userId: cid.userId };
  }

  // Past due, cancelled or expired: only a subscription a member actually
  // holds can change anything. A stale one (replaced since) resolves to no one.
  const holder = await findBySub(subId);
  if (!holder) return { result: 'ignored', reason: 'no member holds this subscription' };
  await applyPaypal(holder, { status });
  return { result: 'updated', userId: holder };
}

// Take (if needed) and apply a Lifetime order.
// → { result: 'granted' | 'pending' | 'declined' | 'ignored' | 'refused', reason?, userId? }
async function settleOrder(orderId, opts) {
  opts = opts || {};
  let order = await pp.getOrder(orderId);
  if (!order) return { result: 'ignored', reason: 'unknown order' };
  const unit = order.purchase_units && order.purchase_units[0];
  const cid = plan.parseCustomId(unit && unit.custom_id);
  if (!cid || cid.tier !== 'lifetime') return { result: 'ignored', reason: 'not a NoBossly lifetime order' };
  if (opts.expectUser && cid.userId !== opts.expectUser) return { result: 'refused', reason: 'belongs to another member' };
  const tier = await tierRow('lifetime');
  if (!tier || tier.mode !== 'payment') return { result: 'refused', reason: 'no lifetime tier' };

  if (order.status === 'APPROVED') {
    // Approved, not yet charged. Charge only what we are offering right now.
    const offer = pricing.offerFor(tier);
    const bad = plan.orderProblem(order, { customId: unit.custom_id, amountCents: offer.cents, currency: CURRENCY });
    if (bad) {
      console.error(`[paypal] order ${orderId} not captured (${bad}); offer is ${offer.cents}`);
      return { result: 'refused', reason: 'price-changed' };
    }
    const cap = await pp.captureOrder(orderId);
    if (cap.declined) return { result: 'declined' };
    order = cap.order || order;
  }

  const capture = plan.firstCapture(order);
  if (!capture) return { result: 'pending', reason: 'order ' + (order.status || 'unknown') };
  return settleCapture(capture, cid.userId, tier);
}

// Apply one capture of a Lifetime payment.
async function settleCapture(capture, userId, tier) {
  if (capture.status !== 'COMPLETED') return { result: 'pending', reason: 'capture ' + (capture.status || 'unknown') };
  const floor = plan.lifetimeFloorCents(tier);
  const paid = plan.centsFromPayPal(capture.amount);
  const cur = ((capture.amount && capture.amount.currency_code) || '').toLowerCase();
  if (paid === null || paid < floor || cur !== CURRENCY) {
    console.error(`[paypal] capture ${capture.id} pays ${paid}${cur} but lifetime costs ${floor} — not applied`);
    return { result: 'refused', reason: 'payment is less than the lifetime price' };
  }
  await applyPaypal(userId, { tier: 'lifetime', status: 'active', lifetime: true, captureId: capture.id });
  await endOtherBilling(userId);
  return { result: 'granted', userId };
}

// Capture id from a webhook → apply it if it is ours.
async function settleCaptureById(captureId) {
  const capture = await pp.getCapture(captureId);
  if (!capture) return { result: 'ignored', reason: 'unknown capture' };
  const cid = plan.parseCustomId(capture.custom_id);
  if (!cid || cid.tier !== 'lifetime') return { result: 'ignored', reason: 'not a NoBossly lifetime payment' };
  const tier = await tierRow('lifetime');
  if (!tier) return { result: 'refused', reason: 'no lifetime tier' };
  return settleCapture(capture, cid.userId, tier);
}

// A lifetime member must not keep being billed. Called after a Lifetime grant
// (PayPal here, and Stripe in billing.js): ends a PayPal subscription and any
// Stripe one. Failures are logged, never thrown — the grant already happened.
async function endPaypalFor(userId) {
  try {
    const sb = svc();
    if (!sb || !pp.isEnabled()) return;
    const { data } = await sb.from('profiles').select('paypal_subscription_id').eq('id', userId).maybeSingle();
    if (data && data.paypal_subscription_id) await pp.cancelSubscription(data.paypal_subscription_id, 'Upgraded to Lifetime');
  } catch (e) { console.error('[paypal] could not end subscription after lifetime purchase:', e.message); }
}
async function endOtherBilling(userId) {
  await endPaypalFor(userId);
  try {
    const sb = svc();
    const { data } = sb ? await sb.from('profiles').select('stripe_customer_id').eq('id', userId).maybeSingle() : { data: null };
    if (data && data.stripe_customer_id && process.env.STRIPE_SECRET_KEY) await require('./billing').endSubscriptionsFor(data.stripe_customer_id);
  } catch (e) { console.error('[paypal] could not end Stripe subscription after lifetime purchase:', e.message); }
}

// Member-initiated cancel of their PayPal subscription. Billing stops now; they
// keep Premium until the period they paid for ends. → true when PayPal stopped it.
async function cancelFor(profile) {
  if (!profile || !profile.paypal_subscription_id) return false;
  if (!pp.isEnabled()) return false;
  const stopped = await pp.cancelSubscription(profile.paypal_subscription_id, 'Cancelled by the member in NoBossly');
  if (!stopped) return false;
  await applyPaypal(profile.id, { status: 'canceled' });
  return true;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const back = (res, m) => res.redirect('/pricing?msg=' + encodeURIComponent(m));

// Start a PayPal checkout for a tier.
router.post('/billing/paypal/checkout/:key', requireAuth, async (req, res, next) => {
  try {
    const key = req.params.key;
    // Already Premium: only the step up to Lifetime is on offer.
    if (req.profile.is_lifetime || (premium.hasPremium(req.profile) && key !== 'lifetime')) return res.redirect('/tools');
    if (!ready()) return back(res, 'PayPal is being set up — please pay by card for now, or try again shortly.');

    const { data: tier } = await anonClient().from('pricing_tiers').select('*').eq('key', key).eq('is_active', true).maybeSingle();
    if (!tier) return res.redirect('/pricing');
    const offer = pricing.offerFor(tier);
    const customId = plan.customId(req.user.id, tier.key);
    const returnUrl = SITE() + '/billing/paypal/return';
    const cancelUrl = SITE() + '/pricing';

    if (tier.mode === 'payment') {
      const created = await pp.createOrder({
        customId, amountCents: offer.cents, currency: CURRENCY,
        description: 'NoBossly ' + (tier.name || 'Premium Lifetime'), returnUrl, cancelUrl,
        // One PayPal order per member, tier and price per ten minutes, so a double click can't make two.
        requestId: `nobossly-${req.user.id}-${tier.key}-${offer.cents}-${Math.floor(Date.now() / 600000)}`
      });
      if (!created) return back(res, 'Could not start PayPal checkout — please try again or pay by card.');
      return res.redirect(303, created.approveUrl);
    }

    if (!tier.paypal_plan_id) return back(res, 'PayPal is not available for this plan yet — please pay by card.');
    const planObj = await pp.getPlan(tier.paypal_plan_id);
    const interval = tier.key === 'year' ? 'year' : 'month';
    // The PayPal plan has one fixed price. If what we are advertising today
    // (a markdown, say) is not that price, PayPal must not charge a different one.
    const bad = plan.planMismatch(planObj, { amountCents: offer.cents, currency: CURRENCY, interval });
    if (bad) {
      console.error(`[paypal] checkout refused for ${tier.key}: ${bad}`);
      return back(res, offer.isPromo
        ? 'PayPal is not available during this sale — pay by card to get the sale price.'
        : 'PayPal is not available for this plan right now — please pay by card.');
    }
    const created = await pp.createSubscription({ planId: tier.paypal_plan_id, customId, returnUrl, cancelUrl });
    if (!created) return back(res, 'Could not start PayPal checkout — please try again or pay by card.');
    return res.redirect(303, created.approveUrl);
  } catch (e) {
    console.error('[paypal] checkout', e.message);
    back(res, 'Could not start PayPal checkout — please try again or pay by card.');
  }
});

// The member comes back from PayPal. A subscription return carries
// subscription_id; a Lifetime order return carries token (the order id).
router.get('/billing/paypal/return', requireAuth, async (req, res) => {
  try {
    if (!ready()) return res.redirect('/account');
    const subId = typeof req.query.subscription_id === 'string' ? req.query.subscription_id : '';
    const orderId = typeof req.query.token === 'string' ? req.query.token : '';
    let r;
    if (subId) r = await syncSubscription(subId, { expectUser: req.user.id });
    else if (orderId) r = await settleOrder(orderId, { expectUser: req.user.id });
    else return res.redirect('/pricing');

    if (r.result === 'granted') return res.redirect('/tools?welcome=1');
    if (r.result === 'pending') return res.redirect('/account?sub=pending');
    if (r.result === 'declined') return back(res, 'PayPal could not take that payment. Nothing was charged — try another funding source or pay by card.');
    if (r.reason === 'price-changed') return back(res, 'The price changed while you were checking out, so nothing was charged. Please start again.');
    console.error('[paypal] return not applied:', r.result, r.reason || '');
    return back(res, 'We could not confirm that PayPal payment. If you were charged, contact support and we will sort it out straight away.');
  } catch (e) {
    console.error('[paypal] return', e.message);
    // Transient (PayPal or database): the webhook will finish the job.
    res.redirect('/account?sub=pending');
  }
});

// ─── Webhook ────────────────────────────────────────────────────────────────

// A sale refunded or reversed ends the membership it paid for — but only when
// it is the member's latest payment; refunding an old month changes nothing.
async function saleReversed(saleId, force) {
  if (!saleId) return;
  const sale = await pp.getSale(saleId);
  if (!sale || !sale.billing_agreement_id) return;
  if (!force && sale.state !== 'refunded') return;
  const subId = sale.billing_agreement_id;
  const holder = await findBySub(subId);
  if (!holder) return;
  const sub = await pp.getSubscription(subId);
  const last = sub && sub.billing_info && sub.billing_info.last_payment && sub.billing_info.last_payment.time;
  const made = sale.create_time;
  if (!last || !made || Math.abs(new Date(last).getTime() - new Date(made).getTime()) > 3600000) {
    console.error(`[paypal] sale ${saleId} was refunded but is not clearly the latest payment of ${subId} — membership left alone, check it by hand`);
    return;
  }
  await pp.cancelSubscription(subId, 'Payment refunded');
  await applyPaypal(holder, { status: 'expired', periodEnd: new Date().toISOString() });
}

async function captureReversed(captureId, force) {
  if (!captureId) return;
  const cap = await pp.getCapture(captureId);
  if (!cap) return;
  if (!force && cap.status !== 'REFUNDED') return; // a partial refund leaves Lifetime alone
  await rpc('revoke_paypal_lifetime', { p_capture_id: captureId });
}

async function webhook(req, res) {
  if (!pp.isEnabled()) return res.status(200).send('ignored');
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  try {
    // Verified with PayPal before anything is read. Fails closed.
    if (!(await pp.verifyWebhook(n => req.get(n), raw))) return res.status(400).send('bad signature');
    const event = JSON.parse(raw);
    const type = String(event.event_type || '');
    const r = event.resource || {};

    if (type.startsWith('BILLING.SUBSCRIPTION.')) {
      if (r.id) await syncSubscription(r.id);
    } else if (type === 'PAYMENT.SALE.COMPLETED') {
      if (r.billing_agreement_id) await syncSubscription(r.billing_agreement_id);
    } else if (type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED') {
      const reversed = type.endsWith('REVERSED');
      await saleReversed(reversed ? (r.sale_id || r.id) : r.sale_id, reversed);
    } else if (type === 'CHECKOUT.ORDER.APPROVED') {
      if (r.id) await settleOrder(r.id);
    } else if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      if (r.id) await settleCaptureById(r.id);
    } else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
      await captureReversed(plan.captureIdFromLinks(r.links), type.endsWith('REVERSED'));
    }
    res.status(200).send('ok');
  } catch (e) {
    // A 5xx makes PayPal retry (for up to three days), so a brief PayPal or
    // Supabase outage doesn't leave a paying member locked out.
    console.error('paypal webhook', e.message);
    res.status(500).send('error');
  }
}

module.exports = {
  router, webhook, ready, cancelFor, endPaypalFor,
  // exported for tests
  syncSubscription, settleOrder, settleCaptureById
};
