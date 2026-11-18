// Travelpayouts → income log. The member pastes their API token (Profile →
// API token). Actions that affect their balance are read in US dollars:
// paid ones come in as income, processing ones count as pending, cancelled
// ones are taken back out.

const { call } = require('../common');
const A = require('../affiliate_common');

const BASE = 'https://api.travelpayouts.com/finance/v2/';
const LIMIT = 300, MAX_PAGES = 40;

const network = {
  key: 'travelpayouts', label: 'Travelpayouts', emoji: '✈️',
  blurb: 'Travel commissions: flights, hotels, tours and more.',
  fields: [{ name: 'token', label: 'API token', secret: true }],
  where: [
    'In Travelpayouts, open your profile → API token.',
    'Copy the token. Travelpayouts has one token per account; NoBossly only uses it to read your actions and balance.'
  ]
};

function checkInput(body) {
  const token = String((body && body.token) || '').trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(token)) return { error: 'Paste the API token from your Travelpayouts profile.' };
  return { secret: { token }, label: 'Travelpayouts account' };
}

const headers = s => ({ 'X-Access-Token': s.token, Accept: 'application/json' });
// The list may come bare or wrapped; take the first array found.
const listOf = b => (Array.isArray(b) ? b : b && typeof b === 'object' ? (Object.values(b).find(Array.isArray) || (b.data && typeof b.data === 'object' ? listOf(b.data) : [])) : []);

function itemOf(a) {
  const st = String(a.action_state || a.state || '').toLowerCase();
  return {
    id: a.action_id, amount: a.profit, currency: 'USD', date: String(a.created_at || a.updated_at || '').slice(0, 10),
    state: st === 'paid' ? 'approved' : st === 'processing' ? 'pending' : st === 'cancelled' || st === 'canceled' ? 'reversed' : null,
    advertiser: a.campaign_name || (a.campaign_id ? 'program ' + a.campaign_id : null)
  };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const items = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = BASE + 'get_user_actions_affecting_balance?currency=usd&from=' + A.ymd(since) + '&until=' + A.ymd(now) + '&limit=' + LIMIT + '&offset=' + page * LIMIT;
    const r = await call(fetchImpl, url, { headers: headers(secret) });
    if (r.status !== 200 || !r.body) return { items, complete: false, error: A.refused(network.label, r.status) };
    const list = listOf(r.body);
    list.forEach(x => items.push(itemOf(x)));
    if (list.length < LIMIT) return { items, complete: true };
  }
  return { items, complete: true };
}

async function verify(secret, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, BASE + 'get_user_balance', { headers: headers(secret) });
  if (r.status !== 200) return { ok: false, error: A.refused(network.label, r.status) };
  return { ok: true };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemOf, listOf };
