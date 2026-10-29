const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const premium = require('../premium');
const { anonClient, serviceClient } = require('../supabase');
const pricing = require('../pricing');
const paypal = require('../paypal');

const crypto = require('crypto');

const STRIPE_KEY = () => process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = () => process.env.STRIPE_WEBHOOK_SECRET || '';
// Every NoBossly checkout is tagged with this, and the webhook ignores sessions
// that are not — so anything else sold on the same Stripe account (a payment
// link, another app) can never unlock Premium by accident.
const APP_TAG = 'nobossly';
const SUB_SECRET = () => process.env.SUB_SYNC_SECRET || '';
const SITE = () => (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');

async function stripe(method, path, params) {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + STRIPE_KEY(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ? j.error.message : 'Stripe error');
  return j;
}

// apply_subscription grants paid access, and it is currently EXECUTE-able by the
// `anon` role — meaning anyone holding the (public) anon key can call it, with
// only the shared secret in the way. Prefer the service role so the grant runs
// on a trusted connection; the anon client stays as a fallback so billing keeps
// working on deployments where SUPABASE_SERVICE_ROLE_KEY isn't set yet.
// Once the key is confirmed in production, run the revoke in
// migrations/2026-08-31_lock_down_security_definer.sql to close the hole.
function subClient() {
  try { return serviceClient(); }
  catch (_) {
    console.warn('SUPABASE_SERVICE_ROLE_KEY unset — applying subscription over the anon client');
    return anonClient();
  }
}

// Newer Stripe API versions moved the period end from the subscription onto
// its items, and an invoice's subscription under `parent`; read both shapes so
// a dashboard API-version bump never breaks access.
function periodEnd(sub) {
  if (!sub) return null;
  const t = sub.current_period_end
    || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  return t ? new Date(t * 1000).toISOString() : null;
}
function invoiceSubId(inv) {
  if (!inv) return null;
  if (inv.subscription) return typeof inv.subscription === 'string' ? inv.subscription : inv.subscription.id;
  const d = inv.parent && inv.parent.subscription_details;
  return d && d.subscription ? (typeof d.subscription === 'string' ? d.subscription : d.subscription.id) : null;
}

// A subscriber who buys Lifetime must not keep being billed monthly. Called
// after a lifetime payment from both the return page and the webhook; setting
// cancel_at_period_end twice is harmless.
async function endSubscriptionsFor(customer) {
  if (!customer) return;
  try {
    const list = await stripe('GET', 'subscriptions?status=active&limit=10&customer=' + encodeURIComponent(customer));
    for (const sub of list.data || []) {
      if (!sub.cancel_at_period_end) await stripe('POST', 'subscriptions/' + encodeURIComponent(sub.id), { cancel_at_period_end: 'true' });
    }
  } catch (e) { console.error('[billing] could not end subscriptions after lifetime purchase:', e.message); }
}

async function applySub(userId, { tier, status, customer, subId, periodEnd, lifetime }) {
  const sb = subClient();
  const { error } = await sb.rpc('apply_subscription', {
    p_secret: SUB_SECRET(), p_user: userId,
    p_tier: tier || null, p_status: status || null,
    p_customer: customer || null, p_sub_id: subId || null,
    p_period_end: periodEnd || null, p_lifetime: !!lifetime
  });
  if (error) throw new Error('apply_subscription: ' + error.message);
}

// ── PayPal ──────────────────────────────────────────────────────────────────
// A PayPal subscription id (I-...) lives in profiles.stripe_subscription_id next
// to Stripe's (sub_...): apply_subscription and find_user_by_stripe_sub take any
// text id and the two kinds cannot collide, so no schema change was needed.
// Whoever pays with one processor is kept on it: the other one's buttons are
// hidden and refused, so nobody is billed twice for the same Premium.
const isPaypalSubId = id => typeof id === 'string' && id.startsWith('I-');
function processorOf(profile) {
  const id = profile && profile.stripe_subscription_id;
  if (!id) return null;
  return isPaypalSubId(id) ? 'paypal' : 'stripe';
}
// PayPal's custom_id comes back on every subscription, order and capture, which
// is how a payment is tied to a member and how anything that isn't NoBossly's
// (another app on the same PayPal account) is told apart and ignored.
const CUSTOM_PREFIX = 'nobossly:';
const customIdFor = userId => CUSTOM_PREFIX + userId;
function parseCustom(customId) {
  const m = /^nobossly:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(customId || ''));
  return m ? m[1].toLowerCase() : null;
}

