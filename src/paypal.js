// PayPal REST client (Subscriptions + Orders), server-side only.
//
// Env:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   the REST app's credentials
//   PAYPAL_WEBHOOK_ID                        id of the webhook registered on that same app
//   PAYPAL_ENV                               'live' (default) or 'sandbox'
//
// Sandbox and live are separate worlds: separate apps, credentials, webhooks and
// plans. The credentials decide which one answers, so a mismatch fails at the
// token request rather than charging anything.
//
// Env is read on every call (not once at load) so tests can set it, and a
// changed variable needs only a restart like every other setting.

const crypto = require('crypto');
const { moneyValue } = require('./paypalPlan');

const env = () => ({
  id: process.env.PAYPAL_CLIENT_ID || '',
  secret: process.env.PAYPAL_CLIENT_SECRET || '',
  webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
  mode: process.env.PAYPAL_ENV === 'sandbox' ? 'sandbox' : 'live'
});
const base = () => (env().mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

// Checkout is offered only when the credentials are set.
const isEnabled = () => !!env().id && !!env().secret;
// The webhook is only trusted when its id is set (see verifyWebhook).
const hasWebhookId = () => !!env().webhookId;

// A PayPal call that should be tried again later (network, 5xx, rate limit).
class PayPalTransient extends Error {}

let tokenCache = null;

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  const e = env();
  let res;
  try {
    res = await fetch(base() + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(e.id + ':' + e.secret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    throw new PayPalTransient('PayPal token request failed: ' + err.message);
  }
  if (!res.ok) {
    // 401 means wrong credentials (or live credentials against sandbox, or the reverse).
    const msg = `PayPal token request refused (${res.status}) in ${e.mode} mode. Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV.`;
    if (res.status >= 500 || res.status === 429) throw new PayPalTransient(msg);
    throw new Error(msg);
  }
  const j = await res.json();
  if (!j.access_token) throw new Error('PayPal token response had no access_token');
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 300) * 1000 };
  return j.access_token;
}

// → { ok, status, data, raw }
async function paypalFetch(path, init) {
  init = init || {};
  const call = token => fetch(base() + path, {
    method: init.method || 'GET',
    headers: Object.assign(
      { Authorization: 'Bearer ' + token },
      init.json !== undefined || init.rawBody !== undefined ? { 'Content-Type': 'application/json' } : {},
      init.headers || {}
    ),
    body: init.rawBody !== undefined ? init.rawBody : (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    signal: AbortSignal.timeout(20000)
  });
  let res;
  try {
    res = await call(await accessToken());
    if (res.status === 401) { tokenCache = null; res = await call(await accessToken()); }
  } catch (err) {
    if (err instanceof PayPalTransient) throw err;
    throw new PayPalTransient('PayPal request failed: ' + err.message);
  }
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* not JSON */ }
  if (res.status >= 500 || res.status === 429) throw new PayPalTransient(`PayPal ${path} answered ${res.status}`);
  return { ok: res.ok, status: res.status, data, raw };
}

const isPaypalHost = href => {
  try { const h = new URL(href).hostname; return h === 'paypal.com' || h.endsWith('.paypal.com'); } catch (_) { return false; }
};

// ─── Subscriptions API ──────────────────────────────────────────────────────

