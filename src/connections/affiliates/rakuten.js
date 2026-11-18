// Rakuten Advertising → income log. Rakuten gives per-sale commissions only
// through its Reporting Platform, so the member saves a transaction report
// there (e.g. "Signature Activity") and pastes the report's API link, which
// carries its own reporting token. NoBossly swaps in the dates it needs and
// reads the CSV. Returns arrive as negative rows, so rows are netted per order.

const { call } = require('../common');
const A = require('../affiliate_common');
const csv = require('../../csv_import');

const HOST = 'ran-reporting.rakutenmarketing.com';

const network = {
  key: 'rakuten', label: 'Rakuten Advertising', emoji: '🛒',
  blurb: 'Commissions from Rakuten advertisers, from a saved report.',
  fields: [{ name: 'url', label: 'Report API link', placeholder: 'https://ran-reporting.rakutenmarketing.com/en/reports/…', secret: true }],
  where: [
    'In the Rakuten Advertising dashboard, open Reports and run a transaction report such as Signature Activity.',
    'Save it, then choose Get API (or Schedule → API) and copy the link it shows. The link has its own reporting token in it.',
    'Paste the link here. NoBossly changes only the dates.'
  ]
};

function cleanUrl(v) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== HOST || !/^\/[a-z]{2}\/reports\/[^/]+\/filters\/?$/i.test(u.pathname) || !u.searchParams.get('token')) return null;
  return u;
}

function checkInput(body) {
  const u = cleanUrl(body && body.url);
  if (!u) return { error: 'Paste the report API link from Rakuten. It starts with https://' + HOST + '/ and has token= in it.' };
  return { secret: { url: u.toString() }, label: 'Report ' + decodeURIComponent(u.pathname.split('/')[3]).slice(0, 40) };
}

function linkFor(secret, a, b) {
  const u = cleanUrl(secret.url);
  if (!u) return null;
  u.searchParams.set('start_date', A.ymd(a));
  u.searchParams.set('end_date', A.ymd(b));
  u.searchParams.set('include_summary', 'N');
  u.searchParams.set('date_type', 'transaction');
  if (!u.searchParams.get('tz')) u.searchParams.set('tz', 'GMT');
  return u.toString();
}

// The report's columns, found by name.
function columnsOf(head) {
  const h = head.map(x => String(x || '').trim().toLowerCase());
  const find = (...res) => { for (const re of res) { const i = h.findIndex(x => re.test(x)); if (i >= 0) return i; } return -1; };
  return {
    id: find(/^transaction id$/, /^order id$/, /transaction.?id/, /order.?id/),
    date: find(/^transaction date$/, /^process date$/, /transaction.?date/, /date/),
    amount: find(/^total commission$/, /^commissions?$/, /commission/),
    advertiser: find(/advertiser name/, /merchant name/, /^advertiser$/, /^merchant$/),
    currency: find(/^currency$/, /currency/)
  };
}

function itemsOf(text) {
  const rows = csv.parse(String(text || ''));
  if (rows.length < 2) return { items: [], ok: rows.length === 1 };
  const c = columnsOf(rows[0]);
  if (c.amount < 0 || c.date < 0) return { items: [], ok: false };
  const items = rows.slice(1).map((r, n) => {
    const amount = csv.amountOf(r[c.amount]);
    const date = csv.dateOf(r[c.date]);
    const order = c.id >= 0 && r[c.id] ? r[c.id] : null;
    return {
      id: (order || date + '-' + n) + '', order: (c.advertiser >= 0 ? r[c.advertiser] : '') + ':' + (order || date + '-' + n),
      amount, currency: c.currency >= 0 ? r[c.currency] : 'USD', date, state: 'approved',
      advertiser: c.advertiser >= 0 ? r[c.advertiser] : null
    };
  }).filter(i => i.date && i.amount !== null);
  return { items: A.netted(items, i => i.order), ok: true };
}

async function fetchText(fetchImpl, url) {
  let res;
  try { res = await fetchImpl(url, { headers: { Accept: 'text/csv' } }); } catch (_) { return { status: 0, text: '' }; }
  let text = '';
  try { text = await res.text(); } catch (_) { /* nothing */ }
  return { status: res.status, text };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const url = linkFor(secret, since, now);
  if (!url) return { items: [], complete: false, error: 'The Rakuten report link could not be read. Disconnect and paste it again.' };
  const r = await fetchText(fetchImpl, url);
  if (r.status !== 200) return { items: [], complete: false, error: A.refused(network.label, r.status) };
  const got = itemsOf(r.text);
  if (!got.ok) return { items: [], complete: false, error: 'That Rakuten report has no commission and date columns. Save a transaction report (e.g. Signature Activity) and paste its link.' };
  return { items: got.items, complete: true };
}

async function verify(secret, { fetchImpl = fetch, now = new Date() } = {}) {
  const r = await fetchText(fetchImpl, linkFor(secret, new Date(now.getTime() - 7 * 86400000), now));
  if (r.status !== 200) return { ok: false, error: A.refused(network.label, r.status) };
  if (!itemsOf(r.text).ok) return { ok: false, error: 'That Rakuten report has no commission and date columns. Save a transaction report (e.g. Signature Activity) and paste its link.' };
  return { ok: true };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemsOf, linkFor, cleanUrl };
