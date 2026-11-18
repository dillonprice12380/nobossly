// Awin → income log (ShareASale accounts moved to Awin in 2025, so this
// covers them too). The member creates an API token in Awin (API credentials)
// and pastes it. NoBossly finds their publisher account, then reads
// transactions 31 days at a time.

const { call } = require('../common');
const A = require('../affiliate_common');

const BASE = 'https://api.awin.com';
const WINDOW_DAYS = 31;

const network = {
  key: 'awin', label: 'Awin', emoji: '🅰️',
  blurb: 'Commissions from Awin advertisers, including former ShareASale ones.',
  fields: [
    { name: 'token', label: 'API token', secret: true },
    { name: 'publisher_id', label: 'Publisher ID (optional)', placeholder: '123456', help: 'Only if you have more than one Awin publisher account.' }
  ],
  where: [
    'In Awin, open your account menu → API credentials (ui.awin.com/awin-api).',
    'Enter your password to show your API token, and copy it.',
    'If you came from ShareASale, use your new Awin login.'
  ]
};

function checkInput(body) {
  const token = String((body && body.token) || '').trim();
  const pid = String((body && body.publisher_id) || '').trim();
  if (!/^[A-Za-z0-9-]{20,80}$/.test(token)) return { error: 'Paste the API token from API credentials in Awin.' };
  if (pid && !/^\d{3,10}$/.test(pid)) return { error: 'The publisher ID is a number. Leave it empty if you have one Awin account.' };
  return { secret: { token }, publisherId: pid || null };
}

const headers = s => ({ Authorization: 'Bearer ' + s.token, Accept: 'application/json' });
const day = d => d.toISOString().slice(0, 19);

function itemOf(t, names) {
  const st = String(t.commissionStatus || '').toLowerCase();
  const c = t.commissionAmount || {};
  return {
    id: t.id, amount: c.amount, currency: c.currency, date: String(t.transactionDate || '').slice(0, 10),
    state: st === 'approved' ? 'approved' : st === 'pending' ? 'pending' : st === 'declined' || st === 'deleted' ? 'reversed' : null,
    advertiser: t.advertiserName || (names && names[t.advertiserId]) || null
  };
}

// Their publisher accounts; the one they named, or the first.
async function account(secret, wanted, fetchImpl) {
  const r = await call(fetchImpl, BASE + '/accounts', { headers: headers(secret) });
  if (r.status !== 200 || !r.body) return { error: A.refused(network.label, r.status) };
  const list = (Array.isArray(r.body.accounts) ? r.body.accounts : Array.isArray(r.body) ? r.body : [])
    .filter(a => String(a.accountType || 'publisher').toLowerCase() === 'publisher');
  const pick = wanted ? list.find(a => String(a.accountId) === String(wanted)) : list[0];
  if (!pick) return { error: wanted ? 'That Awin token cannot see publisher account ' + wanted + '.' : 'That Awin token has no publisher account.' };
  return { id: String(pick.accountId), name: pick.accountName || null };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const pid = meta && meta.publisher_id;
  if (!pid) return { items: [], complete: false, error: 'The Awin account could not be read. Disconnect and connect Awin again.' };
  let names = {};
  const pr = await call(fetchImpl, BASE + '/publishers/' + pid + '/programmes?relationship=joined', { headers: headers(secret) });
  if (pr.status === 200 && Array.isArray(pr.body)) pr.body.forEach(p => { if (p && p.id) names[p.id] = p.name; });
  const items = [];
  for (const [a, b] of A.windows(since, now, WINDOW_DAYS)) {
    const url = BASE + '/publishers/' + pid + '/transactions/?startDate=' + day(a) + '&endDate=' + day(b) + '&timezone=UTC&dateType=transaction';
    const r = await call(fetchImpl, url, { headers: headers(secret) });
    if (r.status !== 200 || !Array.isArray(r.body)) return { items, complete: false, error: A.refused(network.label, r.status) };
    r.body.forEach(t => items.push(itemOf(t, names)));
  }
  return { items, complete: true };
}

async function verify(secret, { fetchImpl = fetch, publisherId = null } = {}) {
  const a = await account(secret, publisherId, fetchImpl);
  if (a.error) return { ok: false, error: a.error };
  return { ok: true, label: (a.name ? a.name + ' · ' : '') + 'publisher ' + a.id, meta: { publisher_id: a.id } };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemOf, account };
