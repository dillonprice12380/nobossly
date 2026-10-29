// Pure helpers for PayPal subscriptions and orders. No I/O, so the unit tests
// can load this file directly.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = v => typeof v === 'string' && UUID.test(v);

// Every PayPal object NoBossly creates carries custom_id "nobossly:<user id>:<tier key>".
// The prefix is what keeps NoBossly's webhook from acting on anything else that
// shares the PayPal account or REST app (EnRoute Jobs' own subscriptions and
// orders), and what keeps theirs from acting on ours.
const APP_PREFIX = 'nobossly';
const TIERS = ['month', 'year', 'lifetime'];

const customId = (userId, tierKey) => `${APP_PREFIX}:${userId}:${tierKey}`;

// → { userId, tier } or null for anything that is not ours.
function parseCustomId(v) {
  if (typeof v !== 'string') return null;
  const m = /^nobossly:([^:]+):([a-z]+)$/.exec(v);
  if (!m || !isUuid(m[1]) || !TIERS.includes(m[2])) return null;
  return { userId: m[1].toLowerCase(), tier: m[2] };
}

// "5.00" → 500. Null for anything that is not a plain non-negative decimal.
function centsFromPayPal(money) {
  const v = money && money.value;
  if (typeof v !== 'string' || !/^\d+(\.\d{1,2})?$/.test(v.trim())) return null;
  return Math.round(parseFloat(v) * 100);
}

// "5.00" for 500. PayPal wants a string with two decimals.
const moneyValue = cents => (cents / 100).toFixed(2);

// Whether a PayPal billing plan sells what pricing_tiers says it sells: one
// regular cycle at exactly this price, currency and interval, no trial, no
// set-up fee, and switched on. Null when it matches, else the reason.
function planMismatch(plan, expected) {
  if (!plan) return 'plan not found';
  if (plan.status && plan.status !== 'ACTIVE') return 'plan is not active';
  const cycles = plan.billing_cycles || [];
  if (cycles.some(c => c.tenure_type === 'TRIAL')) return 'plan has a trial cycle';
  const regular = cycles.filter(c => c.tenure_type === 'REGULAR');
  if (regular.length !== 1) return 'plan must have exactly one regular billing cycle';
  const c = regular[0];
  const every = expected.interval === 'year' ? 'year' : 'month';
  const freq = c.frequency || {};
  if (freq.interval_unit !== every.toUpperCase() || (freq.interval_count == null ? 1 : freq.interval_count) !== 1) return `plan does not bill every ${every}`;
  if (c.total_cycles != null && c.total_cycles !== 0) return 'plan has a fixed number of cycles';
  const price = c.pricing_scheme && c.pricing_scheme.fixed_price;
  if (centsFromPayPal(price) !== expected.amountCents) return `plan price ${price && price.value || '?'} differs from ${moneyValue(expected.amountCents)}`;
  if (((price && price.currency_code) || '').toLowerCase() !== expected.currency.toLowerCase()) return 'plan currency differs';
  const setup = centsFromPayPal(plan.payment_preferences && plan.payment_preferences.setup_fee);
  if (setup) return 'plan has a set-up fee';
  return null;
}

// The billing period a subscription has actually been paid for: from its last
// completed payment to its next billing time. "Not paid" covers a subscription
// PayPal has approved but not yet charged, and a charge for less than the plan.
function paidPeriod(sub, expected) {
  const info = (sub && sub.billing_info) || {};
  const last = info.last_payment;
  if (!last || !last.time) return { paid: false, reason: 'no completed payment yet' };
  const paid = centsFromPayPal(last.amount);
  if (paid === null || paid < expected.amountCents) return { paid: false, reason: 'payment is less than the plan price' };
  if (((last.amount && last.amount.currency_code) || '').toLowerCase() !== expected.currency.toLowerCase()) return { paid: false, reason: 'payment currency differs' };
  const start = new Date(last.time);
  if (Number.isNaN(start.getTime())) return { paid: false, reason: 'unreadable payment time' };
  const next = info.next_billing_time ? new Date(info.next_billing_time) : null;
  if (!next || Number.isNaN(next.getTime()) || next <= start) return { paid: false, reason: 'no next billing time' };
  return { paid: true, start: start.toISOString(), end: next.toISOString() };
}

// Null when the PayPal order is a payment for exactly what we offered: one
// purchase unit, stamped with our custom_id, for exactly this amount/currency.
function orderProblem(order, expected) {
  const units = (order && order.purchase_units) || [];
  if (units.length !== 1) return 'order must have exactly one purchase unit';
  const u = units[0];
  if (u.custom_id !== expected.customId) return 'custom_id differs from ours';
  if (centsFromPayPal(u.amount) !== expected.amountCents) return 'amount differs';
  if (((u.amount && u.amount.currency_code) || '').toLowerCase() !== expected.currency.toLowerCase()) return 'currency differs';
  return null;
}

// The capture an order was paid by (the first one), if any.
function firstCapture(order) {
  const u = order && order.purchase_units && order.purchase_units[0];
  return (u && u.payments && u.payments.captures && u.payments.captures[0]) || null;
}

// The capture id inside an ".../v2/payments/captures/<id>" link. A refund event
// points at the capture it refunds this way.
function captureIdFromLinks(links) {
  for (const l of links || []) {
    const m = /\/v2\/payments\/captures\/([A-Za-z0-9]+)\/?$/.exec((l && l.href) || '');
    if (m && (l.rel === 'up' || l.rel === 'capture' || !l.rel)) return m[1];
  }
  return null;
}

// The least a Lifetime payment may legitimately be: the cheaper of the list
// price and a running markdown. A markdown may have ended between checkout and
// the payment arriving, so the floor allows for either.
function lifetimeFloorCents(tier) {
  if (!tier) return null;
  const list = tier.price_cents;
  return tier.promo_price_cents != null ? Math.min(list, tier.promo_price_cents) : list;
}

// Whether a Premium subscription in this PayPal state still holds a member.
function statusFromPayPal(sub) {
  const s = sub && sub.status;
  if (s === 'ACTIVE') {
    const failed = sub.billing_info && sub.billing_info.failed_payments_count;
    return failed > 0 ? 'past_due' : 'active';
  }
  if (s === 'SUSPENDED') return 'past_due';
  if (s === 'CANCELLED') return 'canceled';
  if (s === 'EXPIRED') return 'expired';
  return null; // APPROVAL_PENDING, APPROVED, ...: nothing to act on yet
}

module.exports = {
  APP_PREFIX, TIERS, isUuid, customId, parseCustomId, centsFromPayPal, moneyValue,
  planMismatch, paidPeriod, orderProblem, firstCapture, captureIdFromLinks,
  lifetimeFloorCents, statusFromPayPal
};
