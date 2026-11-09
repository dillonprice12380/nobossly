// Shared by the income-log connections (src/connections/*.js): calling an
// API, reading and storing a connection's secret, saving payments to the
// income log without counting one twice, and the OAuth "state" check.
//
// Everything here runs with the service-role client (sc): secrets are only
// readable through payment_connection_secret(), which only it may call.

const crypto = require('crypto');

// One HTTP call. Never throws: { status, body } with status 0 when the
// network failed and body null when the answer was not JSON.
async function call(fetchImpl, url, opts = {}) {
  let res;
  try { res = await fetchImpl(url, opts); } catch (_) { return { status: 0, body: null }; }
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON */ }
  return { status: res.status, body };
}
const form = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();

async function secretOf(sc, conn) {
  const { data, error } = await sc.rpc('payment_connection_secret', { p_id: conn.id });
  return error ? null : data || null;
}
const store = (sc, userId, provider, secret, label, meta) =>
  sc.rpc('payment_connection_store', { p_user: userId, p_provider: provider, p_secret: typeof secret === 'string' ? secret : JSON.stringify(secret), p_label: label || null, p_meta: meta || null });

async function fail(sc, conn, error, now = new Date()) {
  await sc.from('payment_connections').update({ status: 'error', last_error: String(error).slice(0, 300), last_synced_at: now.toISOString() }).eq('id', conn.id);
  return { imported: 0, skipped: 0, error };
}

/**
 * Save income rows ({ user_id, external_id, amount, entry_date, … }) for one
 * connection. A payment already logged by hand or from a CSV (no external_id,
 * same day and amount) is skipped rather than counted twice; one already
 * brought in (same external_id) is ignored by the unique constraint. Then the
 * connection's status, sync mark and count move on.
 * `through` is how far the read is complete (a Date), or null to keep the old mark.
 */
async function saveIncome(sc, conn, rows, { now = new Date(), through = now, error = null, provider = 'the service' } = {}) {
  let skipped = 0, fresh = rows;
  if (rows.length) {
    const first = rows.reduce((m, r) => (r.entry_date < m ? r.entry_date : m), rows[0].entry_date);
    const { data: logged } = await sc.from('revenue_entries').select('entry_date, amount, external_id')
      .eq('user_id', conn.user_id).eq('entry_type', 'revenue').gte('entry_date', first).limit(20000);
    const byHand = new Map();
    for (const m of logged || []) {
      if (m.external_id) continue;
      const k = String(m.entry_date).slice(0, 10) + '|' + Math.round(Number(m.amount) * 100);
      byHand.set(k, (byHand.get(k) || 0) + 1);
    }
    fresh = rows.filter(r => {
      const k = r.entry_date + '|' + Math.round(r.amount * 100);
      if (byHand.get(k)) { byHand.set(k, byHand.get(k) - 1); skipped++; return false; }
      return true;
    });
  }
  let imported = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    const { data, error: e } = await sc.from('revenue_entries')
      .upsert(fresh.slice(i, i + 500), { onConflict: 'user_id,external_id', ignoreDuplicates: true }).select('id');
    if (e) return fail(sc, conn, 'Could not save the payments from ' + provider + '. We will try again later.', now);
    imported += (data || []).length;
  }
  const prev = conn.synced_through ? new Date(conn.synced_through) : null;
  const mark = error ? prev : (through && (!prev || through > prev) ? through : prev);
  await sc.from('payment_connections').update({
    status: error ? 'error' : 'active', last_error: error ? String(error).slice(0, 300) : null,
    last_synced_at: now.toISOString(), synced_through: mark ? mark.toISOString() : null,
    imported_count: (conn.imported_count || 0) + imported
  }).eq('id', conn.id);
  return { imported, skipped, error: error || null };
}

// A payment row for the income log.
function incomeRow(userId, { id, amount, currency, date, source, description, recurring }) {
  const n = Math.round(Number(amount) * 100) / 100;
  if (!(n > 0) || n > 1e8 || !/^\d{4}-\d{2}-\d{2}/.test(String(date || ''))) return null;
  return {
    user_id: userId, entry_type: 'revenue', external_id: String(id).slice(0, 120), amount: n,
    currency: String(currency || 'USD').toUpperCase().slice(0, 3), entry_date: String(date).slice(0, 10),
    source: String(source || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
    description: description ? String(description).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null,
    is_recurring: !!recurring
  };
}

// The first read goes back a year; later ones re-read a couple of days for
// payments that settle late.
const FIRST_DAYS = 365, OVERLAP_DAYS = 2;
function sinceOf(conn, now = new Date()) {
  return conn.synced_through
    ? new Date(new Date(conn.synced_through).getTime() - OVERLAP_DAYS * 86400000)
    : new Date(now.getTime() - FIRST_DAYS * 86400000);
}

// OAuth: a random state in a short-lived cookie, checked on the way back.
const STATE_COOKIE = 'nb_oauth_state';
function newState(res, provider) {
  const state = provider + '.' + crypto.randomBytes(18).toString('base64url');
  res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 15 * 60 * 1000, path: '/budget/connect' });
  return state;
}
function checkState(req, res, provider) {
  const want = req.cookies && req.cookies[STATE_COOKIE];
  const got = String((req.query && req.query.state) || '');
  res.clearCookie(STATE_COOKIE, { path: '/budget/connect' });
  if (!want || !got || !want.startsWith(provider + '.')) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SITE = (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');
const redirectUri = provider => SITE + '/budget/connect/' + provider + '/callback';

module.exports = { call, form, secretOf, store, fail, saveIncome, incomeRow, sinceOf, newState, checkState, redirectUri, SITE, FIRST_DAYS };
