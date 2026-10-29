// PayPal REST client (Subscriptions + Orders), server side only, no SDK.
//
// Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (the REST app), PAYPAL_WEBHOOK_ID
// (the webhook registered for it), PAYPAL_ENV ('sandbox' to use the sandbox;
// anything else means live). Sandbox and live are separate worlds with separate
// credentials, plans and webhooks, so use the set that matches PAYPAL_ENV.

const crypto = require('crypto');

const CLIENT_ID = () => process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.PAYPAL_CLIENT_SECRET || '';
const WEBHOOK_ID = () => process.env.PAYPAL_WEBHOOK_ID || '';
const BASE = () => process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

// Checkout is offered only when the credentials are set.
const isEnabled = () => !!CLIENT_ID() && !!CLIENT_SECRET();
const hasWebhookId = () => !!WEBHOOK_ID();

// A PayPal call worth trying again later (network, 5xx, rate limit). The
// webhook answers 5xx for these so PayPal redelivers.
class Transient extends Error {}

let tokenCache = null;
async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  let res;
  try {
    res = await fetch(BASE() + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(CLIENT_ID() + ':' + CLIENT_SECRET()).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) { throw new Transient('PayPal token request failed: ' + e.message); }
  if (!res.ok) {
    const msg = 'PayPal token request refused (' + res.status + '). Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV.';
    if (res.status >= 500 || res.status === 429) throw new Transient(msg);
    throw new Error(msg);
  }
  const j = await res.json();
  if (!j.access_token) throw new Error('PayPal token response had no access_token');
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 300) * 1000 };
  return j.access_token;
}

async function call(path, { method = 'GET', json, rawBody, headers } = {}) {
  const send = async token => fetch(BASE() + path, {
    method,
    headers: Object.assign(
      { Authorization: 'Bearer ' + token },
      json !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {},
      headers || {}
    ),
    body: rawBody !== undefined ? rawBody : (json !== undefined ? JSON.stringify(json) : undefined),
    signal: AbortSignal.timeout(20000)
  });
  let res;
  try {
    res = await send(await accessToken());
    if (res.status === 401) { tokenCache = null; res = await send(await accessToken()); }
  } catch (e) {
    if (e instanceof Transient) throw e;
    throw new Transient('PayPal request failed: ' + e.message);
  }
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* not JSON */ }
  if (res.status >= 500 || res.status === 429) throw new Transient('PayPal ' + path + ' answered ' + res.status);
  return { ok: res.ok, status: res.status, data, raw };
}

// The approval link must lead to PayPal itself, whatever the response says.
function isPaypalHost(href) {
  try { const h = new URL(href).hostname; return h === 'paypal.com' || h.endsWith('.paypal.com'); }
  catch (_) { return false; }
}

// PayPal wants money as a string with two decimals: 500 -> "5.00".
const moneyValue = cents => (cents / 100).toFixed(2);
const toCents = value => Math.round(parseFloat(value) * 100);

// ── Subscriptions ───────────────────────────────────────────────────────────

