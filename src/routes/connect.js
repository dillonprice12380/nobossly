// Connections for the income log beyond Stripe (src/connections): Shopify
// (paste a read-only app's ID and secret), Gumroad and Square ("Connect
// with…", read-only), and banks through Plaid, whose transactions go to an
// inbox the member sorts (/budget/review). Mounted inside src/routes/budget.js,
// so everything here is behind requireAuth at /budget.
//
// Secrets never pass through the member's own client: the server checks what
// it was given, then stores it with the service role (payment_connection_store,
// bank_connection_store), which keeps it in the Vault.

const router = require('express').Router();
const { serviceClient } = require('../supabase');
const C = require('../connections');
const common = require('../connections/common');
const budgetCategories = require('../budget_categories').STANDARD;
const { quiet } = require('../db');

const service = () => { try { return serviceClient(); } catch (_) { return null; } };
const enc = encodeURIComponent;
const go = (res, path, m) => res.redirect(path + (m ? (path.includes('?') ? '&' : '?') + 'msg=' + enc(m) : ''));
const ID = /^[0-9a-f-]{36}$/i;
const missing = err => !!err && (err.code === '42P01' || err.code === 'PGRST205' || err.code === '42703' || /does not exist|Could not find/i.test(err.message || ''));
const syncedMsg = (label, r) => (r.error ? r.error
  : r.imported ? 'Synced: ' + r.imported + ' new payment' + (r.imported === 1 ? '' : 's') + ' from ' + label + (r.skipped ? ' (' + r.skipped + ' already in your log)' : '') + '.'
  : 'Synced. Nothing new from ' + label + (r.skipped ? ' (' + r.skipped + ' already in your log)' : '') + '.');

const CONN_COLS = 'id, provider, key_hint, account_label, status, last_error, last_synced_at, synced_through, imported_count, created_at';
async function myConnections(req) {
  // pending arrives with migrations/2026-11-18_affiliate_connections.sql.
  let r = await req.sb.from('payment_connections').select(CONN_COLS + ', pending').eq('user_id', req.user.id);
  const affiliatesReady = !r.error;
  if (r.error) r = await req.sb.from('payment_connections').select(CONN_COLS).eq('user_id', req.user.id);
  const ready = !r.error;   // account_label arrives with migrations/2026-11-09_more_connections.sql
  if (r.error) r = await req.sb.from('payment_connections').select(CONN_COLS.replace('account_label, ', '')).eq('user_id', req.user.id);
  const by = {};
  (r.data || []).forEach(c => { by[c.provider] = c; });
  return { by, ready, affiliatesReady };
}
async function myBanks(req) {
  const r = await req.sb.from('bank_connections').select('id, institution, accounts, status, last_error, last_synced_at, created_at').eq('user_id', req.user.id).order('created_at');
  return { banks: r.data || [], ready: !r.error };
}
async function waitingCount(req) {
  const r = await req.sb.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'new');
  return r.error ? 0 : (r.count || 0);
}
// The full row the sync needs, read with the service role (meta is not the member's to read).
async function fullConnection(sc, userId, provider) {
  const { data } = await sc.from('payment_connections').select('id, user_id, provider, status, last_synced_at, synced_through, imported_count, account_label, meta')
    .eq('user_id', userId).eq('provider', provider).maybeSingle();
  return data || null;
}

const pendingText = C.affiliates.pendingText;

