// Gumroad → income log, through "Connect Gumroad" (OAuth) with the view_sales
// scope only: NoBossly can read sales and nothing else. Needs NoBossly's own
// Gumroad application: GUMROAD_CLIENT_ID and GUMROAD_CLIENT_SECRET, with the
// redirect URI https://nobossly.com/budget/connect/gumroad/callback.
//
// Sales come in as income; refunded sales are left out; memberships and
// subscriptions are ticked Recurring.

const { call, form, secretOf, fail, saveIncome, incomeRow, sinceOf, redirectUri } = require('./common');

const AUTH = 'https://gumroad.com/oauth/authorize';
const TOKEN = 'https://api.gumroad.com/oauth/token';
const API = 'https://api.gumroad.com/v2';
const MAX_PAGES = 100;

const configured = () => !!(process.env.GUMROAD_CLIENT_ID && process.env.GUMROAD_CLIENT_SECRET);

function authUrl(state) {
  return AUTH + '?' + form({ client_id: process.env.GUMROAD_CLIENT_ID, redirect_uri: redirectUri('gumroad'), response_type: 'code', scope: 'view_sales', state });
}

async function exchange(code, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form({ code, client_id: process.env.GUMROAD_CLIENT_ID, client_secret: process.env.GUMROAD_CLIENT_SECRET, redirect_uri: redirectUri('gumroad'), grant_type: 'authorization_code' })
  });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: 'Gumroad did not let NoBossly in. Try connecting again.' };
  // A token with more than it needs is refused: read-only, like the others.
  const scopes = String(r.body.scope || 'view_sales').split(/[\s,]+/).filter(Boolean);
  if (scopes.some(s => s !== 'view_sales' && s !== 'view_profile')) return { error: 'Gumroad granted more access than NoBossly asked for. Try connecting again.' };
  return { token: r.body.access_token };
}

const explain = status => (status === 401 ? 'Gumroad says NoBossly is not allowed in any more (the connection may have been removed in Gumroad). Connect again.'
  : status === 429 ? 'Gumroad asked us to slow down. We will try again shortly.'
  : 'Gumroad did not answer properly (' + (status || 'no response') + '). We will try again later.');

async function salesSince(fetchImpl, tok, since) {
  const out = [];
  let pageKey = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = { after: since.toISOString().slice(0, 10) };
    if (pageKey) q.page_key = pageKey;
    const r = await call(fetchImpl, API + '/sales?' + form(q), { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
    if (r.status !== 200 || !r.body || r.body.success === false || !Array.isArray(r.body.sales)) return { error: explain(r.status), sales: out };
    out.push(...r.body.sales);
    if (!r.body.next_page_key) break;
    pageKey = r.body.next_page_key;
  }
  return { sales: out };
}

function rowOf(userId, s) {
  if (!s || s.refunded || s.chargedback || s.disputed) return null;
  const cents = Number(s.price);
  if (!(cents > 0)) return null;
  return incomeRow(userId, {
    id: 'gumroad:' + s.id, amount: cents / 100, currency: s.currency || 'usd',
    date: s.created_at, source: 'Gumroad' + (s.product_name ? ' · ' + s.product_name : ''),
    description: s.partially_refunded ? 'Partly refunded in Gumroad' : null,
    recurring: !!(s.subscription_id || s.recurrence)
  });
}

async function sync(sc, conn, { fetchImpl = fetch, now = new Date() } = {}) {
  const tok = await secretOf(sc, conn);
  if (!tok) return fail(sc, conn, 'The connection could not be read. Disconnect and connect Gumroad again.', now);
  const got = await salesSince(fetchImpl, tok, sinceOf(conn, now));
  if (got.error && !got.sales.length) return fail(sc, conn, got.error, now);
  const rows = got.sales.map(s => rowOf(conn.user_id, s)).filter(Boolean);
  return saveIncome(sc, conn, rows, { now, through: got.error ? null : now, error: got.error || null, provider: 'Gumroad' });
}

module.exports = { configured, authUrl, exchange, salesSince, rowOf, sync };
