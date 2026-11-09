// Shopify → income log. The member makes their own app in Shopify's Dev
// Dashboard with read-only access to orders, installs it on their store and
// pastes its client ID and secret. NoBossly swaps those for a 24-hour access
// token each time it syncs (the client credentials grant), so what it holds
// can only read orders. Paid orders come in as income, net of refunds.
//
// Without the read_all_orders scope Shopify only shows the last 60 days; the
// connect page says so.

const { call, form, secretOf, fail, saveIncome, incomeRow, sinceOf } = require('./common');

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

async function sync(sc, conn, { fetchImpl = fetch, now = new Date() } = {}) {
  const raw = await secretOf(sc, conn);
  let s = null;
  try { s = JSON.parse(raw); } catch (_) { /* unreadable */ }
  const shop = (conn.meta && conn.meta.shop) || null;
  if (!s || !shop) return fail(sc, conn, 'The connection could not be read. Disconnect and connect Shopify again.', now);
  const t = await token(fetchImpl, shop, s.client_id, s.client_secret);
  if (t.error) return fail(sc, conn, t.error, now);
  let since = sinceOf(conn, now);
  if (!t.scopes.includes('read_all_orders')) since = new Date(Math.max(since.getTime(), now.getTime() - 59 * 86400000));
  const got = await ordersSince(fetchImpl, shop, t.token, since);
  if (got.error && !got.orders.length) return fail(sc, conn, got.error, now);
  const rows = got.orders.map(o => rowOf(conn.user_id, o)).filter(Boolean);
  return saveIncome(sc, conn, rows, { now, through: got.error ? null : now, error: got.error || null, provider: 'Shopify' });
}

module.exports = { API_VERSION, cleanShop, checkInput, token, ordersSince, rowOf, verify, sync, explain };
