// Admitad → income log. The member pastes their API client ID and secret
// (Settings → API in Admitad). NoBossly asks only for the "statistics"
// scope, which can read and nothing else, and reads actions from it.

const { call, form } = require('../common');
const A = require('../affiliate_common');

const BASE = 'https://api.admitad.com';
const LIMIT = 500, MAX_PAGES = 40;

const network = {
  key: 'admitad', label: 'Admitad', emoji: '🌍',
  blurb: 'Commissions from Admitad (Mitgo) programs.',
  fields: [
    { name: 'client_id', label: 'Client ID' },
    { name: 'client_secret', label: 'Client secret', secret: true }
  ],
  where: [
    'In Admitad, open Settings → API (or "Show credentials").',
    'Copy the Client ID and Client secret. NoBossly asks Admitad only for statistics, which is read-only.'
  ]
};

function checkInput(body) {
  const id = String((body && body.client_id) || '').trim();
  const secret = String((body && body.client_secret) || '').trim();
  if (!/^[A-Za-z0-9]{10,80}$/.test(id)) return { error: 'Paste the Client ID from Settings → API in Admitad.' };
  if (!/^[A-Za-z0-9]{10,80}$/.test(secret)) return { error: 'Paste the Client secret from the same page.' };
  return { secret: { client_id: id, client_secret: secret }, label: 'Admitad account' };
}

async function token(s, fetchImpl) {
  const r = await call(fetchImpl, BASE + '/token/', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(s.client_id + ':' + s.client_secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form({ grant_type: 'client_credentials', client_id: s.client_id, scope: 'statistics' })
  });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: A.refused(network.label, r.status === 400 ? 401 : r.status) };
  return { token: r.body.access_token };
}

const dmy = d => [String(d.getUTCDate()).padStart(2, '0'), String(d.getUTCMonth() + 1).padStart(2, '0'), d.getUTCFullYear()].join('.');

function itemOf(x) {
  const st = String(x.status || '').toLowerCase();
  return {
    id: x.action_id || x.id, amount: x.payment, currency: x.currency, date: String(x.action_date || x.click_date || '').slice(0, 10),
    // "approved_but_stalled": approved, but the advertiser has not paid Admitad yet.
    state: st === 'approved' ? 'approved' : st === 'pending' || st === 'approved_but_stalled' ? 'pending' : st === 'declined' ? 'reversed' : null,
    advertiser: x.advcampaign_name || null
  };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const t = await token(secret, fetchImpl);
  if (t.error) return { items: [], complete: false, error: t.error };
  const items = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = BASE + '/statistics/actions/?date_start=' + dmy(since) + '&date_end=' + dmy(now) + '&limit=' + LIMIT + '&offset=' + page * LIMIT;
    const r = await call(fetchImpl, url, { headers: { Authorization: 'Bearer ' + t.token, Accept: 'application/json' } });
    if (r.status !== 200 || !r.body) return { items, complete: false, error: A.refused(network.label, r.status) };
    const list = Array.isArray(r.body.results) ? r.body.results : [];
    list.forEach(x => items.push(itemOf(x)));
    const total = r.body._meta && Number(r.body._meta.count);
    if (list.length < LIMIT || (total && (page + 1) * LIMIT >= total)) return { items, complete: true };
  }
  return { items, complete: true };
}

async function verify(secret, { fetchImpl = fetch } = {}) {
  const t = await token(secret, fetchImpl);
  return t.error ? { ok: false, error: t.error } : { ok: true };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemOf, dmy };
