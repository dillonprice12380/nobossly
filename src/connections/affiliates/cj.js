// CJ (Commission Junction) → income log. The member makes a Personal Access
// Token at developers.cj.com and pastes it with their publisher ID (CID).
// Commissions come from the Commission Detail API (GraphQL), a month at a
// time. CJ reports a return as a separate negative record, so records are
// netted per order.

const { call } = require('../common');
const A = require('../affiliate_common');

const URL = 'https://commissions.api.cj.com/query';
const WINDOW_DAYS = 30;

const network = {
  key: 'cj', label: 'CJ', emoji: '🔗',
  blurb: 'Commissions from CJ (Commission Junction) advertisers.',
  fields: [
    { name: 'cid', label: 'Publisher ID (CID)', placeholder: '1234567', help: 'Your account number, top right in the CJ dashboard.' },
    { name: 'token', label: 'Personal Access Token', secret: true }
  ],
  where: [
    'Sign in at developers.cj.com with your CJ publisher login.',
    'Open Authentication → Personal Access Tokens, create one named NoBossly and copy it.',
    'Your publisher ID (CID) is the account number at the top right of the CJ dashboard.'
  ]
};

function checkInput(body) {
  const cid = String((body && body.cid) || '').trim();
  const token = String((body && body.token) || '').trim();
  if (!/^\d{4,10}$/.test(cid)) return { error: 'Enter your CJ publisher ID (CID): the number at the top right of the CJ dashboard.' };
  if (!/^[A-Za-z0-9_.-]{16,200}$/.test(token)) return { error: 'Paste the Personal Access Token from developers.cj.com.' };
  return { secret: { cid, token }, label: 'CID ' + cid };
}

const query = (cid, a, b) => `{ publisherCommissions(forPublishers: ["${cid}"], sincePostingDate: "${a.toISOString().slice(0, 19)}Z", beforePostingDate: "${b.toISOString().slice(0, 19)}Z") {
  count payloadComplete records { commissionId orderId actionStatus advertiserId advertiserName eventDate postingDate pubCommissionAmountUsd } } }`;

function itemOf(r) {
  const st = String(r.actionStatus || '').toLowerCase();
  return {
    id: r.commissionId, order: r.advertiserId + ':' + (r.orderId || r.commissionId), amount: r.pubCommissionAmountUsd, currency: 'USD',
    date: String(r.eventDate || r.postingDate || '').slice(0, 10),
    // New and extended commissions are still within the advertiser's lock period.
    state: st === 'locked' || st === 'closed' ? 'approved' : st === 'new' || st === 'extended' ? 'pending' : st === 'corrected' ? 'approved' : null,
    advertiser: r.advertiserName || null
  };
}

async function ask(secret, a, b, fetchImpl) {
  const r = await call(fetchImpl, URL, { method: 'POST', headers: { Authorization: 'Bearer ' + secret.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query: query(secret.cid, a, b) }) });
  const pc = r.body && r.body.data && r.body.data.publisherCommissions;
  if (r.status !== 200 || !pc) {
    const msg = r.body && JSON.stringify(r.body.errors || '');
    return { error: /not authori|unauthori|forbidden|access/i.test(msg || '') ? A.refused(network.label, 401) : A.refused(network.label, r.status) };
  }
  return { records: pc.records || [], complete: pc.payloadComplete !== false };
}

async function fetchCommissions(secret, meta, { since, now, fetchImpl }) {
  const raw = [];
  const read = async (a, b, depth) => {
    const r = await ask(secret, a, b, fetchImpl);
    if (r.error) return r.error;
    if (!r.complete && depth < 4) {
      const mid = new Date((a.getTime() + b.getTime()) / 2);
      return (await read(a, mid, depth + 1)) || (await read(mid, b, depth + 1));
    }
    raw.push(...r.records);
    return null;
  };
  for (const [a, b] of A.windows(since, now, WINDOW_DAYS)) {
    const err = await read(a, b, 0);
    if (err) return { items: A.netted(raw.map(itemOf), i => i.order), complete: false, error: err };
  }
  return { items: A.netted(raw.map(itemOf), i => i.order), complete: true };
}

async function verify(secret, { fetchImpl = fetch, now = new Date() } = {}) {
  const r = await ask(secret, new Date(now.getTime() - 86400000), now, fetchImpl);
  return r.error ? { ok: false, error: r.error } : { ok: true };
}

module.exports = { network, checkInput, verify, fetchCommissions, itemOf, query };