async function getSubscription(id) {
  const r = await paypalFetch('/v1/billing/subscriptions/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PayPal subscription ${id} read failed (${r.status}): ${r.raw.slice(0, 300)}`);
  return r.data;
}

async function getPlan(id) {
  const r = await paypalFetch('/v1/billing/plans/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PayPal plan ${id} read failed (${r.status}): ${r.raw.slice(0, 300)}`);
  return r.data;
}

// A sale (one subscription payment) from the v1 payments API.
async function getSale(id) {
  const r = await paypalFetch('/v1/payments/sale/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PayPal sale ${id} read failed (${r.status}): ${r.raw.slice(0, 300)}`);
  return r.data;
}

// Stops billing. The member keeps what they already paid for. 204 on success;
// 422 when it is already cancelled.
async function cancelSubscription(id, reason) {
  const r = await paypalFetch('/v1/billing/subscriptions/' + encodeURIComponent(id) + '/cancel', {
    method: 'POST', json: { reason: String(reason || 'Cancelled').slice(0, 128) }
  });
  if (r.ok || r.status === 422) return true;
  console.error(`[paypal] could not cancel subscription ${id} (${r.status}): ${r.raw.slice(0, 300)}`);
  return false;
}

async function createSubscription({ planId, customId, returnUrl, cancelUrl, email }) {
  const body = {
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
  };
  if (email) body.subscriber = { email_address: email };
  const r = await paypalFetch('/v1/billing/subscriptions', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': crypto.randomUUID(), Prefer: 'return=representation' },
    json: body
  });
  const link = r.data && (r.data.links || []).find(l => l.rel === 'approve');
  if (!r.ok || !r.data || !r.data.id || !link) {
    console.error(`[paypal] could not create subscription (${r.status}): ${r.raw.slice(0, 500)}`);
    return null;
  }
  // The approval link must go to PayPal itself.
  if (!isPaypalHost(link.href)) { console.error('[paypal] refusing approval link to ' + link.href); return null; }
  return { id: r.data.id, approveUrl: link.href };
}

// Ask PayPal whether a webhook delivery is genuine. The body is sent as the raw
// text received, because the signature covers its exact bytes. `get` reads a
// header by lower-case name. Fails closed: with no PAYPAL_WEBHOOK_ID nothing is
// accepted, since an unverifiable event must never grant access.
async function verifyWebhook(get, rawBody) {
  const webhookId = env().webhookId;
  if (!webhookId) return false;
  // The body is embedded as-is below. Requiring it to be a single JSON object
  // means nothing in it can add or override the other fields of the request.
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  } catch (_) { return false; }
  const h = n => get(n) || '';
  const payload =
    '{' +
    `"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},` +
    `"cert_url":${JSON.stringify(h('paypal-cert-url'))},` +
    `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},` +
    `"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},` +
    `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},` +
    `"webhook_id":${JSON.stringify(webhookId)},` +
    `"webhook_event":${rawBody}` +
    '}';
  const r = await paypalFetch('/v1/notifications/verify-webhook-signature', { method: 'POST', rawBody: payload });
  return r.ok && !!r.data && r.data.verification_status === 'SUCCESS';
}

// ─── Orders API (the one-time Lifetime payment) ─────────────────────────────

// A CAPTURE order for one purchase. `requestId` makes a retried click return
// the same PayPal order rather than a second one.
async function createOrder({ customId, amountCents, currency, description, returnUrl, cancelUrl, requestId }) {
  const r = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': requestId || crypto.randomUUID(), Prefer: 'return=representation' },
    json: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'lifetime',
        custom_id: customId,
        description: String(description || 'NoBossly Premium Lifetime').slice(0, 127),
        amount: { currency_code: currency.toUpperCase(), value: moneyValue(amountCents) }
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
    console.error(`[paypal] could not create order (${r.status}): ${r.raw.slice(0, 500)}`);
    return null;
  }
  return { id: r.data.id, approveUrl: link.href };
}

async function getOrder(id) {
  const r = await paypalFetch('/v2/checkout/orders/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PayPal order ${id} read failed (${r.status}): ${r.raw.slice(0, 300)}`);
  return r.data;
}

// Take the payment of an approved order. Safe to repeat: a second call answers
// with the finished order. → { order, declined }
async function captureOrder(id) {
  const r = await paypalFetch('/v2/checkout/orders/' + encodeURIComponent(id) + '/capture', {
    method: 'POST', headers: { 'PayPal-Request-Id': 'capture-' + id, Prefer: 'return=representation' }, json: {}
  });
  if (r.ok) return { order: r.data, declined: false };
  const issues = ((r.data && r.data.details) || []).map(d => d.issue);
  if (issues.includes('ORDER_ALREADY_CAPTURED')) return { order: await getOrder(id), declined: false };
  if (issues.includes('INSTRUMENT_DECLINED') || issues.includes('PAYER_ACTION_REQUIRED')) return { order: null, declined: true };
  throw new Error(`PayPal capture of ${id} failed (${r.status}): ${r.raw.slice(0, 300)}`);
}

async function getCapture(id) {
  const r = await paypalFetch('/v2/payments/captures/' + encodeURIComponent(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PayPal capture ${id} read failed (${r.status}): ${r.raw.slice(0, 300)}`);
  return r.data;
}

module.exports = {
  isEnabled, hasWebhookId, PayPalTransient, paypalFetch,
  getSubscription, getPlan, getSale, cancelSubscription, createSubscription, verifyWebhook,
  createOrder, getOrder, captureOrder, getCapture
};
