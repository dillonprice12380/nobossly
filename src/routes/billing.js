const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const premium = require('../premium');
const { anonClient, serviceClient } = require('../supabase');
const pricing = require('../pricing');

const STRIPE_KEY = () => process.env.STRIPE_SECRET_KEY || '';
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
    res.render('pricing', {
      title: 'Premium',
      metaDescription: 'NoBossly is free. Premium adds five tools for getting out of your job — a quit-date planner, tax set-aside, pricing calculator, proof page and interview tracker — for $3.99 a month.',
      // Each tier carries what it costs TODAY and what it normally costs. Both
      // the page and the checkout below read that from src/pricing.js, because
      // a page advertising one number while checkout charges another is the
      // one bug this area must not have.
      tiers: pricing.withOffer(tiers),
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
    // Already Premium: only the step up to Lifetime is on offer.
    if (req.profile.is_lifetime || (premium.hasPremium(req.profile) && req.params.key !== 'lifetime')) return res.redirect('/tools');
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
      'metadata[tier]': tier.key,
      'metadata[user_id]': req.user.id
    };

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

// Cancel at period end
router.post('/billing/cancel', requireAuth, async (req, res, next) => {
  try {
    const subId = req.profile.stripe_subscription_id;
    if (subId && STRIPE_KEY()) {
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

// Stripe webhook (mounted with raw body in server.js). We never trust the
// payload: we re-fetch the referenced object from Stripe before acting.
async function webhook(req, res) {
  try {
    if (!STRIPE_KEY()) return res.status(200).send('ignored');
    const event = JSON.parse(req.body.toString('utf8'));
    const type = event.type || '';
    const obj = (event.data && event.data.object) || {};
    const sb = anonClient();

    if (type === 'checkout.session.completed' && obj.id) {
      const session = await stripe('GET', 'checkout/sessions/' + encodeURIComponent(obj.id) + '?expand[]=subscription');
      const uid = session.client_reference_id;
      if (uid && session.payment_status === 'paid') {
        const tier = (session.metadata && session.metadata.tier) || 'month';
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
        const sub = await stripe('GET', 'subscriptions/' + encodeURIComponent(subId));
        const { data: uid } = await sb.rpc('find_user_by_stripe_sub', { p_secret: SUB_SECRET(), p_sub_id: sub.id });
        if (uid) {
          const status = sub.status === 'active' && sub.cancel_at_period_end ? 'canceled'
            : (sub.status === 'active' || sub.status === 'trialing') ? 'active'
            : sub.status === 'canceled' ? 'expired' : sub.status;
          await applySub(uid, { status, periodEnd: periodEnd(sub) });
        }
      }
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('stripe webhook', e.message);
    res.status(200).send('error-logged');
  }
}

module.exports = { router, webhook };
