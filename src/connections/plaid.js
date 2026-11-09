// Banks → the bank inbox, through Plaid (migrations/2026-11-09_more_connections.sql).
// Needs NoBossly's Plaid keys: PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV
// (sandbox while testing, production once Plaid has approved NoBossly).
// PLAID_REDIRECT_URI is optional (some banks' own log-in screens need it).
//
// A bank account mixes business and personal money, so nothing from it is
// logged on its own. Posted transactions land in bank_transactions; the member
// marks each one income, expense or not business (src/routes/budget.js).
// Pending ones wait until they post (their id changes when they do), and
// transfers between the member's own accounts arrive already set aside.

const { call } = require('./common');

const MAX_PAGES = 40;
const base = () => (process.env.PLAID_ENV === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com');
const configured = () => !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
const keys = () => ({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET });

async function post(fetchImpl, path, body) {
  return call(fetchImpl, base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign(keys(), body)) });
}

const explain = (status, body) => {
  const code = (body && body.error_code) || '';
  if (code === 'ITEM_LOGIN_REQUIRED') return 'Your bank wants you to log in again. Reconnect the bank to keep it syncing.';
  if (code === 'INSTITUTION_DOWN' || code === 'INSTITUTION_NOT_RESPONDING') return 'Your bank is not answering right now. We will try again later.';
  if (code === 'RATE_LIMIT_EXCEEDED' || status === 429) return 'The bank connection asked us to slow down. We will try again shortly.';
  if (code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN') return 'This bank connection is no longer valid. Disconnect it and connect the bank again.';
  return 'The bank connection did not answer properly (' + (code || status || 'no response') + '). We will try again later.';
};

// A short-lived token that opens Plaid's "connect your bank" window.
async function linkToken(userId, { fetchImpl = fetch } = {}) {
  const body = {
    client_name: 'NoBossly', user: { client_user_id: String(userId) }, products: ['transactions'],
    country_codes: ['US'], language: 'en', transactions: { days_requested: 365 }
  };
  if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;
  const r = await post(fetchImpl, '/link/token/create', body);
  if (r.status !== 200 || !r.body || !r.body.link_token) return { error: explain(r.status, r.body) };
  return { token: r.body.link_token };
}

// What Link handed back → a stored access token.
async function exchange(publicToken, { fetchImpl = fetch } = {}) {
  if (!/^public-[a-z]+-[A-Za-z0-9-]{8,200}$/.test(String(publicToken || ''))) return { error: 'That did not come back from the bank properly. Try again.' };
  const r = await post(fetchImpl, '/item/public_token/exchange', { public_token: publicToken });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: explain(r.status, r.body) };
  return { accessToken: r.body.access_token, itemId: r.body.item_id };
}

async function removeItem(accessToken, { fetchImpl = fetch } = {}) {
  const r = await post(fetchImpl, '/item/remove', { access_token: accessToken });
  return r.status === 200;
}

// The account names and last four digits Link showed, kept for the page.
function accountsOf(meta) {
  return ((meta && meta.accounts) || []).slice(0, 12).map(a => ({
    name: String(a.name || a.subtype || 'Account').slice(0, 60), mask: String(a.mask || '').replace(/\D/g, '').slice(-4)
  }));
}

