// Affiliate networks → income log. Each module (impact, travelpayouts, …)
// says what to paste, checks it, and reads commissions; this connects one,
// and syncs one, the same way for all of them. Approved commissions become
// income, pending ones a total on the connection, reversed ones come back
// out (src/connections/affiliate_common.js).

const { secretOf, fail, store } = require('../common');
const A = require('../affiliate_common');

const MODULES = ['impact', 'cj', 'awin', 'rakuten', 'partnerstack', 'clickbank', 'travelpayouts', 'admitad'].map(k => require('./' + k));
const BY = Object.fromEntries(MODULES.map(m => [m.network.key, m]));
const KEYS = Object.keys(BY);
const isNetwork = k => Object.prototype.hasOwnProperty.call(BY, k);

// Check what the member pasted with the network, then keep it in the Vault.
async function connect(sc, userId, key, body, { fetchImpl = fetch, now = new Date() } = {}) {
  const mod = BY[key];
  if (!mod) return { error: 'Unknown network.' };
  const input = mod.checkInput(body || {});
  if (input.error) return { error: input.error };
  const ok = await mod.verify(input.secret, { fetchImpl, now, publisherId: input.publisherId || null });
  if (!ok.ok) return { error: ok.error };
  const { error } = await store(sc, userId, key, input.secret, ok.label || input.label || mod.network.label, Object.assign({}, input.meta || {}, ok.meta || {}));
  return error ? { error: 'save', dbError: error } : { ok: true };
}

// After a "Connect with …" sign-in: store what the network gave, then sync.
async function connectOAuth(sc, userId, key, secret, label, meta) {
  const { error } = await store(sc, userId, key, secret, label, meta || null);
  return error ? { error: 'save', dbError: error } : { ok: true };
}

async function sync(sc, conn, { fetchImpl = fetch, now = new Date() } = {}) {
  const mod = BY[conn.provider];
  if (!mod) return { imported: 0, error: 'Unknown network.' };
  let secret = null;
  try { secret = JSON.parse(await secretOf(sc, conn)); } catch (_) { /* unreadable */ }
  if (!secret) return fail(sc, conn, 'The connection could not be read. Disconnect and connect ' + mod.network.label + ' again.', now);
  const saveSecret = fresh => store(sc, conn.user_id, conn.provider, fresh, conn.account_label || mod.network.label, conn.meta || null);
  const got = await mod.fetchCommissions(secret, conn.meta || {}, { since: A.sinceOf(conn, now), now, fetchImpl, saveSecret })
    .catch(() => ({ items: [], complete: false, error: mod.network.label + ' could not be read just now. We will try again later.' }));
  if (got.error && !got.items.length) return fail(sc, conn, got.error, now);
  return A.saveCommissions(sc, conn, mod.network, got.items, { now, complete: !!got.complete && !got.error, error: got.error || null });
}

const list = () => MODULES.map(m => m.network);

// "$42.50 pending" from a connection's pending total, or ''.
function pendingText(c) {
  const p = c && c.pending;
  if (!p || !p.amounts || !p.count) return '';
  const parts = Object.entries(p.amounts).filter(([, v]) => v > 0)
    .map(([cur, v]) => { try { return Number(v).toLocaleString('en-US', { style: 'currency', currency: cur }); } catch (_) { return v + ' ' + cur; } });
  return parts.length ? parts.join(' + ') + ' pending' : '';
}

module.exports = { MODULES, BY, KEYS, isNetwork, connect, connectOAuth, sync, list, pendingText };