// May this member start a purchase with this processor? Lifetime members buy
// nothing. Premium members can only step up to Lifetime, and only with the
// processor that already bills them.
function purchaseBlock(profile, key, processor) {
  if (profile.is_lifetime) return 'You already have lifetime access.';
  const premiumNow = premium.hasPremium(profile);
  if (premiumNow && key !== 'lifetime') return 'You already have Premium.';
  const current = processorOf(profile);
  if (premiumNow && current && current !== processor) {
    return 'Your Premium is billed through ' + (current === 'paypal' ? 'PayPal' : 'Stripe') +
      ', so switch to Lifetime with ' + (current === 'paypal' ? 'PayPal' : 'Stripe') + '.';
  }
  return null;
}

// Members who already have what the button sells go to their tools; a member
// on the other processor is told why that button is refused.
function blockedRedirect(profile, key, message) {
  const hasIt = profile.is_lifetime || (premium.hasPremium(profile) && key !== 'lifetime');
  return hasIt ? '/tools' : '/pricing?msg=' + encodeURIComponent(message);
}

// Is this tier's PayPal plan really what the page advertises? Reads the plan
// from PayPal and compares price, currency, interval and status with the tier.
// Returns null when it is safe to sell, otherwise a reason (already logged).
async function planProblem(tier, offer) {
  if (!tier.paypal_plan_id || offer.isPromo) return 'unavailable';
  const terms = paypal.planTerms(await paypal.getPlan(tier.paypal_plan_id));
  const want = tier.key === 'year' ? 'YEAR' : 'MONTH';
  if (!terms || terms.status !== 'ACTIVE' || terms.cents !== offer.cents || terms.currency !== 'USD' ||
      terms.unit !== want || terms.count !== 1 || terms.totalCycles) {
    console.error('[paypal] plan ' + tier.paypal_plan_id + ' does not match tier ' + tier.key +
      ' (' + JSON.stringify(terms) + ' vs ' + offer.cents + ' cents per ' + want + ') — not selling it');
    return 'mismatch';
  }
  return null;
}

async function profileIdForSub(subId) {
  const { data, error } = await subClient().rpc('find_user_by_stripe_sub', { p_secret: SUB_SECRET(), p_sub_id: subId });
  if (error) throw new Error('find_user_by_stripe_sub: ' + error.message);
  return data || null;
}

async function tierForPlan(planId) {
  if (!planId) return null;
  const { data } = await anonClient().from('pricing_tiers').select('*').eq('paypal_plan_id', planId).eq('mode', 'subscription').maybeSingle();
  return data || null;
}