const TRANSFER = /^(TRANSFER_IN|TRANSFER_OUT|LOAN_PAYMENTS|BANK_FEES_OVERDRAFT)$/;
const titleCase = s => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// A Plaid transaction → a bank_transactions row, or null while it is pending.
// Plaid counts money leaving the account as positive.
function rowOf(userId, connId, t, accounts) {
  if (!t || t.pending || !t.transaction_id) return null;
  const amt = Number(t.amount);
  if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 1e8) return null;
  const pfc = t.personal_finance_category || {};
  const acct = accounts[t.account_id];
  return {
    user_id: userId, connection_id: connId, external_id: 'plaid:' + String(t.transaction_id).slice(0, 110),
    posted_on: String(t.date || t.authorized_date).slice(0, 10), amount: Math.round(Math.abs(amt) * 100) / 100,
    direction: amt > 0 ? 'out' : 'in',
    name: String(t.name || '').slice(0, 200) || null, merchant: String(t.merchant_name || '').slice(0, 120) || null,
    category: pfc.primary ? titleCase(pfc.primary).slice(0, 80) : null,
    account_label: acct ? (acct.name + (acct.mask ? ' ··' + acct.mask : '')).slice(0, 80) : null,
    pending: false,
    _transfer: TRANSFER.test(pfc.primary || '')
  };
}

/**
 * Sync one bank: everything since its cursor into the inbox. New transfers
 * arrive set aside; changes update what was waiting; removals delete what was
 * still waiting (decided ones stay as the member decided).
 */
async function sync(sc, conn, { fetchImpl = fetch, now = new Date() } = {}) {
  const failWith = async error => {
    await sc.from('bank_connections').update({ status: 'error', last_error: String(error).slice(0, 300), last_synced_at: now.toISOString() }).eq('id', conn.id);
    return { added: 0, error };
  };
  const { data: tok } = await sc.rpc('bank_connection_secret', { p_id: conn.id });
  if (!tok) return failWith('The bank connection could not be read. Disconnect it and connect the bank again.');
  const start = conn.sync_cursor || null;
  let cursor = start, added = [], removed = [], accounts = {}, restarts = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await post(fetchImpl, '/transactions/sync', Object.assign({ access_token: tok, count: 500 }, cursor ? { cursor } : {}));
    if (r.status !== 200 || !r.body) {
      // Plaid asks for a restart when data changed while paging.
      if (r.body && r.body.error_code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && restarts++ < 2) { cursor = start; added = []; removed = []; page = -1; continue; }
      return failWith(explain(r.status, r.body));
    }
    (r.body.accounts || []).forEach(a => { accounts[a.account_id] = { name: a.name || a.official_name || titleCase(a.subtype), mask: a.mask || '' }; });
    added.push(...(r.body.added || []), ...(r.body.modified || []));
    removed.push(...(r.body.removed || []).map(x => 'plaid:' + x.transaction_id));
    cursor = r.body.next_cursor;
    if (!r.body.has_more) break;
  }
  const rows = added.map(t => rowOf(conn.user_id, conn.id, t, accounts)).filter(Boolean);
  // New transfers between their own accounts start set aside. An existing row
  // keeps the status the member gave it (status is not in the update).
  const transfers = new Set(rows.filter(r => r._transfer).map(r => r.external_id));
  const clean = rows.map(({ _transfer, ...r }) => r);
  let saved = 0;
  for (let i = 0; i < clean.length; i += 500) {
    const { data, error } = await sc.from('bank_transactions').upsert(clean.slice(i, i + 500), { onConflict: 'user_id,external_id' }).select('id, external_id, status, decided_at');
    if (error) return failWith('Could not save what came from the bank. We will try again later.');
    saved += (data || []).length;
    const setAside = (data || []).filter(d => transfers.has(d.external_id) && d.status === 'new' && !d.decided_at).map(d => d.id);
    if (setAside.length) await sc.from('bank_transactions').update({ status: 'ignored' }).in('id', setAside);
  }
  for (let i = 0; i < removed.length; i += 200) {
    await sc.from('bank_transactions').delete().eq('user_id', conn.user_id).eq('status', 'new').in('external_id', removed.slice(i, i + 200));
  }
  await sc.from('bank_connections').update({ sync_cursor: cursor, status: 'active', last_error: null, last_synced_at: now.toISOString() }).eq('id', conn.id);
  return { added: saved, removed: removed.length, error: null };
}

module.exports = { configured, base, linkToken, exchange, removeItem, accountsOf, rowOf, sync, explain };
