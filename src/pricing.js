// What a tier costs today, and what it normally costs.
//
// pricing_tiers holds the list price and its Stripe Price ID. A markdown does
// not overwrite either of those: it sits alongside in promo_* columns, so the
// full price and its catalogue ID survive the promotion and coming off it is
// clearing one field rather than retyping four prices from memory.
//
// Both the pricing page and the checkout route read the answer from here, which
// is the point — a page that advertises one number while checkout charges
// another is the worst bug this file could have.

// A markdown counts while it has an amount and has not expired. A null
// promo_ends_at is an open-ended markdown, not an expired one.
function promoActive(tier, now) {
  if (!tier || tier.promo_price_cents == null) return false;
  if (!tier.promo_ends_at) return true;
  return new Date(tier.promo_ends_at).getTime() > (now ? now.getTime() : Date.now());
}

// { cents, stripePriceId, isPromo, label, listCents, saved }
//
// stripePriceId may be null even during a markdown — the Stripe Price is
// optional by design, because src/routes/billing.js builds the line item inline
// from `cents` when there is no ID. That is what lets a markdown go live before
// its Stripe objects exist, and it means a wrong ID can never charge the wrong
// amount silently: the amount is always the one in this row.
function offerFor(tier, now) {
  if (!tier) return null;
  const list = tier.price_cents;
  if (!promoActive(tier, now)) {
    return { cents: list, stripePriceId: tier.stripe_price_id || null,
             isPromo: false, label: null, listCents: list, saved: 0 };
  }
  const cents = tier.promo_price_cents;
  return {
    cents,
    stripePriceId: tier.promo_stripe_price_id || null,
    isPromo: true,
    label: tier.promo_label || null,
    listCents: list,
    saved: Math.max(0, list - cents)
  };
}

// "$12", "$14.50" — whole dollars stay whole, which is how the page has always
// rendered them.
function money(cents) {
  const n = (cents || 0) / 100;
  return '$' + n.toFixed(n % 1 ? 2 : 0);
}

const withOffer = (tiers, now) => (tiers || []).map(t => Object.assign({}, t, { offer: offerFor(t, now) }));

module.exports = { offerFor, promoActive, money, withOffer };
