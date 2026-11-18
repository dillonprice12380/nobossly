// ClickBank → income log. The member creates an API key with only the
// "API Order Read" role (read-only) in their ClickBank account and pastes it.
// Affiliate orders come from the Orders API: sales and rebills are income,
// refunds and chargebacks take the sale back out.

const { call } = require('../common');
const A = require('../affiliate_common');

const BASE = 'https://api.clickbank.com/rest/1.3/orders2/list';
const WINDOW_DAYS = 31, MAX_PAGES = 50;

const network = {
  key: 'clickbank', label: 'ClickBank', emoji: '🏦',
  blurb: 'Affiliate sales and rebills from ClickBank products.',
  fields: [{ name: 'key', label: 'API key', placeholder: 'API-…', secret: true }],
  where: [
    'In ClickBank, open Settings → API keys (in your main account).',
    'Create a key with only the API Order Read role, so it can read and nothing else.',
    'Copy the key; it starts with API-.'
  ]
};

function checkInput(body) {
  const key = String((body && body.key) || '').trim();
  if (!/^API-[A-Za-z0-9]{10,80}$/.test(key)) return { error: 'Paste the ClickBank API key. It starts with API-.' };
  return { secret: { key }, label: 'ClickBank account' };
}

const headers = s => ({ Authorization: s.key, Accept: 'application/json' });
const listOf = b => {
  if (!b) return [];
  if (Array.isArray(b)) return b;
  const d = b.orderData || b.orders || b.data;
  return Array.isArray(d) ? d : d && typeof d === 'object' ? [d] : [];
};
const money = v => (v && typeof v === 'object' ? Number(v.amount != null ? v.amount : v.value) : Number(v));

function itemOf(o) {
  const type = String(o.transactionType || o.txnType || '').toUpperCase();
  const amount = Math.abs(money(o.totalAccountAmount != null ? o.totalAccountAmount : o.accountAmount));
  const receipt = String(o.receipt || o.receiptNo || '').split('-')[0];
  return {
    id: receipt, amount, currency: o.currency || 'USD', date: String(o.transactionTime || o.date || '').slice(0, 10),
    state: type === 'SALE' || type === 'BILL' ? 'approved' : type === 'RFND' || type === 'CGBK' ? 'reversed' : null,
    advertiser: o.vendor || null,
    // A rebill has its own receipt suffix; keep it distinct from the first sale.
    raw: o.receipt
  };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const items = [];
  for (const [a, b] of A.windows(since, now, WINDOW_DAYS)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await call(fetchImpl, BASE + '?role=AFFILIATE&startDate=' + A.ymd(a) + '&endDate=' + A.ymd(b), { headers: Object.assign({ Page: String(page) }, headers(secret)) });
      if ((r.status !== 200 && r.status !== 206) || !r.body) return { items, complete: false, error: A.refused(network.label, r.status) };
      listOf(r.body).forEach(o => { const it = itemOf(o); if (it.state === 'approved' && o.receipt) it.id = String(o.receipt); items.push(it); });
      if (r.status !== 206) break;
    }
  }
  return { items, complete: true };
}

async function verify(secret, { fetchImpl = fetch, now = new Date() } = {}) {
  const r = await call(fetchImpl, BASE + '?role=AFFILIATE&startDate=' + A.ymd(new Date(now.getTime() - 86400000)) + '&endDate=' + A.ymd(now), { headers: headers(secret) });
  if (r.status !== 200 && r.status !== 206 && r.status !== 204) return { ok: false, error: A.refused(network.label, r.status) };
  return { ok: true };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemOf };
