// impact.com → income log. The member makes a read-only API token in impact.com
// (Settings → Technical → API) and pastes their Account SID and the token.
// Actions (commissions) are read through the Partner API, 45 days at a time.

const { call } = require('../common');
const A = require('../affiliate_common');

const BASE = 'https://api.impact.com/Mediapartners/';
const WINDOW_DAYS = 44;
const MAX_PAGES = 20;

const network = {
  key: 'impact', label: 'impact.com', emoji: '🤝',
  blurb: 'Commissions from brands you promote through impact.com.',
  fields: [
    { name: 'sid', label: 'Account SID', placeholder: 'IR…', help: 'At the top of the API page in impact.com.' },
    { name: 'token', label: 'Auth Token (read-only)', secret: true }
  ],
  where: [
    'In impact.com, open your profile menu → Settings → Technical → API (an Account Administrator can do this).',
    'Create an access token and give it read-only access. Older accounts have a ready-made Read Only token; use that one.',
    'Copy the Account SID and the token.'
  ]
};

function checkInput(body) {
  const sid = String((body && body.sid) || '').trim();
  const token = String((body && body.token) || '').trim();
  if (!/^[A-Za-z0-9]{10,64}$/.test(sid)) return { error: 'Paste your Account SID from the API page in impact.com.' };
  if (!/^[A-Za-z0-9_.~-]{16,200}$/.test(token)) return { error: 'Paste the Auth Token from the same page.' };
  return { secret: { sid, token }, label: 'Account ' + sid.slice(0, 6) + '…' };
}

const headers = s => ({ Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(s.sid + ':' + s.token).toString('base64') });
const iso = d => d.toISOString().slice(0, 19) + 'Z';

function itemOf(a) {
  const st = String(a.State || '').toUpperCase();
  return {
    id: a.Id, amount: a.Payout, currency: a.Currency, date: String(a.EventDate || a.CreationDate || '').slice(0, 10),
    state: st === 'APPROVED' ? 'approved' : st === 'PENDING' ? 'pending' : st === 'REVERSED' ? 'reversed' : null,
    advertiser: a.CampaignName || null
  };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const items = [];
  for (const [a, b] of A.windows(since, now, WINDOW_DAYS)) {
    let url = BASE + encodeURIComponent(secret.sid) + '/Actions?ActionDateStart=' + iso(a) + '&ActionDateEnd=' + iso(b);
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const r = await call(fetchImpl, url, { headers: headers(secret) });
      if (r.status !== 200 || !r.body) return { items, complete: false, error: A.refused(network.label, r.status) };
      (Array.isArray(r.body.Actions) ? r.body.Actions : []).forEach(x => items.push(itemOf(x)));
      const next = r.body['@nextpageuri'];
      url = next ? (/^https?:/.test(next) ? next : 'https://api.impact.com' + next) : null;
    }
  }
  return { items, complete: true };
}

async function verify(secret, { fetchImpl = fetch, now = new Date() } = {}) {
  const r = await call(fetchImpl, BASE + encodeURIComponent(secret.sid) + '/Actions?ActionDateStart=' + iso(new Date(now.getTime() - 86400000)) + '&ActionDateEnd=' + iso(now), { headers: headers(secret) });
  if (r.status !== 200) return { ok: false, error: A.refused(network.label, r.status) };
  return { ok: true };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemOf };
