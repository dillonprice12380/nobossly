// Shared by the affiliate-network connections (src/connections/affiliates/*):
// turning a network's commissions into income-log rows.
//
// A commission is only money once the network has approved it, so:
//  * approved, locked or paid commissions come in as income;
//  * pending ones are not logged; their total is kept on the connection
//    (payment_connections.pending) so the member can see what is on the way;
//  * reversed or declined ones that were already logged are taken back out.
//
// Each network module maps its own records to { id, amount, currency, date,
// state: 'approved' | 'pending' | 'reversed', advertiser } and this does the rest.

const { fail, saveIncome, incomeRow } = require('./common');

const STATES = new Set(['approved', 'pending', 'reversed']);

function rowsOf(userId, network, items) {
  const income = [], reversed = [], pending = {};
  let pendingCount = 0;
  for (const c of items || []) {
    if (!c || !c.id || !STATES.has(c.state)) continue;
    const id = network.key + ':' + String(c.id).slice(0, 100);
    if (c.state === 'reversed') { reversed.push(id); continue; }
    const amount = Math.round(Number(c.amount) * 100) / 100;
    if (!(amount > 0)) continue;
    const cur = String(c.currency || 'USD').toUpperCase().slice(0, 3);
    if (c.state === 'pending') { pending[cur] = Math.round(((pending[cur] || 0) + amount) * 100) / 100; pendingCount++; continue; }
    const row = incomeRow(userId, {
      id, amount, currency: cur, date: c.date,
      source: network.label + (c.advertiser ? ' · ' + c.advertiser : ''),
      description: c.description || 'Affiliate commission'
    });
    if (row) income.push(row);
  }
  return { income, reversed, pending, pendingCount };
}

/**
 * Save one sync's commissions: approved ones into the income log, reversed
 * ones out of it, and the pending total onto the connection.
 * `complete` is false when the network stopped part-way (the pending total is
 * then left as it was, since it would be short).
 */
async function saveCommissions(sc, conn, network, items, { now = new Date(), complete = true, error = null } = {}) {
  const { income, reversed, pending, pendingCount } = rowsOf(conn.user_id, network, items);
  let removed = 0;
  if (reversed.length) {
    for (let i = 0; i < reversed.length; i += 200) {
      const { data } = await sc.from('revenue_entries').delete().eq('user_id', conn.user_id).in('external_id', reversed.slice(i, i + 200)).select('id');
      removed += (data || []).length;
    }
  }
  const r = await saveIncome(sc, conn, income, { now, through: complete && !error ? now : null, error, provider: network.label });
  if (complete && !error && !r.error) {
    await sc.from('payment_connections').update({ pending: { amounts: pending, count: pendingCount, as_of: now.toISOString() } }).eq('id', conn.id);
  }
  return Object.assign({}, r, { removed, pendingCount });
}

// Networks that report a return as a separate negative record (CJ, Rakuten)
// are netted per order: the order's first record keeps its id, and an order
// that nets to nothing or less counts as reversed.
function netted(items, keyOf) {
  const by = new Map();
  for (const it of items) {
    if (!it || !it.id) continue;
    const k = keyOf(it) || it.id;
    const g = by.get(k);
    if (!g) { by.set(k, Object.assign({}, it, { amount: Number(it.amount) || 0 })); continue; }
    g.amount = Math.round((g.amount + (Number(it.amount) || 0)) * 100) / 100;
    if (it.state === 'pending') g.state = 'pending';
  }
  return [...by.values()].map(g => (g.amount > 0 ? g : Object.assign(g, { state: 'reversed' })));
}

// What a network answered when it refused, in plain words.
function refused(label, status) {
  if (status === 401 || status === 403) return label + ' did not accept those details. Check them and connect again.';
  if (status === 429) return label + ' asked us to slow down. We will try again shortly.';
  if (status === 404) return label + ' could not find that account. Check the account ID.';
  return label + ' did not answer properly (' + (status || 'no response') + '). We will try again later.';
}

// How far back to read. Commissions sit pending for weeks before a network
// approves (or reverses) them, so every sync re-reads the last four months,
// not just the days since the last one; the first goes back a year.
const FIRST_DAYS = 365, REREAD_DAYS = 120;
const sinceOf = (conn, now = new Date()) => new Date(now.getTime() - (conn && conn.synced_through ? REREAD_DAYS : FIRST_DAYS) * 86400000);

// Days, as the date strings networks want.
const ymd = d => d.toISOString().slice(0, 10);
// [from, to] windows of at most `days` days, oldest first.
function windows(from, to, days) {
  const out = [];
  let a = new Date(from);
  while (a < to) {
    const b = new Date(Math.min(to.getTime(), a.getTime() + days * 86400000));
    out.push([a, b]);
    a = b;
  }
  return out;
}

module.exports = { netted, FIRST_DAYS, REREAD_DAYS, sinceOf, rowsOf, saveCommissions, refused, ymd, windows, fail };
