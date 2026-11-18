// Shopify → income log. The member makes their own app in Shopify's Dev
// Dashboard with read-only access to orders, installs it on their store and
// pastes its client ID and secret. NoBossly swaps those for a 24-hour access
// token each time it syncs (the client credentials grant), so what it holds
// can only read orders. Paid orders come in as income, net of refunds.
//
// Without the read_all_orders scope Shopify only shows the last 60 days; the
// connect page says so.

const crypto = require('crypto');
const { call, form, secretOf, fail, saveIncome, incomeRow, sinceOf, redirectUri, store } = require('./common');

const API_VERSION = '2025-10';
const PAID = new Set(['PAID', 'PARTIALLY_REFUNDED', 'PARTIALLY_PAID']);
const MAX_PAGES = 30;

// "mystore", "mystore.myshopify.com", "https://mystore.myshopify.com/admin" → "mystore.myshopify.com".
function cleanShop(v) {
  let s = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) return null;
  if (!s.endsWith('.myshopify.com')) s = s.replace(/\.myshopify$/, '') + '.myshopify.com';
  return /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/.test(s) ? s : null;
}

function checkInput(body) {
  const shop = cleanShop(body && body.shop);
  const clientId = String((body && body.client_id) || '').trim();
  const secret = String((body && body.client_secret) || '').trim();
  if (!shop) return { error: 'Enter your store address, e.g. mystore.myshopify.com.' };
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(clientId)) return { error: 'Paste the Client ID from your app in the Shopify Dev Dashboard.' };
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(secret)) return { error: 'Paste the Client secret from the same app.' };
  return { shop, clientId, secret };
}

const explain = (status, body) => {
  const m = String((body && (body.error_description || body.error || (body.errors && JSON.stringify(body.errors)))) || '');
  if (status === 400 || status === 401) return 'Shopify did not accept that client ID and secret' + (/shop_not_permitted/i.test(m) ? ' for this store (the app has to be installed on this store, from the same Shopify account).' : '. Check both, and that the app is installed on this store.');
  if (status === 403) return 'The app cannot read orders. In the Dev Dashboard, give it the read_orders scope and install it again.';
  if (status === 404) return 'That store address was not found.';
  if (status === 429) return 'Shopify asked us to slow down. We will try again shortly.';
  return 'Shopify did not answer properly (' + (status || 'no response') + '). We will try again later.';
};

// The client credentials grant: a token that lasts about a day.
async function token(fetchImpl, shop, clientId, secret) {
  const r = await call(fetchImpl, 'https://' + shop + '/admin/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret })
  });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: explain(r.status, r.body) };
  const scopes = String(r.body.scope || '').split(',').map(s => s.trim()).filter(Boolean);
  // Read-only, like the Stripe key: an app that can write anything is refused.
  if (scopes.some(s => /^write_/.test(s))) return { error: 'That app can change things in your store (' + scopes.filter(s => /^write_/.test(s)).join(', ') + '). Make one with read_orders only, so NoBossly can only read.' };
  if (scopes.length && !scopes.includes('read_orders')) return { error: 'That app cannot read orders. Give it the read_orders scope and install it again.' };
  return { token: r.body.access_token, scopes };
}

const QUERY = `query ($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id name createdAt test cancelledAt displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } } }
  }
}`;

async function ordersSince(fetchImpl, shop, tok, since) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await call(fetchImpl, 'https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
      body: JSON.stringify({ query: QUERY, variables: { q: 'created_at:>=' + since.toISOString().slice(0, 10), after } })
    });
    const orders = r.body && r.body.data && r.body.data.orders;
    if (r.status !== 200 || !orders) {
      const denied = r.body && JSON.stringify(r.body.errors || '').match(/access denied|ACCESS_DENIED/i);
      return { error: denied ? explain(403) : explain(r.status, r.body), orders: out };
    }
    out.push(...orders.nodes);
    if (!orders.pageInfo.hasNextPage) break;
    after = orders.pageInfo.endCursor;
  }
  return { orders: out };
}

function rowOf(userId, o) {
  if (!o || o.test || o.cancelledAt || !PAID.has(o.displayFinancialStatus)) return null;
  const money = o.currentTotalPriceSet && o.currentTotalPriceSet.shopMoney;
  const num = String(o.id || '').split('/').pop();
  return incomeRow(userId, { id: 'shopify:' + num, amount: money && money.amount, currency: money && money.currencyCode, date: o.createdAt, source: 'Shopify · ' + (o.name || 'order') });
}

// Check what the member pasted, and how far back Shopify will let us read.
async function verify(input, { fetchImpl = fetch } = {}) {
  const t = await token(fetchImpl, input.shop, input.clientId, input.secret);
  if (t.error) return { ok: false, error: t.error };
  return { ok: true, allOrders: t.scopes.includes('read_all_orders') };
}

