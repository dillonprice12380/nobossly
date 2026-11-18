// PartnerStack → income log, for software and SaaS referral programs. The
// member makes a Partner API key (profile → API) and pastes it. Rewards are
// read newest first, back to the start of the window.

const { call } = require('../common');
const A = require('../affiliate_common');

const BASE = 'https://api.partnerstack.com/api/v2/';
const LIMIT = 250, MAX_PAGES = 40;

const network = {
  key: 'partnerstack', label: 'PartnerStack', emoji: '🧩',
  blurb: 'Referral rewards from software and SaaS programs.',
  fields: [{ name: 'key', label: 'Partner API key', secret: true }],
  where: [
    'In PartnerStack, open your profile (top right) → API.',
    'Create a key, name it NoBossly, and copy it. It is a partner key; NoBossly only uses it to read your rewards.'
  ]
};

function checkInput(body) {
  const key = String((body && body.key) || '').trim();
  if (!/^[A-Za-z0-9_.-]{16,200}$/.test(key)) return { error: 'Paste the Partner API key from your PartnerStack profile.' };
  return { secret: { key }, label: 'PartnerStack account' };
}

const headers = s => ({ Authorization: 'Bearer ' + s.key, Accept: 'application/json' });
const itemsOf = b => (b && b.data && Array.isArray(b.data.items) ? b.data.items : b && Array.isArray(b.items) ? b.items : []);
const dateOf = v => (typeof v === 'number' ? new Date(v > 1e12 ? v : v * 1000).toISOString() : String(v || '')).slice(0, 10);

function itemOf(x) {
  const st = String(x.status || x.reward_status || '').toLowerCase();
  // Amounts are in cents.
  const cents = Number(x.amount != null ? x.amount : x.commission_amount);
  const co = x.company || (x.partnership && x.partnership.company) || null;
  return {
    id: x.key || x.id, amount: isFinite(cents) ? cents / 100 : null, currency: x.currency || 'USD', date: dateOf(x.created_at),
    state: /^(approved|paid|payable|issued)$/.test(st) ? 'approved' : /^(pending|hold|on_hold|processing)$/.test(st) ? 'pending' : /^(declined|rejected|reversed|cancell?ed|void)$/.test(st) ? 'reversed' : null,
    advertiser: (co && (co.name || co.company_name)) || x.company_name || null
  };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const items = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = BASE + 'rewards?limit=' + LIMIT + '&order_by=-created_at&min_created=' + since.getTime() + (after ? '&starting_after=' + encodeURIComponent(after) : '');
    const r = await call(fetchImpl, url, { headers: headers(secret) });
    if (r.status !== 200 || !r.body) return { items, complete: false, error: A.refused(network.label, r.status) };
    const list = itemsOf(r.body);
    list.forEach(x => items.push(itemOf(x)));
    const more = r.body.data && typeof r.body.data.has_more === 'boolean' ? r.body.data.has_more : list.length === LIMIT;
    if (!more || !list.length) return { items, complete: true };
    after = list[list.length - 1].key;
    if (!after) return { items, complete: true };
  }
  return { items, complete: true };
}

async function verify(secret, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, BASE + 'rewards?limit=1', { headers: headers(secret) });
  if (r.status !== 200) return { ok: false, error: A.refused(network.label, r.status) };
  return { ok: true };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemOf };
