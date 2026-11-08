// Stripe → income log (migrations/2026-11-08_stripe_connection.sql).
//
// A member connects a read-only restricted key (rk_live_…). Every few hours,
// and when they press "Sync now", this reads their succeeded charges from
// Stripe and logs each one in revenue_entries with external_id 'stripe:ch_…',
// so a payment is never logged twice. Subscription payments are ticked
// Recurring, so they feed monthly recurring revenue.
//
// Runs with the service-role client (the key is only readable through
// payment_connection_secret(), which only the service role may call). The
// Stripe API version is pinned so the shape of a charge does not change under
// us. fetch is injectable for tests.

const API = 'https://api.stripe.com/v1';
const VERSION = '2024-06-20';
const FIRST_SYNC_DAYS = 365;      // how far back the first sync reads
const OVERLAP_SECONDS = 2 * 86400; // later syncs re-read two days, for late captures
const MAX_PAGES = 30;              // 3,000 charges a run at most
const EVERY_HOURS = 6;

// Currencies Stripe counts in whole units, not cents.
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const units = (minor, currency) => (ZERO_DECIMAL.has(String(currency || '').toLowerCase()) ? minor : minor / 100);

// Only a live restricted key is accepted (Stripe forbids asking for sk_ keys).
function checkKey(k) {
  const key = String(k || '').trim();
  if (/^sk_/.test(key)) return { error: 'That is a full secret key. Never share it: create a restricted key (it starts with rk_live_) as described below.' };
  if (/^rk_test_/.test(key)) return { error: 'That is a test-mode key. Test payments are not real income; create the key in live mode.' };
  if (/^pk_/.test(key)) return { error: 'That is a publishable key. Create a restricted key (it starts with rk_live_).' };
  if (!/^rk_live_[A-Za-z0-9]{20,200}$/.test(key)) return { error: 'A restricted key starts with rk_live_. Copy the whole key from Stripe and paste it here.' };
  return { key };
}

// Why Stripe refused, in words a member can act on.
function explain(status, body) {
  const msg = (body && body.error && body.error.message) || '';
  if (status === 401) return 'Stripe says this key is not valid any more (it may have been deleted or rolled). Paste a new one.';
  if (status === 403) return 'This key cannot read ' + (/invoice/i.test(msg) ? 'invoices' : 'charges') + '. In Stripe, edit the key and set Charges and Invoices to Read.';
  if (status === 429) return 'Stripe asked us to slow down. We will try again shortly.';
  return 'Stripe did not answer properly (' + (status || 'no response') + '). We will try again later.';
}

async function stripeGet(fetchImpl, key, path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) [].concat(v).forEach(x => qs.append(k, String(x)));
  let res;
  try {
    res = await fetchImpl(API + path + (qs.toString() ? '?' + qs : ''), {
      headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': VERSION }
    });
  } catch (_) { return { status: 0, body: null }; }
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON */ }
  return { status: res.status, body };
}

// Is the key usable? One cheap read, used when a member connects.
async function verify(key, { fetchImpl = fetch } = {}) {
  const r = await stripeGet(fetchImpl, key, '/charges', { limit: 1 });
  if (r.status === 200) return { ok: true };
  return { ok: false, error: explain(r.status, r.body) };
}

// A charge → a revenue_entries row, or null when it is not money received.
function rowOf(userId, ch) {
  if (!ch || ch.object !== 'charge' || ch.status !== 'succeeded' || ch.paid === false || ch.captured === false) return null;
  const minor = (ch.amount || 0) - (ch.amount_refunded || 0);
  if (minor <= 0 || units(minor, ch.currency) > 1e8) return null;   // revenue_entries_amount_range
  const inv = ch.invoice && typeof ch.invoice === 'object' ? ch.invoice : null;
  const recurring = inv
    ? !!(inv.subscription || /^subscription/.test(inv.billing_reason || ''))
    : !!ch.invoice && /subscri/i.test(ch.description || '');
  const who = (ch.billing_details && ch.billing_details.name) || '';
  const what = String(ch.description || (inv && inv.number ? 'Invoice ' + inv.number : '') || '').replace(/\s+/g, ' ').trim();
  return {
    user_id: userId, entry_type: 'revenue', external_id: 'stripe:' + ch.id,
    amount: Math.round(units(minor, ch.currency) * 100) / 100,
    currency: String(ch.currency || 'usd').toUpperCase().slice(0, 3),
    entry_date: new Date(ch.created * 1000).toISOString().slice(0, 10),
    source: ('Stripe' + (who ? ' · ' + who : '')).slice(0, 80),
    description: what ? what.slice(0, 200) : null,
    is_recurring: recurring,
    _created: ch.created
  };
}

