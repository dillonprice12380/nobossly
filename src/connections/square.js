// Square → income log, through "Connect Square" (OAuth) with PAYMENTS_READ and
// MERCHANT_PROFILE_READ only. Needs NoBossly's own Square application:
// SQUARE_APP_ID and SQUARE_APP_SECRET (and SQUARE_ENV=sandbox while testing),
// with the redirect URL https://nobossly.com/budget/connect/square/callback.
//
// Access tokens last 30 days; each sync renews one that ends within a week,
// and stores the new token pair. Completed payments come in as income, net of
// refunds.

const { call, form, secretOf, store, fail, saveIncome, incomeRow, sinceOf, redirectUri } = require('./common');

const VERSION = '2025-10-16';
const SCOPES = ['PAYMENTS_READ', 'MERCHANT_PROFILE_READ'];
const MAX_PAGES = 50;
const base = () => (process.env.SQUARE_ENV === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com');
const configured = () => !!(process.env.SQUARE_APP_ID && process.env.SQUARE_APP_SECRET);

function authUrl(state) {
  return base() + '/oauth2/authorize?' + form({ client_id: process.env.SQUARE_APP_ID, scope: SCOPES.join(' '), session: 'false', state, redirect_uri: redirectUri('square') });
}

async function tokenCall(fetchImpl, body) {
  const r = await call(fetchImpl, base() + '/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Square-Version': VERSION },
    body: JSON.stringify(Object.assign({ client_id: process.env.SQUARE_APP_ID, client_secret: process.env.SQUARE_APP_SECRET }, body))
  });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: r.status === 401 || r.status === 400 ? 'Square did not let NoBossly in. Connect Square again.' : 'Square did not answer properly (' + (r.status || 'no response') + '). Try again later.' };
  return { secret: { access_token: r.body.access_token, refresh_token: r.body.refresh_token || null, expires_at: r.body.expires_at || null }, merchantId: r.body.merchant_id || null };
}
const exchange = (code, { fetchImpl = fetch } = {}) => tokenCall(fetchImpl, { grant_type: 'authorization_code', code, redirect_uri: redirectUri('square') });

const headers = tok => ({ Authorization: 'Bearer ' + tok, 'Square-Version': VERSION, Accept: 'application/json' });

async function merchantName(fetchImpl, tok) {
  const r = await call(fetchImpl, base() + '/v2/merchants/me', { headers: headers(tok) });
  return (r.body && r.body.merchant && r.body.merchant.business_name) || null;
}

const explain = status => (status === 401 ? 'Square says NoBossly is not allowed in any more (the connection may have been removed in Square). Connect again.'
  : status === 403 ? 'NoBossly cannot read payments in this Square account. Connect again and allow it.'
  : status === 429 ? 'Square asked us to slow down. We will try again shortly.'
  : 'Square did not answer properly (' + (status || 'no response') + '). We will try again later.');

async function paymentsSince(fetchImpl, tok, since, now) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = { begin_time: since.toISOString(), end_time: now.toISOString(), sort_order: 'DESC', limit: 100 };
    if (cursor) q.cursor = cursor;
    const r = await call(fetchImpl, base() + '/v2/payments?' + form(q), { headers: headers(tok) });
    if (r.status !== 200 || !r.body) return { error: explain(r.status), payments: out };
    out.push(...(r.body.payments || []));
    if (!r.body.cursor) break;
    cursor = r.body.cursor;
  }
  return { payments: out };
}

function rowOf(userId, p) {
  if (!p || p.status !== 'COMPLETED' || !p.amount_money) return null;
  const minor = (Number(p.amount_money.amount) || 0) - (Number(p.refunded_money && p.refunded_money.amount) || 0);
  const zeroDecimal = /^(JPY|KRW)$/i.test(p.amount_money.currency || '');
  return incomeRow(userId, {
    id: 'square:' + p.id, amount: zeroDecimal ? minor : minor / 100, currency: p.amount_money.currency,
    date: p.created_at, source: 'Square' + (p.source_type === 'CARD' && p.card_details && p.card_details.entry_method === 'KEYED' ? ' · keyed card' : ''),
    description: p.note || null
  });
}

async function sync(sc, conn, { fetchImpl = fetch, now = new Date() } = {}) {
  let s = null;
  try { s = JSON.parse(await secretOf(sc, conn)); } catch (_) { /* unreadable */ }
  if (!s || !s.access_token) return fail(sc, conn, 'The connection could not be read. Disconnect and connect Square again.', now);
  // Renew a token that ends within a week.
  if (s.refresh_token && s.expires_at && new Date(s.expires_at) - now < 7 * 86400000) {
    const t = await tokenCall(fetchImpl, { grant_type: 'refresh_token', refresh_token: s.refresh_token });
    if (t.error) return fail(sc, conn, t.error, now);
    s = Object.assign({}, t.secret, { refresh_token: t.secret.refresh_token || s.refresh_token });
    await store(sc, conn.user_id, 'square', s, conn.account_label, conn.meta);
  }
  const got = await paymentsSince(fetchImpl, s.access_token, sinceOf(conn, now), now);
  if (got.error && !got.payments.length) return fail(sc, conn, got.error, now);
  const rows = got.payments.map(p => rowOf(conn.user_id, p)).filter(Boolean);
  return saveIncome(sc, conn, rows, { now, through: got.error ? null : now, error: got.error || null, provider: 'Square' });
}

module.exports = { VERSION, SCOPES, configured, authUrl, exchange, tokenCall, merchantName, paymentsSince, rowOf, sync };