// When the paid period ends: PayPal's next billing time while it is active,
// otherwise the last payment plus one interval.
function paypalPeriodEnd(sub, tierKey) {
  const bi = (sub && sub.billing_info) || {};
  if (bi.next_billing_time) return new Date(bi.next_billing_time).toISOString();
  const last = bi.last_payment && bi.last_payment.time;
  if (!last) return null;
  const d = new Date(last);
  if (tierKey === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

// Bring a PayPal subscription and the member's Premium into line, from the
// return page or a webhook. Everything is re-read from PayPal; nothing in the
// request or the webhook body is trusted. Safe to run any number of times.
async function settleSubscription(subId, { expectUser } = {}) {
  const sub = await paypal.getSubscription(subId);
  if (!sub) return { state: 'ignored' };
  const owner = parseCustom(sub.custom_id);
  if (!owner) return { state: 'ignored' };                       // not NoBossly's
  if (expectUser && owner !== expectUser) return { state: 'refused' };
  const tier = await tierForPlan(sub.plan_id);
  if (!tier) {
    console.error('[paypal] subscription ' + subId + ' is on plan ' + sub.plan_id + ', which no pricing tier uses');
    return { state: 'ignored' };
  }
  switch (sub.status) {
    case 'ACTIVE':
      await applySub(owner, { tier: tier.key, status: 'active', subId, periodEnd: paypalPeriodEnd(sub, tier.key) });
      return { state: 'activated' };
    case 'APPROVAL_PENDING': case 'APPROVED':
      return { state: 'pending' };
    default: {
      // Stopped by the member, by PayPal after failed payments, or at its end.
      // Only a subscription already attached to a member can change anything.
      const known = await profileIdForSub(subId);
      if (!known) return { state: 'ignored' };
      if (sub.status === 'CANCELLED') await applySub(known, { status: 'canceled' });      // keeps access to the paid period's end
      else if (sub.status === 'SUSPENDED') await applySub(known, { status: 'past_due' });
      else if (sub.status === 'EXPIRED') await applySub(known, { status: 'expired' });
      return { state: 'ended' };
    }
  }
}

// Finish a one-time PayPal order for Lifetime: check it is ours and the right
// amount BEFORE taking the money, capture it, then unlock. Safe to repeat.
async function settleOrder(orderId, { expectUser, profile } = {}) {
  const order = await paypal.getOrder(orderId);
  if (!order) return { state: 'refused' };
  const unit = (order.purchase_units || [])[0] || {};
  const owner = parseCustom(unit.custom_id);
  if (!owner) return { state: 'ignored' };
  if (expectUser && owner !== expectUser) return { state: 'refused' };
  const { data: tier } = await anonClient().from('pricing_tiers').select('*').eq('key', 'lifetime').eq('mode', 'payment').maybeSingle();
  if (!tier) return { state: 'refused' };
  const paid = unit.amount ? paypal.toCents(unit.amount.value) : NaN;
  if (!unit.amount || unit.amount.currency_code !== 'USD' || (paid !== pricing.offerFor(tier).cents && paid !== tier.price_cents)) {
    console.error('[paypal] order ' + orderId + ' is for ' + (unit.amount && unit.amount.value) + ' — not the Lifetime price; not capturing');
    return { state: 'refused' };
  }
  let done = order;
  if (order.status === 'APPROVED') {
    const r = await paypal.captureOrder(orderId);
    if (r.declined) return { state: 'declined' };
    done = r.order;
  }
  const cap = done && done.status === 'COMPLETED' && ((done.purchase_units || [])[0] || {}).payments;
  const capture = cap && (cap.captures || [])[0];
  if (!capture || capture.status !== 'COMPLETED') return { state: 'pending' };
  await applySub(owner, { tier: 'lifetime', status: 'active', lifetime: true });
  // Whoever had a subscription must not keep being billed after buying Lifetime.
  if (profile) await endBilling(profile);
  return { state: 'activated' };
}

// Stop recurring billing on whichever processor holds it. Used after Lifetime.
async function endBilling(profile) {
  if (isPaypalSubId(profile.stripe_subscription_id) && paypal.isEnabled()) {
    try { await paypal.cancelSubscription(profile.stripe_subscription_id, 'Upgraded to Lifetime'); }
    catch (e) { console.error('[billing] could not cancel PayPal subscription after lifetime purchase:', e.message); }
  } else if (profile.stripe_customer_id && STRIPE_KEY()) {
    await endSubscriptionsFor(profile.stripe_customer_id);
  }
}

// Premium is five tools on top of a site that is free. The free list is
// deliberately the long one: the ladder, the quests and the community are the
// product, and nothing a member needs to climb is ever behind the wall.
const FREE_FEATURES = [
  'All nine paths and the full ten-rung ladder',
  'Every quest, trophy, sprint and daily check-in',
  'Peer review, the Wins wall, groups and collaborations',
  'The community forum and 100+ practical guides'
];
const PAID_FEATURES = premium.TOOLS.map(t => t.emoji + ' ' + t.name + ' — ' + t.blurb);

// Public pricing page
router.get('/pricing', async (req, res, next) => {
  try {
    const sb = req.sb || anonClient();
    const { data: tiers } = await sb.from('pricing_tiers').select('*').eq('is_active', true).order('sort');
    const withOffers = pricing.withOffer(tiers);
    // A PayPal button is shown only where PayPal can really charge what the page
    // says: Lifetime is a one-off order; a subscription needs its PayPal plan,
    // and a running markdown means the plan's fixed price would be the wrong one.
    const paypalAvail = {};
    for (const t of withOffers) {
      paypalAvail[t.key] = paypal.isEnabled() &&
        (t.mode === 'payment' || (!!t.paypal_plan_id && !(t.offer && t.offer.isPromo)));
    }
    res.render('pricing', {
      title: 'Premium',
      metaDescription: 'NoBossly is free. Premium adds five tools for getting out of your job — a quit-date planner, tax set-aside, pricing calculator, proof page and interview tracker — for $5 a month.',
      // Each tier carries what it costs TODAY and what it normally costs. Both
      // the page and the checkout below read that from src/pricing.js, because
      // a page advertising one number while checkout charges another is the
      // one bug this area must not have.
      tiers: withOffers,
      paypalAvail,
      // Who already bills this member (null when nobody): their Lifetime
      // step-up is offered only on that processor.
      payer: req.profile && premium.hasPremium(req.profile) ? processorOf(req.profile) : null,
      // An active Monthly member may switch to Annual on the processor that bills them.
      currentTier: req.profile && premium.hasPremium(req.profile) && !req.profile.is_lifetime ? req.profile.subscription_tier : null,
      canSwitch: !!(req.profile && !req.profile.is_lifetime && premium.hasPremium(req.profile) &&
        req.profile.subscription_tier === 'month' && req.profile.subscription_status === 'active' &&
        req.profile.stripe_subscription_id &&
        (isPaypalSubId(req.profile.stripe_subscription_id) ? paypalAvail.year : true)),
      freeFeatures: FREE_FEATURES, paidFeatures: PAID_FEATURES,
      isPremium: premium.hasPremium(req.profile),
      upgrade: req.query.upgrade, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// Map a tier key to a Stripe recurring interval, used for inline (Price-ID-free) subscriptions.
function recurringFor(key) {
  if (key === 'year') return { interval: 'year', interval_count: 1 };
  return { interval: 'month', interval_count: 1 }; // monthly default
}

// Start checkout — EnRoute-style resilience: the ONLY thing that can block checkout is a
// missing Stripe secret key. Pricing is read with the reliable anon client, and the line
// item is built INLINE from the amount stored in pricing_tiers, so a missing or wrong
// Stripe Price ID can never stop a sale (a valid stripe_price_id is still used if present).
router.post('/billing/checkout/:key', requireAuth, async (req, res, next) => {
  try {
    // Already Premium: only the step up to Lifetime is on offer, and only on
    // the processor that already bills the member.
    const blocked = purchaseBlock(req.profile, req.params.key, 'stripe');
    if (blocked) return res.redirect(blockedRedirect(req.profile, req.params.key, blocked));
    if (!STRIPE_KEY()) {
      return res.redirect('/pricing?msg=' + encodeURIComponent('Payments are being set up — please try again shortly.'));
    }
    const sb = anonClient();
    const { data: tier } = await sb.from('pricing_tiers').select('*').eq('key', req.params.key).eq('is_active', true).maybeSingle();
    if (!tier) return res.redirect('/pricing');

    const isPayment = tier.mode === 'payment';
    const params = {
      mode: isPayment ? 'payment' : 'subscription',
      'line_items[0][quantity]': '1',
      success_url: SITE() + '/billing/confirm?session_id={CHECKOUT_SESSION_ID}',
      allow_promotion_codes: 'true',
      cancel_url: SITE() + '/pricing',
      client_reference_id: req.user.id,
      'metadata[app]': APP_TAG,
      'metadata[tier]': tier.key,
      'metadata[user_id]': req.user.id
    };
    if (!isPayment) {
      params['subscription_data[metadata][app]'] = APP_TAG;
      params['subscription_data[metadata][user_id]'] = req.user.id;
    }

    // What this tier costs today — the markdown when one is running, the list
    // price otherwise. Never tier.price_cents directly: during a promotion that
    // is the crossed-out number.
    const offer = pricing.offerFor(tier);
    if (offer.isPromo) params['metadata[promo]'] = offer.label || 'markdown';

    // Build the line item inline from the amount in pricing_tiers. This is what
    // lets a markdown go live before its Stripe Price exists, and what catches a
    // Price ID that belongs to a Stripe account we are no longer charging on.
    const useInlineLineItem = () => {
      delete params['line_items[0][price]'];
      params['line_items[0][price_data][currency]'] = 'usd';
      params['line_items[0][price_data][product_data][name]'] = 'NoBossly ' + (tier.name || 'Premium');
      params['line_items[0][price_data][unit_amount]'] = String(offer.cents);
      if (!isPayment) {
        const r = recurringFor(tier.key);
        params['line_items[0][price_data][recurring][interval]'] = r.interval;
        params['line_items[0][price_data][recurring][interval_count]'] = String(r.interval_count);
      }
    };

    // Use the configured catalog Price when present, inline otherwise.
    if (offer.stripePriceId) { params['line_items[0][price]'] = offer.stripePriceId; }
    else { useInlineLineItem(); }

    if (req.profile.stripe_customer_id) { params.customer = req.profile.stripe_customer_id; }
    else {
      params.customer_email = req.user.email;
      // Payment-mode sessions only create a Stripe customer when asked, and a
      // lifetime member needs one for receipts and the billing portal.
      if (isPayment) params.customer_creation = 'always';
    }

    let session;
    try {
      session = await stripe('POST', 'checkout/sessions', params);
    } catch (err) {
      // A Price ID that Stripe rejects — wrong account, archived, deleted — must
      // never cost a sale. Fall back to the inline amount and charge the same
      // money anyway; the rejected ID is logged loudly so it gets fixed.
      if (!offer.stripePriceId) {
        return res.redirect('/pricing?msg=' + encodeURIComponent('Could not start checkout: ' + err.message));
      }
      console.error('[billing] Stripe rejected price ' + offer.stripePriceId + ' for tier ' +
        tier.key + ' (' + (offer.isPromo ? 'promo' : 'list') + ') — retrying inline: ' + err.message);
      useInlineLineItem();
      try {
        session = await stripe('POST', 'checkout/sessions', params);
      } catch (err2) {
        return res.redirect('/pricing?msg=' + encodeURIComponent('Could not start checkout: ' + err2.message));
      }
    }
    return res.redirect(303, session.url);
  } catch (e) { next(e); }
});

// Return from Stripe checkout — verify with Stripe before granting
router.get('/billing/confirm', requireAuth, async (req, res, next) => {
  try {
    const sid = req.query.session_id;
    if (!sid || !STRIPE_KEY()) return res.redirect('/account');
    const session = await stripe('GET', 'checkout/sessions/' + encodeURIComponent(sid) + '?expand[]=subscription');
    if (session.client_reference_id !== req.user.id) return res.redirect('/account');
    if (session.payment_status === 'paid') {
      const tier = (session.metadata && session.metadata.tier) || 'month';
      if (session.mode === 'payment') {
        await applySub(req.user.id, { tier: 'lifetime', status: 'active', customer: session.customer, lifetime: true });
        await endSubscriptionsFor(session.customer);
      } else {
        const sub = session.subscription;
        await applySub(req.user.id, {
          tier, status: 'active', customer: session.customer,
          subId: sub && sub.id,
          periodEnd: periodEnd(sub)
        });
      }
      return res.redirect('/tools?welcome=1');
    }
    res.redirect('/account?sub=pending');
  } catch (e) { next(e); }
});

// Start a PayPal checkout: a subscription for Monthly / Annual, a one-time order
// for Lifetime. The amount and plan always come from pricing_tiers, never from
// the request, and a plan whose real price or interval differs from the tier is
// refused rather than sold under the wrong number.
router.post('/billing/paypal/checkout/:key', requireAuth, async (req, res, next) => {
  try {
    const key = req.params.key;
    const blocked = purchaseBlock(req.profile, key, 'paypal');
    if (blocked) return res.redirect(blockedRedirect(req.profile, key, blocked));
    const unavailable = msg => res.redirect('/pricing?msg=' + encodeURIComponent(msg));
    if (!paypal.isEnabled()) return unavailable('PayPal is not available right now — please pay by card instead.');

    const { data: tier } = await anonClient().from('pricing_tiers').select('*').eq('key', key).eq('is_active', true).maybeSingle();
    if (!tier) return res.redirect('/pricing');
    const offer = pricing.offerFor(tier);
    const approval = (tier.mode === 'payment')
      ? await paypal.createOrder({
          amountCents: offer.cents,
          customId: customIdFor(req.user.id),
          description: 'NoBossly ' + (tier.name || 'Premium Lifetime'),
          returnUrl: SITE() + '/billing/paypal/return',
          cancelUrl: SITE() + '/pricing'
        })
      : await (async () => {
          if (await planProblem(tier, offer)) return null;
          return paypal.createSubscription({
            planId: tier.paypal_plan_id,
            customId: customIdFor(req.user.id),
            returnUrl: SITE() + '/billing/paypal/return',
            cancelUrl: SITE() + '/pricing'
          });
        })();
    if (!approval) return unavailable('Could not start PayPal checkout — please try again, or pay by card.');
    return res.redirect(303, approval.approveUrl);
  } catch (e) {
    if (e instanceof paypal.Transient) {
      console.error('[paypal] checkout:', e.message);
      return res.redirect('/pricing?msg=' + encodeURIComponent('PayPal is not responding — please try again, or pay by card.'));
    }
    next(e);
  }
});

// Return from PayPal's approval page. PayPal appends subscription_id for a
// subscription and token (the order id) for an order; both are re-read from
// PayPal and checked against this member before anything is granted.
router.get('/billing/paypal/return', requireAuth, async (req, res, next) => {
  try {
    if (!paypal.isEnabled()) return res.redirect('/account');
    let r;
    if (req.query.subscription_id) r = await settleSubscription(String(req.query.subscription_id), { expectUser: req.user.id });
    else if (req.query.token) r = await settleOrder(String(req.query.token), { expectUser: req.user.id, profile: req.profile });
    else return res.redirect('/account');
    if (r.state === 'activated') return res.redirect('/tools?welcome=1');
    if (r.state === 'pending') return res.redirect('/account?sub=pending');
    if (r.state === 'declined') return res.redirect('/pricing?msg=' + encodeURIComponent('PayPal declined that payment — try another way to pay.'));
    return res.redirect('/pricing?msg=' + encodeURIComponent('We could not confirm that PayPal payment. If you were charged, write to us and we will sort it out.'));
  } catch (e) {
    if (e instanceof paypal.Transient) {
      // PayPal is slow, not wrong: the webhook finishes the job when it answers.
      console.error('[paypal] return:', e.message);
      return res.redirect('/account?sub=pending');
    }
    next(e);
  }
});

// Move an active Monthly member to Annual, on the processor that already bills
// them. Stripe: the unused part of the month is credited and the annual price
// is charged now, so the year starts today; if the charge fails nothing changes
// (error_if_incomplete). PayPal: the member approves the new plan on PayPal,
// which decides when it takes effect. Returns where to send the member.
async function changePlan(profile, userId, key) {
  const back = msg => ({ to: '/pricing?msg=' + encodeURIComponent(msg) });
  if (key !== 'year') return { to: '/pricing' };
  if (profile.is_lifetime) return { to: '/tools' };
  const subId = profile.stripe_subscription_id;
  if (profile.subscription_tier !== 'month' || profile.subscription_status !== 'active' || !subId) {
    return back('Only an active Monthly plan can be switched to Annual.');
  }
  const { data: tier } = await anonClient().from('pricing_tiers').select('*').eq('key', 'year').eq('is_active', true).maybeSingle();
  if (!tier) return { to: '/pricing' };
  const offer = pricing.offerFor(tier);

  if (isPaypalSubId(subId)) {
    if (!paypal.isEnabled() || await planProblem(tier, offer)) return back('Switching plans with PayPal is not available right now — please try again later.');
    const rev = await paypal.reviseSubscription({
      id: subId, planId: tier.paypal_plan_id,
      returnUrl: SITE() + '/billing/paypal/switched', cancelUrl: SITE() + '/pricing'
    });
    if (!rev) return back('Could not start the plan change with PayPal — please try again.');
    return { to: rev.approveUrl || '/billing/paypal/switched', status: 303 };
  }

  if (!STRIPE_KEY()) return back('Payments are being set up — please try again shortly.');
  const sub = await stripe('GET', 'subscriptions/' + encodeURIComponent(subId));
  if (sub.status !== 'active' || sub.cancel_at_period_end) {
    return back('Your subscription is not active, so it cannot be switched. Let it end, then choose Annual.');
  }
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item) return back('Could not read your subscription — please try again.');
  if (item.price && item.price.recurring && item.price.recurring.interval === 'year') {
    await applySub(userId, { tier: 'year', status: 'active', subId: sub.id, periodEnd: periodEnd(sub) });
    return { to: '/account' };
  }
  const params = {
    'items[0][id]': item.id,
    proration_behavior: 'always_invoice',     // credit the unused month, charge the year, now
    billing_cycle_anchor: 'now',
    payment_behavior: 'error_if_incomplete'   // a declined card changes nothing
  };
  const useInline = () => {
    delete params['items[0][price]'];
    params['items[0][price_data][currency]'] = 'usd';
    params['items[0][price_data][product]'] = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
    params['items[0][price_data][unit_amount]'] = String(offer.cents);
    params['items[0][price_data][recurring][interval]'] = 'year';
  };
  if (offer.stripePriceId) params['items[0][price]'] = offer.stripePriceId; else useInline();
  let updated;
  try {
    updated = await stripe('POST', 'subscriptions/' + encodeURIComponent(subId), params);
  } catch (err) {
    if (!offer.stripePriceId) return back('Could not switch your plan: ' + err.message);
    console.error('[billing] Stripe rejected price ' + offer.stripePriceId + ' for the switch to Annual — retrying inline: ' + err.message);
    useInline();
    try { updated = await stripe('POST', 'subscriptions/' + encodeURIComponent(subId), params); }
    catch (err2) { return back('Could not switch your plan: ' + err2.message); }
  }
  await applySub(userId, { tier: 'year', status: 'active', subId: updated.id, periodEnd: periodEnd(updated) });
  return { to: '/account?sub=switched' };
}

router.post('/billing/change/:key', requireAuth, async (req, res, next) => {
  try {
    const r = await changePlan(req.profile, req.user.id, req.params.key);
    return res.redirect(r.status || 302, r.to);
  } catch (e) {
    if (e instanceof paypal.Transient) {
      console.error('[paypal] plan change:', e.message);
      return res.redirect('/pricing?msg=' + encodeURIComponent('PayPal is not responding — please try again.'));
    }
    next(e);
  }
});

// Back from PayPal's approval page after a plan change. Re-reads the member's own
// subscription (never an id from the request); the tier follows whichever plan
// PayPal reports, so it flips to Annual only once PayPal says it has.
router.get('/billing/paypal/switched', requireAuth, async (req, res, next) => {
  try {
    const id = req.profile.stripe_subscription_id;
    if (!paypal.isEnabled() || !isPaypalSubId(id)) return res.redirect('/account');
    await settleSubscription(id, { expectUser: req.user.id });
    return res.redirect('/account?sub=switchpending');
  } catch (e) {
    if (e instanceof paypal.Transient) return res.redirect('/account?sub=switchpending');
    next(e);
  }
});

// Cancel at period end
router.post('/billing/cancel', requireAuth, async (req, res, next) => {
  try {
    const subId = req.profile.stripe_subscription_id;
    if (isPaypalSubId(subId)) {
      // PayPal keeps the member's paid period; ours does too (status canceled).
      const stopped = paypal.isEnabled() && await paypal.cancelSubscription(subId, 'Cancelled by the member');
      if (!stopped) return res.redirect('/account?e=' + encodeURIComponent('Could not cancel with PayPal just now — please try again, or cancel it in your PayPal account under Automatic payments.'));
      await applySub(req.user.id, { status: 'canceled' });
    } else if (subId && STRIPE_KEY()) {
      const sub = await stripe('POST', 'subscriptions/' + encodeURIComponent(subId), { cancel_at_period_end: 'true' });
      await applySub(req.user.id, {
        status: 'canceled',
        periodEnd: periodEnd(sub)
      });
    } else {
      await applySub(req.user.id, { status: 'canceled' });
    }
    res.redirect('/account?sub=canceled');
  } catch (e) { next(e); }
});

// Stripe's hosted billing portal: update the card, see invoices, cancel. Needs
// the portal switched on once in the Stripe dashboard (Settings → Billing →
// Customer portal); until then this says so instead of failing silently.
router.post('/billing/portal', requireAuth, async (req, res) => {
  try {
    if (!STRIPE_KEY() || !req.profile.stripe_customer_id) return res.redirect('/account');
    const portal = await stripe('POST', 'billing_portal/sessions', {
      customer: req.profile.stripe_customer_id, return_url: SITE() + '/account'
    });
    return res.redirect(303, portal.url);
  } catch (e) {
    console.error('[billing] portal', e.message);
    res.redirect('/account?e=' + encodeURIComponent('Billing management is not available right now — you can still cancel below.'));
  }
});

// Stripe's signature header is "t=<unix>,v1=<hex>[,v1=<hex>...]", where each
// v1 is HMAC-SHA256(secret, "<t>.<raw body>"). Checked by hand so billing
// needs no Stripe SDK. Five minutes of clock skew, as Stripe's libraries allow.
function verifySignature(raw, header, secret, now) {
  if (!header || !secret) return false;
  let t = null; const sigs = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs((now || Date.now()) / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.').update(raw).digest();
  return sigs.some(s => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

// Stripe webhook (mounted with raw body in server.js). The signature is checked
// when STRIPE_WEBHOOK_SECRET is set, and we never trust the payload either way:
// the referenced object is re-fetched from Stripe before acting on it.
async function webhook(req, res) {
  if (!STRIPE_KEY()) return res.status(200).send('ignored');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  if (WEBHOOK_SECRET()) {
    if (!verifySignature(raw, req.get('stripe-signature'), WEBHOOK_SECRET())) {
      return res.status(400).send('bad signature');
    }
  }
  try {
    const event = JSON.parse(raw.toString('utf8'));
    const type = event.type || '';
    const obj = (event.data && event.data.object) || {};

    if (type === 'checkout.session.completed' && obj.id) {
      // Skip anything that isn't ours before spending an API call on it.
      if (!obj.metadata || obj.metadata.app !== APP_TAG) return res.status(200).send('not-nobossly');
      const session = await stripe('GET', 'checkout/sessions/' + encodeURIComponent(obj.id) + '?expand[]=subscription');
      const uid = session.client_reference_id;
      if (uid && session.payment_status === 'paid' && session.metadata && session.metadata.app === APP_TAG) {
        const tier = session.metadata.tier || 'month';
        if (session.mode === 'payment') {
          await applySub(uid, { tier: 'lifetime', status: 'active', customer: session.customer, lifetime: true });
          await endSubscriptionsFor(session.customer);
        } else {
          const sub = session.subscription;
          await applySub(uid, { tier, status: 'active', customer: session.customer, subId: sub && sub.id, periodEnd: periodEnd(sub) });
        }
      }
    } else if ((type === 'customer.subscription.updated' || type === 'customer.subscription.deleted' || type === 'invoice.paid') && obj.id) {
      const subId = type === 'invoice.paid' ? invoiceSubId(obj) : obj.id;
      if (subId) {
        // find_user_by_stripe_sub only knows NoBossly members' subscriptions,
        // so any other subscription resolves to no one and is left alone.
        const { data: uid, error } = await subClient().rpc('find_user_by_stripe_sub', { p_secret: SUB_SECRET(), p_sub_id: subId });
        if (error) throw new Error('find_user_by_stripe_sub: ' + error.message);
        if (uid) {
          const sub = await stripe('GET', 'subscriptions/' + encodeURIComponent(subId));
          const status = sub.status === 'active' && sub.cancel_at_period_end ? 'canceled'
            : (sub.status === 'active' || sub.status === 'trialing') ? 'active'
            : sub.status === 'canceled' ? 'expired' : sub.status;
          await applySub(uid, { status, periodEnd: periodEnd(sub) });
        }
      }
    }
    res.status(200).send('ok');
  } catch (e) {
    // A 5xx makes Stripe retry (for up to three days), so a brief Supabase or
    // Stripe outage doesn't leave a paying member locked out.
    console.error('stripe webhook', e.message);
    res.status(500).send('error');
  }
}

// PayPal webhook (mounted with the raw body in server.js). PayPal is asked
// whether each delivery is genuine, and the payload is then used only to learn
// WHICH subscription or order to re-read from PayPal. Transient failures answer
// 5xx so PayPal redelivers; anything permanently wrong answers 200 and is logged.
async function paypalWebhook(req, res) {
  if (!paypal.isEnabled()) return res.status(200).send('ignored');
  if (!paypal.hasWebhookId()) return res.status(503).send('PAYPAL_WEBHOOK_ID is not set');
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  try {
    if (!(await paypal.verifyWebhook(name => req.get(name), raw))) return res.status(400).send('bad signature');
    const event = JSON.parse(raw);
    const type = event.event_type || '';
    const r = event.resource || {};

    if (type.startsWith('BILLING.SUBSCRIPTION.') && type !== 'BILLING.SUBSCRIPTION.CREATED' && r.id) {
      await settleSubscription(String(r.id));
    } else if (type === 'PAYMENT.SALE.COMPLETED' && r.billing_agreement_id) {
      await settleSubscription(String(r.billing_agreement_id));        // a renewal
    } else if (type === 'CHECKOUT.ORDER.APPROVED' && r.id) {
      await settleOrder(String(r.id));                                 // Lifetime, if the buyer closed the tab
    } else if (type === 'PAYMENT.CAPTURE.COMPLETED' && parseCustom(r.custom_id)) {
      const ids = r.supplementary_data && r.supplementary_data.related_ids;
      if (ids && ids.order_id) await settleOrder(String(ids.order_id));
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('paypal webhook', e.message);
    res.status(500).send('error');
  }
}

module.exports = {
  router, webhook, verifySignature, paypalWebhook,
  processorOf, purchaseBlock, parseCustom, customIdFor, isPaypalSubId, paypalPeriodEnd,
  settleSubscription, settleOrder, changePlan, planProblem
};
