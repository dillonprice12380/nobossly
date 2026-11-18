// "Connect with Stripe": NoBossly's own Stripe App, with read-only permissions
// (charges, payment intents, invoices) and OAuth. Stripe Connect's older OAuth
// grants read-write on Standard accounts, so it is not used.
//
// Needs STRIPE_APP_CLIENT_ID and STRIPE_APP_SECRET_KEY (the secret key of the
// account the app is published from), with the redirect URI
// https://nobossly.com/budget/connect/stripe/callback in the app's manifest.
// Access tokens last an hour; refresh tokens a year and rotate on each use.
// Until it is set up, pasting a restricted key still works.

const { call, form, store } = require('./common');

const SITE = (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');
const REDIRECT = SITE + '/budget/connect/stripe/callback';
const configured = () => !!(process.env.STRIPE_APP_CLIENT_ID && process.env.STRIPE_APP_SECRET_KEY);
const authUrl = state => 'https://marketplace.stripe.com/oauth/v2/authorize?' + form({ client_id: process.env.STRIPE_APP_CLIENT_ID, redirect_uri: REDIRECT, state });

const tokenOf = (b, now) => ({ mode: 'oauth', access_token: b.access_token, refresh_token: b.refresh_token || null,
  expires_at: now + 55 * 60 * 1000, account: b.stripe_user_id || b.account_id || null, livemode: !!b.livemode });

async function post(body, fetchImpl) {
  return call(fetchImpl, 'https://api.stripe.com/v1/oauth/token', {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(process.env.STRIPE_APP_SECRET_KEY + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body)
  });
}

async function exchange(code, { fetchImpl = fetch, now = Date.now() } = {}) {
  const r = await post({ grant_type: 'authorization_code', code }, fetchImpl);
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: 'Stripe did not let NoBossly in. Try connecting again.' };
  return { secret: tokenOf(r.body, now) };
}

/** The key a sync uses: a pasted restricted key as it is, or a fresh access token. */
async function keyFor(sc, conn, raw, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!String(raw || '').startsWith('{')) return { key: raw };
  let s = null;
  try { s = JSON.parse(raw); } catch (_) { return { error: 'The connection could not be read. Disconnect and connect Stripe again.' }; }
  if (s.mode !== 'oauth') return { error: 'The connection could not be read. Disconnect and connect Stripe again.' };
  if (now < s.expires_at) return { key: s.access_token };
  if (!s.refresh_token || !configured()) return { error: 'Stripe access ran out. Connect Stripe again.' };
  const r = await post({ grant_type: 'refresh_token', refresh_token: s.refresh_token }, fetchImpl);
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: 'Stripe access ran out or NoBossly was removed. Connect Stripe again.' };
  const next = Object.assign(tokenOf(r.body, now), { account: s.account });
  await store(sc, conn.user_id, 'stripe', next, conn.account_label || 'Stripe', conn.meta || null);
  return { key: next.access_token };
}

module.exports = { configured, authUrl, exchange, keyFor, REDIRECT };