async function getSubscription(id) {
  const r = await call('/v1/billing/subscriptions/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('PayPal subscription ' + id + ' read failed (' + r.status + '): ' + r.raw.slice(0, 300));
  return r.data;
}

async function getPlan(id) {
  const r = await call('/v1/billing/plans/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('PayPal plan ' + id + ' read failed (' + r.status + '): ' + r.raw.slice(0, 300));
  return r.data;
}

// The price and interval a plan really charges, so a plan created at the wrong
// amount can never be sold under a page that advertises another.
function planTerms(plan) {
  const cycles = (plan && plan.billing_cycles) || [];
  const regular = cycles.find(c => c.tenure_type === 'REGULAR');
  if (!regular) return null;
  const fixed = regular.pricing_scheme && regular.pricing_scheme.fixed_price;
  return {
    status: plan.status,
    cents: fixed ? toCents(fixed.value) : null,
    currency: fixed ? fixed.currency_code : null,
    unit: regular.frequency && regular.frequency.interval_unit,
    count: regular.frequency && regular.frequency.interval_count,
    totalCycles: regular.total_cycles
  };
}

// Stops billing. The member keeps what they already paid for. 204 on success;
// 422 when it is already cancelled.
async function cancelSubscription(id, reason) {
  const r = await call('/v1/billing/subscriptions/' + encodeURIComponent(id) + '/cancel', {
    method: 'POST', json: { reason: String(reason || 'Cancelled').slice(0, 128) }
  });
  if (r.ok || r.status === 422) return true;
  console.error('[paypal] could not cancel subscription ' + id + ' (' + r.status + '): ' + r.raw.slice(0, 300));
  return false;
}

async function createSubscription({ planId, customId, returnUrl, cancelUrl }) {
  const r = await call('/v1/billing/subscriptions', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': crypto.randomUUID(), Prefer: 'return=representation' },
    json: {
      plan_id: planId,
      custom_id: customId,
      application_context: {
        brand_name: 'NoBossly',
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' },
        return_url: returnUrl,
        cancel_url: cancelUrl
      }
    }
  });
  const link = r.data && (r.data.links || []).find(l => l.rel === 'approve');
  if (!r.ok || !r.data || !r.data.id || !link || !isPaypalHost(link.href)) {
    console.error('[paypal] could not create subscription (' + r.status + '): ' + r.raw.slice(0, 500));
    return null;
  }
  return { id: r.data.id, approveUrl: link.href };
}

// ── Orders (one-time payments: Lifetime) ────────────────────────────────────

async function createOrder({ amountCents, customId, description, returnUrl, cancelUrl }) {
  const r = await call('/v2/checkout/orders', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': crypto.randomUUID(), Prefer: 'return=representation' },
    json: {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: customId,
        description: String(description || 'NoBossly Premium').slice(0, 127),
        amount: { currency_code: 'USD', value: moneyValue(amountCents) }
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'NoBossly',
            locale: 'en-US',
            landing_page: 'GUEST_CHECKOUT',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: returnUrl,
            cancel_url: cancelUrl
          }
        }
      }
    }
  });
  const link = r.data && (r.data.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
  if (!r.ok || !r.data || !r.data.id || !link || !isPaypalHost(link.href)) {
    console.error('[paypal] could not create order (' + r.status + '): ' + r.raw.slice(0, 500));
    return null;
  }
  return { id: r.data.id, approveUrl: link.href };
}

async function getOrder(id) {
  const r = await call('/v2/checkout/orders/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('PayPal order ' + id + ' read failed (' + r.status + '): ' + r.raw.slice(0, 300));
  return r.data;
}

// Takes the payment of an approved order. Safe to repeat: the request id is the
// order id, and an already-captured order answers with the finished order.
async function captureOrder(id) {
  const r = await call('/v2/checkout/orders/' + encodeURIComponent(id) + '/capture', {
    method: 'POST', headers: { 'PayPal-Request-Id': 'capture-' + id, Prefer: 'return=representation' }, json: {}
  });
  if (r.ok) return { order: r.data, declined: false };
  const issues = ((r.data && r.data.details) || []).map(d => d.issue);
  if (issues.includes('ORDER_ALREADY_CAPTURED')) return { order: await getOrder(id), declined: false };
  if (issues.includes('INSTRUMENT_DECLINED') || issues.includes('PAYER_ACTION_REQUIRED')) return { order: null, declined: true };
  throw new Error('PayPal capture of ' + id + ' failed (' + r.status + '): ' + r.raw.slice(0, 300));
}

// ── Webhooks ────────────────────────────────────────────────────────────────

// Asks PayPal whether a delivery is genuine. The body goes in as the exact text
// received, because the signature covers its bytes; it must be one JSON object
// so nothing inside it can add or override the other fields of the request.
async function verifyWebhook(getHeader, rawBody) {
  if (!hasWebhookId()) return false;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  } catch (_) { return false; }
  const h = n => getHeader(n) || '';
  const payload = '{' +
    '"auth_algo":' + JSON.stringify(h('paypal-auth-algo')) + ',' +
    '"cert_url":' + JSON.stringify(h('paypal-cert-url')) + ',' +
    '"transmission_id":' + JSON.stringify(h('paypal-transmission-id')) + ',' +
    '"transmission_sig":' + JSON.stringify(h('paypal-transmission-sig')) + ',' +
    '"transmission_time":' + JSON.stringify(h('paypal-transmission-time')) + ',' +
    '"webhook_id":' + JSON.stringify(WEBHOOK_ID()) + ',' +
    '"webhook_event":' + rawBody +
    '}';
  const r = await call('/v1/notifications/verify-webhook-signature', { method: 'POST', rawBody: payload });
  return r.ok && !!r.data && r.data.verification_status === 'SUCCESS';
}

module.exports = {
  isEnabled, hasWebhookId, Transient, isPaypalHost, moneyValue, toCents, planTerms,
  getSubscription, getPlan, cancelSubscription, createSubscription,
  createOrder, getOrder, captureOrder, verifyWebhook
};