// ------------------------------------------------------ "Connect Shopify"
// NoBossly's own public Shopify app (SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
// redirect URI https://nobossly.com/budget/connect/shopify/callback). The
// member enters their store and approves read_orders on Shopify; NoBossly
// gets an expiring offline token (an hour) and a refresh token (90 days,
// rotated on each use). Until the app is set up, pasting a Dev Dashboard
// app's ID and secret (above) still works.
const configured = () => !!(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
const SCOPES = () => (process.env.SHOPIFY_ALL_ORDERS === '1' ? 'read_orders,read_all_orders' : 'read_orders');

function authUrl(shop, state) {
  return 'https://' + shop + '/admin/oauth/authorize?' + form({ client_id: process.env.SHOPIFY_CLIENT_ID, scope: SCOPES(), redirect_uri: redirectUri('shopify'), state });
}

// Shopify signs the way back: every parameter but hmac, sorted, HMAC-SHA256 with the app secret.
function validCallback(query, secret = process.env.SHOPIFY_CLIENT_SECRET) {
  if (!query || !query.hmac || !secret) return false;
  const msg = Object.keys(query).filter(k => k !== 'hmac' && k !== 'signature').sort()
    .map(k => k + '=' + (Array.isArray(query[k]) ? query[k].join(',') : query[k])).join('&');
  const want = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  const got = String(query.hmac);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function checkScopes(scopeText) {
  const scopes = String(scopeText || '').split(',').map(x => x.trim()).filter(Boolean);
  if (scopes.some(x => /^write_/.test(x))) return { error: 'Shopify granted more than read access. Try connecting again.' };
  if (!scopes.includes('read_orders')) return { error: 'Shopify did not grant access to orders. Try connecting again.' };
  return { scopes };
}

async function exchange(shop, code, { fetchImpl = fetch, now = Date.now() } = {}) {
  const r = await call(fetchImpl, 'https://' + shop + '/admin/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form({ client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET, code, expiring: 1 })
  });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: 'Shopify did not let NoBossly in. Try connecting again.' };
  const sc = checkScopes(r.body.scope);
  if (sc.error) return sc;
  return { secret: oauthSecret(r.body, now), allOrders: sc.scopes.includes('read_all_orders') };
}
const oauthSecret = (b, now) => ({ mode: 'oauth', access_token: b.access_token, refresh_token: b.refresh_token || null,
  expires_at: b.expires_in ? now + (Number(b.expires_in) - 120) * 1000 : null, scope: b.scope || '' });

// A usable token for an OAuth connection, refreshing (and saving the rotated
// refresh token) when it has run out.
async function oauthToken(sc, conn, s, { fetchImpl, now }) {
  if (!s.expires_at || now.getTime() < s.expires_at) return { token: s.access_token, scopes: String(s.scope || '').split(',') };
  if (!s.refresh_token || !configured()) return { error: 'Shopify access ran out. Connect Shopify again.' };
  const r = await call(fetchImpl, 'https://' + conn.meta.shop + '/admin/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form({ client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: s.refresh_token })
  });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: 'Shopify access ran out or was removed. Connect Shopify again.' };
  const fresh = oauthSecret(Object.assign({ scope: s.scope }, r.body), now.getTime());
  await store(sc, conn.user_id, 'shopify', fresh, conn.account_label || conn.meta.shop, conn.meta);
  return { token: fresh.access_token, scopes: String(fresh.scope || '').split(',') };
}

async function sync(sc, conn, { fetchImpl = fetch, now = new Date() } = {}) {
  const raw = await secretOf(sc, conn);
  let s = null;
  try { s = JSON.parse(raw); } catch (_) { /* unreadable */ }
  const shop = (conn.meta && conn.meta.shop) || null;
  if (!s || !shop) return fail(sc, conn, 'The connection could not be read. Disconnect and connect Shopify again.', now);
  const t = s.mode === 'oauth' ? await oauthToken(sc, conn, s, { fetchImpl, now }) : await token(fetchImpl, shop, s.client_id, s.client_secret);
  if (t.error) return fail(sc, conn, t.error, now);
  let since = sinceOf(conn, now);
  if (!t.scopes.includes('read_all_orders')) since = new Date(Math.max(since.getTime(), now.getTime() - 59 * 86400000));
  const got = await ordersSince(fetchImpl, shop, t.token, since);
  if (got.error && !got.orders.length) return fail(sc, conn, got.error, now);
  const rows = got.orders.map(o => rowOf(conn.user_id, o)).filter(Boolean);
  return saveIncome(sc, conn, rows, { now, through: got.error ? null : now, error: got.error || null, provider: 'Shopify' });
}

// Shopify's required privacy webhooks for a public app (customers/data_request,
// customers/redact, shop/redact), all sent here. NoBossly keeps no customer
// data from Shopify (only order totals and order numbers in the member's own
// income log), so there is nothing to send or erase for a customer; when a
// store is erased, its connection is marked removed. Signed with the app
// secret over the raw body; anything unsigned gets a 401.
function validWebhook(raw, header, secret = process.env.SHOPIFY_CLIENT_SECRET) {
  if (!secret || !header || !Buffer.isBuffer(raw)) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const got = String(header);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
async function webhook(req, res, { service } = {}) {
  if (!validWebhook(req.body, req.get('X-Shopify-Hmac-Sha256'))) return res.status(401).send('unauthorized');
  const topic = String(req.get('X-Shopify-Topic') || '');
  if (topic === 'shop/redact') {
    let shop = null;
    try { shop = cleanShop(JSON.parse(req.body.toString('utf8')).shop_domain); } catch (_) { shop = null; }
    const sc = service && service();
    if (shop && sc) await sc.from('payment_connections').update({ status: 'error', last_error: 'NoBossly was removed from this Shopify store. Connect again to keep syncing.' }).eq('provider', 'shopify').eq('account_label', shop);
  }
  res.status(200).send('ok');
}

module.exports = { validWebhook, webhook, API_VERSION, cleanShop, checkInput, token, ordersSince, rowOf, verify, sync, explain, configured, authUrl, validCallback, checkScopes, exchange, oauthSecret };