// Every charge since a moment, newest first, a page at a time. Tries with the
// invoice expanded (to tell subscriptions apart); a key that cannot read
// invoices still syncs, guessing from the description instead.
async function chargesSince(fetchImpl, key, sinceUnix) {
  const out = [];
  let after = null, expand = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { limit: 100, 'created[gte]': sinceUnix };
    if (expand) params['expand[]'] = 'data.invoice';
    if (after) params.starting_after = after;
    const r = await stripeGet(fetchImpl, key, '/charges', params);
    if (r.status === 403 && expand) { expand = false; page--; continue; }
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.data)) return { error: explain(r.status, r.body), charges: out };
    out.push(...r.body.data);
    if (!r.body.has_more || !r.body.data.length) break;
    after = r.body.data[r.body.data.length - 1].id;
  }
  return { charges: out, invoices: expand };
}

/**
 * Sync one connection. sc: service-role client. conn: a payment_connections
 * row. Returns { imported, skipped, error }.
 */
async function syncConnection(sc, conn, { fetchImpl = fetch, now = new Date() } = {}) {
  const fail = async error => {
    await sc.from('payment_connections').update({ status: 'error', last_error: error.slice(0, 300), last_synced_at: now.toISOString() }).eq('id', conn.id);
    return { imported: 0, skipped: 0, error };
  };
  const { data: key, error: keyErr } = await sc.rpc('payment_connection_secret', { p_id: conn.id });
  if (keyErr || !key) return fail('The key could not be read. Disconnect and connect Stripe again.');

  const nowUnix = Math.floor(now.getTime() / 1000);
  const since = conn.synced_through
    ? Math.floor(new Date(conn.synced_through).getTime() / 1000) - OVERLAP_SECONDS
    : nowUnix - FIRST_SYNC_DAYS * 86400;
  const got = await chargesSince(fetchImpl, key, since);
  if (got.error && !got.charges.length) return fail(got.error);

  const rows = got.charges.map(ch => rowOf(conn.user_id, ch)).filter(Boolean);
  // Already logged by hand or from a CSV (no external_id, same day and amount)?
  // Then it is the same payment: skip it rather than count it twice.
  let skipped = 0, fresh = rows;
  if (rows.length) {
    const first = rows.reduce((m, r) => (r.entry_date < m ? r.entry_date : m), rows[0].entry_date);
    const { data: manual } = await sc.from('revenue_entries').select('entry_date, amount, external_id')
      .eq('user_id', conn.user_id).eq('entry_type', 'revenue').gte('entry_date', first).limit(20000);
    const byHand = new Map();
    for (const m of manual || []) {
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
    const batch = fresh.slice(i, i + 500).map(({ _created, ...r }) => r);
    const { data, error } = await sc.from('revenue_entries')
      .upsert(batch, { onConflict: 'user_id,external_id', ignoreDuplicates: true }).select('id');
    if (error) return fail('Could not save the payments from Stripe. We will try again later.');
    imported += (data || []).length;
  }

  // How far we are sure we have read. Stripe lists newest first, so a run that
  // stopped partway missed the OLDER charges: keep the old mark and re-read.
  const prev = conn.synced_through ? new Date(conn.synced_through).getTime() : null;
  const newest = got.charges.reduce((m, ch) => Math.max(m, ch.created || 0), 0);
  const reached = got.error ? prev : Math.max(newest ? newest * 1000 : now.getTime(), prev || 0);
  const through = reached ? new Date(reached).toISOString() : null;
  await sc.from('payment_connections').update({
    status: got.error ? 'error' : 'active', last_error: got.error ? got.error.slice(0, 300) : null,
    last_synced_at: now.toISOString(), synced_through: through,
    imported_count: (conn.imported_count || 0) + imported
  }).eq('id', conn.id);
  return { imported, skipped, error: got.error || null, invoices: got.invoices };
}

// The background pass: every connection not synced in the last few hours.
async function runAll(sc, { fetchImpl = fetch, now = new Date(), limit = 50 } = {}) {
  const cutoff = new Date(now.getTime() - EVERY_HOURS * 3600000).toISOString();
  const { data: due, error } = await sc.from('payment_connections')
    .select('id, user_id, provider, status, last_synced_at, synced_through, imported_count')
    .eq('provider', 'stripe').or('last_synced_at.is.null,last_synced_at.lt.' + cutoff).limit(limit);
  if (error) return { skipped: 'connections not ready' };
  const out = { connections: (due || []).length, imported: 0, errors: 0 };
  for (const conn of due || []) {
    const r = await syncConnection(sc, conn, { fetchImpl, now });
    out.imported += r.imported;
    if (r.error) out.errors++;
  }
  return out;
}

module.exports = { VERSION, FIRST_SYNC_DAYS, EVERY_HOURS, checkKey, explain, verify, rowOf, chargesSince, syncConnection, runAll };