// --------------------------------------------------------------------- Hub
router.get('/connect', async (req, res, next) => {
  try {
    const [{ by, ready, affiliatesReady }, b, waiting] = await Promise.all([myConnections(req), myBanks(req), waitingCount(req)]);
    res.render('budget_connect', {
      title: 'Connect your money', by, ready, banks: b.banks, banksReady: b.ready && ready, waiting,
      networks: C.affiliates.list(), affiliatesReady, pendingText,
      providers: Object.values(C.PROVIDERS).map(p => ({ key: p.key, label: p.label, emoji: p.emoji, how: p.how, blurb: p.blurb, ready: p.ready() })),
      plaidReady: C.plaid.configured(), canSync: !!service(), everyHours: C.EVERY_HOURS, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------- Shopify
router.get('/connect/shopify', async (req, res, next) => {
  try {
    const { by, ready } = await myConnections(req);
    res.render('budget_connect_shopify', { title: 'Connect Shopify', conn: by.shopify || null, ready, oneClick: C.shopify.configured(), msg: req.query.msg || null, everyHours: C.EVERY_HOURS });
  } catch (e) { next(e); }
});

router.post('/connect/shopify', async (req, res, next) => {
  try {
    const back = '/budget/connect/shopify';
    const input = C.shopify.checkInput(req.body);
    if (input.error) return go(res, back, input.error);
    const sc = service();
    if (!sc) return go(res, back, 'Connecting is not switched on right now. Try again later.');
    const ok = await C.shopify.verify(input);
    if (!ok.ok) return go(res, back, ok.error);
    const { error } = await common.store(sc, req.user.id, 'shopify', { client_id: input.clientId, client_secret: input.secret }, input.shop, { shop: input.shop, all_orders: ok.allOrders });
    if (error) return go(res, back, missing(error) ? 'Connecting Shopify is being switched on. Check back shortly.' : 'Could not save the connection. Please try again.');
    const conn = await fullConnection(sc, req.user.id, 'shopify');
    const r = conn ? await C.shopify.sync(sc, conn) : { imported: 0 };
    go(res, back, 'Connected. ' + syncedMsg('Shopify', r) + (ok.allOrders ? '' : ' Shopify only shares the last 60 days unless the app also has read_all_orders.'));
  } catch (e) { next(e); }
});

// ----------------------------------------------- "Connect Shopify" (OAuth)
router.get('/connect/shopify/start', (req, res) => {
  const back = '/budget/connect/shopify';
  if (!C.shopify.configured()) return go(res, back, 'Connect Shopify is coming soon. Use the steps below for now.');
  const shop = C.shopify.cleanShop(req.query.shop);
  if (!shop) return go(res, back, 'Enter your store address, e.g. mystore.myshopify.com.');
  res.redirect(C.shopify.authUrl(shop, common.newState(res, 'shopify')));
});

router.get('/connect/shopify/callback', async (req, res, next) => {
  try {
    const back = '/budget/connect/shopify';
    const shop = C.shopify.cleanShop(req.query.shop);
    if (!shop || !C.shopify.validCallback(req.query) || !common.checkState(req, res, 'shopify')) return go(res, back, 'That Shopify connection did not finish. Try again.');
    const sc = service();
    if (!sc) return go(res, back, 'Connecting is not switched on right now. Try again later.');
    const t = await C.shopify.exchange(shop, String(req.query.code || ''));
    if (t.error) return go(res, back, t.error);
    const { error } = await common.store(sc, req.user.id, 'shopify', t.secret, shop, { shop, all_orders: t.allOrders });
    if (error) return go(res, back, 'Could not save the connection. Please try again.');
    const conn = await fullConnection(sc, req.user.id, 'shopify');
    const r = conn ? await C.shopify.sync(sc, conn) : { imported: 0 };
    go(res, back, 'Connected. ' + syncedMsg('Shopify', r) + (t.allOrders ? '' : ' Shopify shares the last 60 days of orders.'));
  } catch (e) { next(e); }
});

// ----------------------------------------------- "Connect Admitad" (OAuth)
router.get('/connect/admitad/start', (req, res) => {
  const mod = C.affiliates.BY.admitad;
  if (!mod.configured()) return go(res, '/budget/connect/affiliate/admitad', 'Connect with Admitad is coming soon. Paste your API details below for now.');
  res.redirect(mod.authUrl(common.newState(res, 'admitad')));
});

router.get('/connect/admitad/callback', async (req, res, next) => {
  try {
    const back = '/budget/connect/affiliate/admitad', mod = C.affiliates.BY.admitad;
    if (!common.checkState(req, res, 'admitad')) return go(res, back, 'That Admitad connection did not finish. Try again.');
    if (req.query.error || !req.query.code) return go(res, back, 'Admitad was not connected' + (req.query.error === 'access_denied' ? ' (you said no).' : '.'));
    const sc = service();
    if (!sc) return go(res, back, 'Connecting is not switched on right now. Try again later.');
    const t = await mod.exchange(String(req.query.code));
    if (t.error) return go(res, back, t.error);
    const r = await C.affiliates.connectOAuth(sc, req.user.id, 'admitad', t.secret, 'Admitad account');
    if (r.error) return go(res, back, 'Could not save the connection. Please try again.');
    const conn = await fullConnection(sc, req.user.id, 'admitad');
    const s = conn ? await C.affiliates.sync(sc, conn) : { imported: 0 };
    go(res, back, 'Connected. ' + affiliateMsg('Admitad', s));
  } catch (e) { next(e); }
});

// ------------------------------------------------------ Gumroad and Square
const OAUTH = { gumroad: C.gumroad, square: C.square };

router.get('/connect/:provider(gumroad|square)/start', (req, res) => {
  const p = req.params.provider, mod = OAUTH[p];
  if (!mod.configured()) return go(res, '/budget/connect', C.PROVIDERS[p].label + ' is being switched on. Check back shortly.');
  res.redirect(mod.authUrl(common.newState(res, p)));
});

router.get('/connect/:provider(gumroad|square)/callback', async (req, res, next) => {
  try {
    const p = req.params.provider, mod = OAUTH[p], label = C.PROVIDERS[p].label;
    if (!common.checkState(req, res, p)) return go(res, '/budget/connect', 'That ' + label + ' connection did not finish. Try again.');
    if (req.query.error || !req.query.code) return go(res, '/budget/connect', label + ' was not connected' + (req.query.error === 'access_denied' ? ' (you said no).' : '.'));
    const sc = service();
    if (!sc) return go(res, '/budget/connect', 'Connecting is not switched on right now. Try again later.');
    const t = await mod.exchange(String(req.query.code));
    if (t.error) return go(res, '/budget/connect', t.error);
    let secret, name = null, meta = null;
    if (p === 'square') { secret = t.secret; name = await C.square.merchantName(fetch, t.secret.access_token); meta = { merchant_id: t.merchantId }; }
    else secret = t.token;
    const { error } = await common.store(sc, req.user.id, p, secret, name || label, meta);
    if (error) return go(res, '/budget/connect', missing(error) ? 'Connecting ' + label + ' is being switched on. Check back shortly.' : 'Could not save the connection. Please try again.');
    const conn = await fullConnection(sc, req.user.id, p);
    const r = conn ? await mod.sync(sc, conn) : { imported: 0 };
    go(res, '/budget/connect', label + ' connected. ' + syncedMsg(label, r));
  } catch (e) { next(e); }
});

// Sync now / disconnect, for any of the three.
router.post('/connect/:provider(shopify|gumroad|square)/sync', async (req, res, next) => {
  try {
    const p = req.params.provider, label = C.PROVIDERS[p].label;
    const back = p === 'shopify' ? '/budget/connect/shopify' : '/budget/connect';
    const sc = service();
    if (!sc) return go(res, back, 'Syncing is not switched on right now. Try again later.');
    const conn = await fullConnection(sc, req.user.id, p);
    if (!conn) return go(res, back);
    if (conn.last_synced_at && Date.now() - new Date(conn.last_synced_at).getTime() < 60000) return go(res, back, 'Synced less than a minute ago.');
    const r = await C.PROVIDERS[p].mod.sync(sc, conn);
    go(res, back, syncedMsg(label, r));
  } catch (e) { next(e); }
});

router.post('/connect/:provider(shopify|gumroad|square)/disconnect', async (req, res, next) => {
  try {
    const p = req.params.provider, label = C.PROVIDERS[p].label;
    await req.sb.rpc('payment_disconnect', { p_provider: p });
    go(res, p === 'shopify' ? '/budget/connect/shopify' : '/budget/connect', 'Disconnected. ' + label + ' access is deleted from NoBossly; the payments already logged stay in your income log.'
      + (p === 'shopify' ? ' You can also uninstall the app in Shopify.' : ' You can also remove NoBossly in your ' + label + ' settings.'));
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------- Banks
router.get('/connect/bank', async (req, res, next) => {
  try {
    const [b, waiting] = await Promise.all([myBanks(req), waitingCount(req)]);
    res.render('budget_connect_bank', { title: 'Connect a bank', banks: b.banks, ready: b.ready && C.plaid.configured(), tablesReady: b.ready, waiting, msg: req.query.msg || null, everyHours: C.EVERY_HOURS });
  } catch (e) { next(e); }
});

// The page's "Connect a bank" button asks for a Link token, opens Plaid, then posts back what Plaid returned.
router.post('/connect/bank/link-token', async (req, res) => {
  if (!C.plaid.configured()) return res.status(503).json({ error: 'Connecting a bank is being switched on. Check back shortly.' });
  const t = await C.plaid.linkToken(req.user.id);
  if (t.error) return res.status(502).json({ error: t.error });
  res.json({ link_token: t.token });
});

router.post('/connect/bank/exchange', async (req, res) => {
  const b = req.body || {};
  let meta = {};
  try { meta = typeof b.metadata === 'string' ? JSON.parse(b.metadata) : (b.metadata || {}); } catch (_) { meta = {}; }
  const sc = service();
  if (!sc || !C.plaid.configured()) return res.status(503).json({ error: 'Connecting a bank is being switched on. Check back shortly.' });
  const x = await C.plaid.exchange(b.public_token);
  if (x.error) return res.status(502).json({ error: x.error });
  const institution = (meta.institution && meta.institution.name) || 'Your bank';
  const { data: id, error } = await sc.rpc('bank_connection_store', { p_user: req.user.id, p_item: x.itemId, p_institution: institution, p_accounts: C.plaid.accountsOf(meta), p_token: x.accessToken });
  if (error || !id) {
    await C.plaid.removeItem(x.accessToken);   // nothing half-connected is left at Plaid
    return res.status(400).json({ error: /five banks/.test((error && error.message) || '') ? 'You can connect up to five banks.' : 'Could not save the bank connection. Please try again.' });
  }
  const r = await C.plaid.sync(sc, { id, user_id: req.user.id, sync_cursor: null });
  res.json({ ok: true, redirect: '/budget/review?msg=' + enc(institution + ' connected. ' + (r.error ? r.error : r.added ? r.added + ' transaction' + (r.added === 1 ? '' : 's') + ' to go through.' : 'Transactions can take a few minutes to arrive the first time; check back shortly.')) });
});

router.post('/connect/bank/:id/sync', async (req, res, next) => {
  try {
    if (!ID.test(req.params.id)) return go(res, '/budget/connect/bank');
    const sc = service();
    if (!sc || !C.plaid.configured()) return go(res, '/budget/connect/bank', 'Syncing is not switched on right now. Try again later.');
    const { data: b } = await sc.from('bank_connections').select('id, user_id, sync_cursor, last_synced_at, institution').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!b) return go(res, '/budget/connect/bank');
    if (b.last_synced_at && Date.now() - new Date(b.last_synced_at).getTime() < 60000) return go(res, '/budget/connect/bank', 'Synced less than a minute ago.');
    const r = await C.plaid.sync(sc, b);
    go(res, r.added ? '/budget/review' : '/budget/connect/bank', r.error ? r.error : r.added ? r.added + ' new from ' + (b.institution || 'your bank') + '.' : 'Synced. Nothing new from ' + (b.institution || 'your bank') + '.');
  } catch (e) { next(e); }
});

router.post('/connect/bank/:id/disconnect', async (req, res, next) => {
  try {
    if (!ID.test(req.params.id)) return go(res, '/budget/connect/bank');
    const sc = service();
    // Tell Plaid first, so the bank stops sharing; then forget the token.
    if (sc) {
      const { data: own } = await req.sb.from('bank_connections').select('id').eq('id', req.params.id).maybeSingle();
      if (own) {
        const { data: tok } = await sc.rpc('bank_connection_secret', { p_id: req.params.id });
        if (tok) await C.plaid.removeItem(tok).catch(() => false);
      }
    }
    await req.sb.rpc('bank_disconnect', { p_id: req.params.id });
    go(res, '/budget/connect/bank', 'Disconnected. The bank stops sharing with NoBossly; what you already logged stays.');
  } catch (e) { next(e); }
});

// ---------------------------------------------------------- The bank inbox
const PAYOUT = /\b(stripe|paypal|shopify|etsy|square|sq \*|gumroad|lemon ?squeezy|paddle|patreon|substack|kajabi|teachable|venmo|cash ?app|zelle)\b/i;

router.get('/review', async (req, res, next) => {
  try {
    const show = ['new', 'done', 'ignored'].includes(req.query.show) ? req.query.show : 'new';
    let q = req.sb.from('bank_transactions').select('id, external_id, posted_on, amount, direction, name, merchant, category, account_label, status, decided_at')
      .eq('user_id', req.user.id).order('posted_on', { ascending: false }).limit(300);
    q = show === 'new' ? q.eq('status', 'new') : show === 'ignored' ? q.eq('status', 'ignored') : q.in('status', ['income', 'expense']);
    const r = await q;
    const { by } = await myConnections(req);
    const connected = Object.keys(by);
    const rows = (r.data || []).map(t => Object.assign({}, t, {
      payout: t.direction === 'in' && PAYOUT.test((t.name || '') + ' ' + (t.merchant || '')) ? ((t.name + ' ' + (t.merchant || '')).match(PAYOUT)[1]) : null
    }));
    res.render('budget_review', {
      title: 'From your bank', rows, show, ready: !r.error, waiting: await waitingCount(req), connected,
      budgetCategories, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// One transaction: income, expense, not business, or back to waiting.
router.post('/review/:id', async (req, res, next) => {
  try {
    const back = '/budget/review' + (req.body.show && req.body.show !== 'new' ? '?show=' + enc(req.body.show) : '');
    if (!ID.test(req.params.id)) return go(res, back);
    const { data: t } = await req.sb.from('bank_transactions').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!t) return go(res, back);
    const as = String(req.body.as || '');
    const label = (t.merchant || t.name || 'Bank').slice(0, 80);
    if (as === 'undo') {
      if (t.status === 'income') await req.sb.from('revenue_entries').delete().eq('user_id', req.user.id).eq('external_id', t.external_id);
      if (t.status === 'expense') await req.sb.from('expenses').delete().eq('user_id', req.user.id).eq('external_id', t.external_id);
      await req.sb.from('bank_transactions').update({ status: 'new', decided_at: new Date().toISOString() }).eq('id', t.id);
      return go(res, back, 'Moved back to waiting.');
    }
    if (t.status !== 'new' && t.status !== 'ignored') return go(res, back);
    if (as === 'income') {
      const { error } = await req.sb.from('revenue_entries').insert({ user_id: req.user.id, entry_type: 'revenue', external_id: t.external_id, amount: t.amount, entry_date: t.posted_on, source: label, description: (t.account_label ? 'From ' + t.account_label : 'From your bank').slice(0, 200), is_recurring: !!req.body.recurring });
      if (error && error.code !== '23505') return go(res, back, 'That did not save. Try again.');
    } else if (as === 'expense') {
      let category = String(req.body.category || '').trim();
      if (!budgetCategories.includes(category)) category = (category || 'Other').slice(0, 40);
      const { error } = await req.sb.from('expenses').insert({ user_id: req.user.id, category, amount: t.amount, spent_at: t.posted_on, note: label.slice(0, 200), external_id: t.external_id });
      if (error && error.code !== '23505') return go(res, back, 'That did not save. Try again.');
    } else if (as !== 'ignore') return go(res, back);
    await req.sb.from('bank_transactions').update({ status: as === 'ignore' ? 'ignored' : as, decided_at: new Date().toISOString() }).eq('id', t.id);
    go(res, back + (back.includes('#') ? '' : ''), null);
  } catch (e) { next(e); }
});

// Set aside everything still waiting from before a date (a first sync brings a year).
router.post('/review/bulk/ignore', async (req, res, next) => {
  try {
    const before = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.before || '')) ? req.body.before : null;
    let q = req.sb.from('bank_transactions').update({ status: 'ignored', decided_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('status', 'new');
    if (before) q = q.lt('posted_on', before);
    await q.then(...quiet('bank_transactions bulk ignore'));
    go(res, '/budget/review', before ? 'Set aside everything before ' + before + '.' : 'Set aside everything that was waiting.');
  } catch (e) { next(e); }
});

// ------------------------------------------------------- Affiliate networks
// One page per network: what to paste, where to find it, and the connection.
const NETS = C.affiliates.KEYS.join('|');
router.get('/connect/affiliate/:network(' + NETS + ')', async (req, res, next) => {
  try {
    const mod = C.affiliates.BY[req.params.network];
    const { by, affiliatesReady } = await myConnections(req);
    res.render('budget_connect_affiliate', {
      title: 'Connect ' + mod.network.label, net: mod.network, conn: by[mod.network.key] || null, ready: affiliatesReady,
      oneClick: typeof mod.configured === 'function' ? { ready: mod.configured(), href: '/budget/connect/' + mod.network.key + '/start' } : null,
      pendingText, others: C.affiliates.list().filter(n => n.key !== mod.network.key),
      canSync: !!service(), everyHours: C.EVERY_HOURS, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/connect/affiliate/:network(' + NETS + ')', async (req, res, next) => {
  try {
    const key = req.params.network, label = C.affiliates.BY[key].network.label;
    const back = '/budget/connect/affiliate/' + key;
    const sc = service();
    if (!sc) return go(res, back, 'Connecting is not switched on right now. Try again later.');
    const r = await C.affiliates.connect(sc, req.user.id, key, req.body);
    if (r.error === 'save') return go(res, back, missing(r.dbError) || /unknown provider|check constraint/i.test((r.dbError && r.dbError.message) || '') ? 'Connecting ' + label + ' is being switched on. Check back shortly.' : 'Could not save the connection. Please try again.');
    if (r.error) return go(res, back, r.error);
    const conn = await fullConnection(sc, req.user.id, key);
    const s = conn ? await C.affiliates.sync(sc, conn) : { imported: 0 };
    go(res, back, 'Connected. ' + affiliateMsg(label, s));
  } catch (e) { next(e); }
});

function affiliateMsg(label, r) {
  if (r.error) return r.error;
  const bits = [];
  bits.push(r.imported ? r.imported + ' approved commission' + (r.imported === 1 ? '' : 's') + ' added to your income log' : 'No new approved commissions');
  if (r.removed) bits.push(r.removed + ' reversed and taken back out');
  if (r.pendingCount) bits.push(r.pendingCount + ' still pending');
  return 'Synced ' + label + ': ' + bits.join(', ') + '.';
}

router.post('/connect/affiliate/:network(' + NETS + ')/sync', async (req, res, next) => {
  try {
    const key = req.params.network, label = C.affiliates.BY[key].network.label;
    const back = '/budget/connect/affiliate/' + key;
    const sc = service();
    if (!sc) return go(res, back, 'Syncing is not switched on right now. Try again later.');
    const conn = await fullConnection(sc, req.user.id, key);
    if (!conn) return go(res, back);
    if (conn.last_synced_at && Date.now() - new Date(conn.last_synced_at).getTime() < 60000) return go(res, back, 'Synced less than a minute ago.');
    go(res, back, affiliateMsg(label, await C.affiliates.sync(sc, conn)));
  } catch (e) { next(e); }
});

router.post('/connect/affiliate/:network(' + NETS + ')/disconnect', async (req, res, next) => {
  try {
    const key = req.params.network, label = C.affiliates.BY[key].network.label;
    await req.sb.rpc('payment_disconnect', { p_provider: key });
    go(res, '/budget/connect/affiliate/' + key, 'Disconnected. Your ' + label + ' details are deleted from NoBossly; commissions already logged stay in your income log. You can also delete the key in ' + label + '.');
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.PAYOUT = PAYOUT;
