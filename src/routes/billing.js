const router = require('express').Router();
const { requireAuth, planOf } = require('../middleware/auth');
const { anonClient } = require('../supabase');

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

async function applySub(userId, { tier, status, customer, subId, periodEnd, lifetime }) {
  const sb = anonClient();
  const { error } = await sb.rpc('apply_subscription', {
    p_secret: SUB_SECRET(), p_user: userId,
    p_tier: tier || null, p_status: status || null,
    p_customer: customer || null, p_sub_id: subId || null,
    p_period_end: periodEnd || null, p_lifetime: !!lifetime
  });
  if (error) throw new Error('apply_subscription: ' + error.message);
}

const FREE_FEATURES = [
  '1 AI idea generation',
  'Community forum access',
  'Up to 8 tasks at a time (manual)',
  'Member profile & levels'
];
const PAID_FEATURES = [
  'Everything in Free',
  'Unlimited AI idea generations',
  'AI roadmap & automatic task dispersement',
  'Launch blueprints',
  'Challenges & milestones',
  'Collaborations & teams',
  'Priority support'
];

// Public pricing page
router.get('/pricing', async (req, res, next) => {
  try {
    const sb = req.sb || anonClient();
    const { data: tiers } = await sb.from('pricing_tiers').select('*').eq('is_active', true).order('sort');
    res.render('pricing', {
      title: 'Pricing',
      tiers: tiers || [],
      freeFeatures: FREE_FEATURES, paidFeatures: PAID_FEATURES,
      plan: req.profile ? planOf(req.profile) : null,
      upgrade: req.query.upgrade, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// Map a tier key to a Stripe recurring interval, used for inline (Price-ID-free) subscriptions.
function recurringFor(key) {
  if (key === 'quarter') return { interval: 'month', interval_count: 3 };
  if (key === 'year') return { interval: 'year', interval_count: 1 };
  return { interval: 'month', interval_count: 1 }; // monthly default
}

// Start checkout — EnRoute-style resilience: the ONLY thing that can block checkout is a
// missing Stripe secret key. Pricing is read with the reliable anon client, and the line
// item is built INLINE from the amount stored in pricing_tiers, so a missing or wrong
// Stripe Price ID can never stop a sale (a valid stripe_price_id is still used if present).
router.post('/billing/checkout/:key', requireAuth, async (req, res, next) => {
  try {
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
      cancel_url: SITE() + '/pricing',
      client_reference_id: req.user.id,
      'metadata[tier]': tier.key,
      'metadata[user_id]': req.user.id
    };

    if (tier.stripe_price_id) {
      // Use the configured catalog Price when present...
      params['line_items[0][price]'] = tier.stripe_price_id;
    } else {
      // ...otherwise build the price inline from the amount in pricing_tiers.
      params['line_items[0][price_data][currency]'] = 'usd';
      params['line_items[0][price_data][product_data][name]'] = tier.name || 'NoBossly';
      params['line_items[0][price_data][unit_amount]'] = String(tier.price_cents);
      if (!isPayment) {
        const r = recurringFor(tier.key);
        params['line_items[0][price_data][recurring][interval]'] = r.interval;
        params['line_items[0][price_data][recurring][interval_count]'] = String(r.interval_count);
      }
    }

    if (req.profile.stripe_customer_id) { params.customer = req.profile.stripe_customer_id; }
    else { params.customer_email = req.user.email; }

    let session;
    try {
      session = await stripe('POST', 'checkout/sessions', params);
    } catch (err) {
      return res.redirect('/pricing?msg=' + encodeURIComponent('Could not start checkout: ' + err.message));
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
      } else {
        const sub = session.subscription;
        await applySub(req.user.id, {
          tier, status: 'active', customer: session.customer,
          subId: sub && sub.id,
          periodEnd: sub && sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
        });
      }
      return res.redirect('/account?sub=success');
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
        periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
      });
    } else {
      await applySub(req.user.id, { status: 'canceled' });
    }
    res.redirect('/account?sub=canceled');
  } catch (e) { next(e); }
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
        } else {
          const sub = session.subscription;
          await applySub(uid, { tier, status: 'active', customer: session.customer, subId: sub && sub.id, periodEnd: sub && sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null });
        }
      }
    } else if ((type === 'customer.subscription.updated' || type === 'customer.subscription.deleted' || type === 'invoice.paid') && (obj.id || obj.subscription)) {
      const subId = type === 'invoice.paid' ? obj.subscription : obj.id;
      if (subId) {
        const sub = await stripe('GET', 'subscriptions/' + encodeURIComponent(subId));
        const { data: uid } = await sb.rpc('find_user_by_stripe_sub', { p_secret: SUB_SECRET(), p_sub_id: sub.id });
        if (uid) {
          const status = sub.status === 'active' && sub.cancel_at_period_end ? 'canceled'
            : (sub.status === 'active' || sub.status === 'trialing') ? 'active'
            : sub.status === 'canceled' ? 'expired' : sub.status;
          await applySub(uid, { status, periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null });
        }
      }
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('stripe webhook', e.message);
    res.status(200).send('error-logged');
  }
}

module.exports = { router, webhook, planOf };
