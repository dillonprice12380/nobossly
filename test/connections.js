// Income-log connections beyond Stripe (src/connections, src/routes/connect.js):
// Shopify (a read-only app's ID and secret), Gumroad and Square ("Connect
// with…", read-only), and banks through Plaid into an inbox the member sorts.
// Every call to the outside is a fake here.
//
//   node test/connections.js        (CONN_OUT=dir also writes the pages as HTML)

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const { FLAGS } = require('../src/features');

// A fake fetch: routes[url-prefix] → (url, opts) => [status, body].
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).find(k => url.startsWith(k));
    if (!key) return { status: 404, json: async () => ({}) };
    const [status, body] = await routes[key](url, opts);
    return { status, json: async () => body };
  };
  f.calls = calls;
  return f;
}
// A fake Supabase client that records writes and answers per table / rpc.
function fakeSb(answers = {}, rpcs = {}) {
  const writes = [], calls = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, eq: {}, in: {}, single: false, opts: null };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          let out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          if (state.single && out && Array.isArray(out.data)) out = Object.assign({}, out, { data: out.data[0] || null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (k === 'maybeSingle') return () => { state.single = true; return chain; };
        if (['eq', 'in', 'lt', 'gte', 'is', 'neq'].includes(k)) return (c, v) => { (state[k] = state[k] || {})[c] = v; return chain; };
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p, o) => { state.op = k; state.payload = p; state.opts = o; writes.push({ table, op: k, payload: p, opts: o, state }); return chain; };
        return () => chain;
      }
    });
    return chain;
  };
  return { from: q, writes, calls, rpc: (n, a) => { calls.push({ name: n, args: a }); const r = rpcs[n]; return Promise.resolve(typeof r === 'function' ? r(a) : (r || { data: null, error: null })); } };
}
const now = new Date('2026-11-09T15:00:00Z');

(async () => {
  console.log('Shopify:');
  const shopify = require('../src/connections/shopify');
  ok('store addresses are tidied', shopify.cleanShop('My-Shop') === 'my-shop.myshopify.com' && shopify.cleanShop('https://my-shop.myshopify.com/admin/orders') === 'my-shop.myshopify.com' && shopify.cleanShop('evil.com/x') === null);
  ok('the form needs an ID and a secret', !!shopify.checkInput({ shop: 'x', client_id: 'short' }).error && !shopify.checkInput({ shop: 'x', client_id: 'a'.repeat(32), client_secret: 'shpss_' + 'b'.repeat(32) }).error);
  const shopFetch = (scope, orders) => fakeFetch({
    'https://my-shop.myshopify.com/admin/oauth/access_token': (u, o) => (/client_secret=good/.test(o.body) ? [200, { access_token: 'tok', scope, expires_in: 86399 }] : [400, { error: 'invalid_client' }]),
    'https://my-shop.myshopify.com/admin/api/': () => [200, { data: { orders: { pageInfo: { hasNextPage: false }, nodes: orders } } }]
  });
  const input = { shop: 'my-shop.myshopify.com', clientId: 'a'.repeat(32), secret: 'good' };
  ok('a read-only app connects, and says whether old orders are readable', (await shopify.verify(input, { fetchImpl: shopFetch('read_orders') })).ok && (await shopify.verify(input, { fetchImpl: shopFetch('read_orders,read_all_orders') })).allOrders === true);
  const w = await shopify.verify(input, { fetchImpl: shopFetch('read_orders,write_orders') });
  ok('an app that can write is refused', !w.ok && /write_orders/.test(w.error));
  ok('a wrong secret says so', /did not accept/.test((await shopify.verify(Object.assign({}, input, { secret: 'bad' }), { fetchImpl: shopFetch('read_orders') })).error));
  const orders = [
    { id: 'gid://shopify/Order/1001', name: '#1001', createdAt: '2026-11-05T10:00:00Z', test: false, cancelledAt: null, displayFinancialStatus: 'PAID', currentTotalPriceSet: { shopMoney: { amount: '45.00', currencyCode: 'USD' } } },
    { id: 'gid://shopify/Order/1002', name: '#1002', createdAt: '2026-11-06T10:00:00Z', test: true, displayFinancialStatus: 'PAID', currentTotalPriceSet: { shopMoney: { amount: '9.00', currencyCode: 'USD' } } },
    { id: 'gid://shopify/Order/1003', name: '#1003', createdAt: '2026-11-06T11:00:00Z', test: false, displayFinancialStatus: 'PENDING', currentTotalPriceSet: { shopMoney: { amount: '20.00', currencyCode: 'USD' } } },
    { id: 'gid://shopify/Order/1004', name: '#1004', createdAt: '2026-11-07T10:00:00Z', test: false, displayFinancialStatus: 'PARTIALLY_REFUNDED', currentTotalPriceSet: { shopMoney: { amount: '30.00', currencyCode: 'USD' } } }
  ];
  {
    const sc = fakeSb({ revenue_entries: s => ({ data: s.op === 'upsert' ? s.payload.map((r, i) => ({ id: 'r' + i })) : [], error: null }) },
      { payment_connection_secret: { data: JSON.stringify({ client_id: 'a'.repeat(32), client_secret: 'good' }), error: null } });
    const conn = { id: 'c1', user_id: 'me', provider: 'shopify', meta: { shop: 'my-shop.myshopify.com' }, imported_count: 0 };
    const f = shopFetch('read_orders', orders);
    const r = await shopify.sync(sc, conn, { fetchImpl: f, now });
    const up = sc.writes.find(x => x.table === 'revenue_entries');
    ok('paid orders come in as income, net of refunds; test and pending orders do not', r.imported === 2 && up.payload.map(x => x.external_id + '=' + x.amount).join() === 'shopify:1001=45,shopify:1004=30' && up.payload[0].source === 'Shopify · #1001');
    const q = JSON.parse(f.calls.find(c => /graphql/.test(c.url)).opts.body).variables.q;
    ok('...reading only the last 60 days without read_all_orders', q === 'created_at:>=' + new Date(now - 59 * 86400000).toISOString().slice(0, 10), q);
    ok('...and the connection moves on', sc.writes.some(x => x.table === 'payment_connections' && x.payload.status === 'active' && x.payload.imported_count === 2));
  }

  console.log('\nGumroad:');
  const gumroad = require('../src/connections/gumroad');
  process.env.GUMROAD_CLIENT_ID = 'gid'; process.env.GUMROAD_CLIENT_SECRET = 'gsecret';
  const gu = new URL(gumroad.authUrl('gumroad.abc'));
  ok('"Connect Gumroad" asks for view_sales only, and comes back to NoBossly', gu.origin === 'https://gumroad.com' && gu.searchParams.get('scope') === 'view_sales' && gu.searchParams.get('redirect_uri') === 'https://nobossly.com/budget/connect/gumroad/callback' && gu.searchParams.get('state') === 'gumroad.abc');
  const gTok = scope => fakeFetch({ 'https://api.gumroad.com/oauth/token': () => [200, { access_token: 'gt', scope }] });
  ok('a token with only view_sales is kept; one with more is refused', (await gumroad.exchange('c', { fetchImpl: gTok('view_sales') })).token === 'gt' && !!(await gumroad.exchange('c', { fetchImpl: gTok('view_sales edit_products') })).error);
  {
    let page = 0;
    const f = fakeFetch({ 'https://api.gumroad.com/v2/sales': (u) => {
      page++;
      return page === 1
        ? [200, { success: true, next_page_key: 'k2', sales: [{ id: 's1', created_at: '2026-11-01T10:00:00Z', price: 1500, product_name: 'Logo pack' }, { id: 's2', created_at: '2026-11-02T10:00:00Z', price: 900, refunded: true }] }]
        : [200, { success: true, sales: [{ id: 's3', created_at: '2026-11-03T10:00:00Z', price: 500, subscription_id: 'sub1', product_name: 'Membership' }] }];
    } });
    const sc = fakeSb({ revenue_entries: s => ({ data: s.op === 'upsert' ? s.payload.map((r, i) => ({ id: 'r' + i })) : [], error: null }) }, { payment_connection_secret: { data: 'gt', error: null } });
    const r = await gumroad.sync(sc, { id: 'c2', user_id: 'me', provider: 'gumroad' }, { fetchImpl: f, now });
    const up = sc.writes.find(x => x.table === 'revenue_entries').payload;
    ok('sales come in page by page; refunds are left out; memberships are Recurring', r.imported === 2 && up.map(x => x.external_id).join() === 'gumroad:s1,gumroad:s3' && up[0].amount === 15 && up[1].is_recurring === true && f.calls[1].url.includes('page_key=k2'));
    ok('...with the token in a header, not the address', f.calls.every(c => !c.url.includes('access_token') && c.opts.headers.Authorization === 'Bearer gt'));
  }

  console.log('\nSquare:');
  const square = require('../src/connections/square');
  process.env.SQUARE_APP_ID = 'sq0idp-x'; process.env.SQUARE_APP_SECRET = 'sq-secret';
  const su = new URL(square.authUrl('square.abc'));
  ok('"Connect Square" asks to read payments and the business name only', su.origin === 'https://connect.squareup.com' && su.searchParams.get('scope') === 'PAYMENTS_READ MERCHANT_PROFILE_READ');
  {
    const soon = new Date(now.getTime() + 3 * 86400000).toISOString();
    const f = fakeFetch({
      'https://connect.squareup.com/oauth2/token': (u, o) => [200, { access_token: 'new-at', refresh_token: JSON.parse(o.body).refresh_token, expires_at: '2026-12-09T00:00:00Z' }],
      'https://connect.squareup.com/v2/payments': () => [200, { payments: [
        { id: 'p1', status: 'COMPLETED', created_at: '2026-11-08T18:00:00Z', amount_money: { amount: 2500, currency: 'USD' }, refunded_money: { amount: 500, currency: 'USD' } },
        { id: 'p2', status: 'FAILED', created_at: '2026-11-08T19:00:00Z', amount_money: { amount: 999, currency: 'USD' } }
      ] }]
    });
    const sc = fakeSb({ revenue_entries: s => ({ data: s.op === 'upsert' ? s.payload.map((r, i) => ({ id: 'r' + i })) : [], error: null }) },
      { payment_connection_secret: { data: JSON.stringify({ access_token: 'old-at', refresh_token: 'rt', expires_at: soon }), error: null } });
    const r = await square.sync(sc, { id: 'c3', user_id: 'me', provider: 'square', account_label: 'Ana Bakes' }, { fetchImpl: f, now });
    ok('a token ending within a week is renewed and stored', f.calls[0].url.endsWith('/oauth2/token') && sc.calls.some(c => c.name === 'payment_connection_store' && JSON.parse(c.args.p_secret).access_token === 'new-at'));
    ok('completed payments come in net of refunds; failed ones do not', r.imported === 1 && sc.writes.find(x => x.table === 'revenue_entries').payload[0].amount === 20 && f.calls[1].opts.headers.Authorization === 'Bearer new-at');
  }

  console.log('\nBanks (Plaid):');
  const plaid = require('../src/connections/plaid');
  process.env.PLAID_CLIENT_ID = 'pid'; process.env.PLAID_SECRET = 'psecret';
  ok('sandbox until told otherwise', plaid.base() === 'https://sandbox.plaid.com');
  ok('only a Plaid-shaped public token is exchanged', !!(await plaid.exchange('<script>', { fetchImpl: fakeFetch({}) })).error);
  const accounts = { a1: { name: 'Business checking', mask: '1234' } };
  const tx = (id, amount, extra) => Object.assign({ transaction_id: id, account_id: 'a1', amount, date: '2026-11-05', name: 'NAME ' + id, merchant_name: null, pending: false, personal_finance_category: { primary: 'GENERAL_MERCHANDISE' } }, extra || {});
  ok('money in and money out, from Plaid\'s signs', plaid.rowOf('me', 'b1', tx('t1', -120), accounts).direction === 'in' && plaid.rowOf('me', 'b1', tx('t2', 30.5), accounts).direction === 'out' && plaid.rowOf('me', 'b1', tx('t2', 30.5), accounts).amount === 30.5);
  ok('pending ones wait until they post', plaid.rowOf('me', 'b1', tx('t3', 10, { pending: true }), accounts) === null);
  ok('the account shows by name and last four', plaid.rowOf('me', 'b1', tx('t1', -1), accounts).account_label === 'Business checking ··1234');
  {
    let calls = 0;
    const f = fakeFetch({ 'https://sandbox.plaid.com/transactions/sync': (u, o) => {
      calls++;
      const b = JSON.parse(o.body);
      return calls === 1
        ? [200, { accounts: [{ account_id: 'a1', name: 'Business checking', mask: '1234' }], added: [tx('t1', -1200, { merchant_name: 'Bloom Studio' }), tx('t2', 29)], modified: [], removed: [], next_cursor: 'c1', has_more: true }]
        : [200, { added: [tx('t4', 500, { personal_finance_category: { primary: 'TRANSFER_OUT' } }), tx('t5', 15, { pending: true })], modified: [], removed: [{ transaction_id: 't9' }], next_cursor: 'c2', has_more: false, cursor_seen: b.cursor }];
    } });
    const sc = fakeSb({ bank_transactions: s => ({ data: s.op === 'upsert' ? s.payload.map((r, i) => ({ id: 'bt' + i, external_id: r.external_id, status: 'new', decided_at: null })) : [], error: null }) },
      { bank_connection_secret: { data: 'access-sandbox-x', error: null } });
    const r = await plaid.sync(sc, { id: 'b1', user_id: 'me', sync_cursor: null }, { fetchImpl: f, now });
    const up = sc.writes.find(x => x.table === 'bank_transactions' && x.op === 'upsert');
    ok('posted transactions land in the inbox, page by page', r.added === 3 && up.payload.map(x => x.external_id).join() === 'plaid:t1,plaid:t2,plaid:t4' && JSON.parse(f.calls[1].opts.body).cursor === 'c1');
    ok('...an update never resets what the member decided', up.payload.every(x => !('status' in x)) && up.opts.onConflict === 'user_id,external_id');
    ok('...transfers between their own accounts start set aside', sc.writes.some(x => x.table === 'bank_transactions' && x.op === 'update' && x.payload.status === 'ignored' && x.state.in.id.join() === 'bt2'));
    ok('...removed ones go only if still waiting', sc.writes.some(x => x.op === 'delete' && x.state.eq.status === 'new' && x.state.in.external_id.join() === 'plaid:t9'));
    ok('...and the cursor is kept for next time', sc.writes.some(x => x.table === 'bank_connections' && x.payload.sync_cursor === 'c2' && x.payload.status === 'active'));
    const sc2 = fakeSb({}, { bank_connection_secret: { data: 'access-sandbox-x', error: null } });
    const r2 = await plaid.sync(sc2, { id: 'b1', user_id: 'me' }, { fetchImpl: fakeFetch({ 'https://sandbox.plaid.com/transactions/sync': () => [400, { error_code: 'ITEM_LOGIN_REQUIRED' }] }), now });
    ok('a bank that wants a fresh log-in says so', /log in again/.test(r2.error) && sc2.writes.some(x => x.payload.status === 'error'));
  }

  console.log('\nThe routes:');
  const cr = require('../src/routes/connect');
  const run = (method, url, { body = {}, query = {}, sb, cookies = {} } = {}) => new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, cookies, user: { id: 'me' }, profile: { id: 'me', username: 'dana' } };
    const res = {
      statusCode: 200, locals: {}, cookiesSet: {},
      status(c) { this.statusCode = c; return this; },
      cookie(k, v) { this.cookiesSet[k] = v; return this; }, clearCookie() { return this; },
      json(b) { resolve({ json: b, status: this.statusCode }); },
      redirect(to) { resolve({ redirect: to, cookies: this.cookiesSet }); },
      render(view, data) { resolve({ view, data }); }
    };
    cr.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
  {
    const r = await run('GET', '/connect/gumroad/start', {});
    ok('"Connect Gumroad" sets a state cookie and goes to Gumroad', /^https:\/\/gumroad\.com\/oauth\/authorize\?/.test(r.redirect) && r.cookies.nb_oauth_state && r.redirect.includes(encodeURIComponent(r.cookies.nb_oauth_state)));
    const bad = await run('GET', '/connect/gumroad/callback', { query: { code: 'c', state: 'gumroad.wrong' }, cookies: { nb_oauth_state: r.cookies.nb_oauth_state } });
    ok('...and a callback with the wrong state is refused', /did%20not%20finish/.test(bad.redirect));
  }
  {
    const sb = fakeSb({ bank_transactions: s => ({ data: [{ id: '00000000-0000-0000-0000-0000000000b1', user_id: 'me', external_id: 'plaid:t1', amount: 1200, posted_on: '2026-11-05', direction: 'in', merchant: 'Bloom Studio', status: 'new', account_label: 'Business checking ··1234' }], error: null }), revenue_entries: { data: null, error: null } });
    await run('POST', '/review/00000000-0000-0000-0000-0000000000b1', { sb, body: { as: 'income', recurring: '1' } });
    const ins = sb.writes.find(x => x.table === 'revenue_entries');
    ok('marking one income logs it once, from the bank', !!ins && ins.payload.external_id === 'plaid:t1' && ins.payload.amount === 1200 && ins.payload.source === 'Bloom Studio' && ins.payload.is_recurring === true && sb.writes.some(x => x.table === 'bank_transactions' && x.payload.status === 'income'));
    const sb2 = fakeSb({ bank_transactions: { data: [{ id: '00000000-0000-0000-0000-0000000000b2', user_id: 'me', external_id: 'plaid:t2', amount: 29, posted_on: '2026-11-05', direction: 'out', name: 'CANVA', status: 'new' }], error: null }, expenses: { data: null, error: null } });
    await run('POST', '/review/00000000-0000-0000-0000-0000000000b2', { sb: sb2, body: { as: 'expense', category: 'Software & Subscriptions' } });
    const ex = sb2.writes.find(x => x.table === 'expenses');
    ok('...an expense goes to spending with its category', !!ex && ex.payload.external_id === 'plaid:t2' && ex.payload.amount === 29);
    const sb3 = fakeSb({ bank_transactions: { data: [{ id: '00000000-0000-0000-0000-0000000000b1', user_id: 'me', external_id: 'plaid:t1', status: 'income' }], error: null } });
    await run('POST', '/review/00000000-0000-0000-0000-0000000000b1', { sb: sb3, body: { as: 'undo' } });
    ok('...and Undo takes it back out of the log', sb3.writes.some(x => x.table === 'revenue_entries' && x.op === 'delete' && x.state.eq.external_id === 'plaid:t1') && sb3.writes.some(x => x.payload && x.payload.status === 'new'));
    const sb4 = fakeSb();
    await run('POST', '/review/bulk/ignore', { sb: sb4, body: { before: '2026-10-10' } });
    ok('setting aside everything before a date touches only what is waiting', sb4.writes.length === 1 && sb4.writes[0].state.eq.status === 'new' && sb4.writes[0].payload.status === 'ignored');
  }
  {
    delete process.env.PLAID_CLIENT_ID;
    const r = await run('POST', '/connect/bank/link-token', {});
    ok('before NoBossly has Plaid keys, the bank button says it is being switched on', r.status === 503 && /switched on/.test(r.json.error));
    process.env.PLAID_CLIENT_ID = 'pid';
  }
  ok('a bank payout from a connected service is flagged', cr.PAYOUT.test('STRIPE TRANSFER ST-1234') && cr.PAYOUT.test('SQ *ANA BAKES') && !cr.PAYOUT.test('BLOOM STUDIO'));
  ok('the server syncs them every 30 minutes', /connections\.runAll\(sc\)/.test(read('server.js')));

  console.log('\nThe pages:');
  const V = f => path.join(ROOT, 'views', f);
  const base = { title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'dana', display_name: 'Dana' }, plan: 'free', currentPath: '/budget/connect', canonicalUrl: 'x', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
  const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
  const out = {};
  const C = require('../src/connections');
  out.hub = render('budget_connect.ejs', {
    by: { stripe: { status: 'active', last_synced_at: '2026-11-09T12:00:00Z', imported_count: 14 }, shopify: { status: 'active', account_label: 'my-shop.myshopify.com', last_synced_at: '2026-11-09T12:00:00Z', imported_count: 3 } },
    ready: true, banks: [{ id: 'b1', institution: 'Chase', accounts: [{ name: 'Business checking', mask: '1234' }], status: 'active', last_synced_at: '2026-11-09T12:00:00Z' }], banksReady: true, waiting: 4,
    providers: Object.values(C.PROVIDERS).map(p => ({ key: p.key, label: p.label, emoji: p.emoji, how: p.how, blurb: p.blurb, ready: p.key !== 'square' })), plaidReady: true, canSync: true, everyHours: 6
  });
  ok('the hub lists every way in, what is connected, and what is waiting', !out.hub.startsWith('ERR') && ['Stripe', 'Shopify', 'Gumroad', 'Square', 'PayPal, Etsy and others', 'Chase', '4</strong> bank transactions waiting'].every(x => out.hub.includes(x)), out.hub.startsWith('ERR') ? out.hub.slice(0, 300) : undefined);
  ok('...with Connect buttons where NoBossly is set up, and "coming soon" where not', out.hub.includes('href="/budget/connect/gumroad/start"') && !out.hub.includes('/budget/connect/square/start') && out.hub.includes('Coming soon'));
  out.shopify = render('budget_connect_shopify.ejs', { conn: null, ready: true, everyHours: 6 });
  ok('the Shopify page explains the read-only app and asks for ID and secret', out.shopify.includes('read_orders') && out.shopify.includes('name="client_secret"') && out.shopify.includes('type="password"'));
  out.bank = render('budget_connect_bank.ejs', { banks: [], ready: true, tablesReady: true, waiting: 0, everyHours: 6 });
  ok('the bank page loads Plaid\'s window from Plaid', out.bank.includes('https://cdn.plaid.com/link/v2/stable/link-initialize.js') && out.bank.includes('/budget/connect/bank/link-token'));
  out.review = render('budget_review.ejs', { rows: [
    { id: 'b1', posted_on: '2026-11-05', amount: 1200, direction: 'in', merchant: 'Bloom Studio', name: 'BLOOM STUDIO LLC', account_label: 'Business checking ··1234', category: 'Income', status: 'new' },
    { id: 'b2', posted_on: '2026-11-04', amount: 812.4, direction: 'in', name: 'STRIPE TRANSFER', status: 'new', payout: 'Stripe' },
    { id: 'b3', posted_on: '2026-11-03', amount: 29, direction: 'out', merchant: 'Canva', name: 'CANVA* PRO', category: 'General Services', status: 'new' }
  ], show: 'new', ready: true, waiting: 3, connected: ['stripe'], budgetCategories: require('../src/budget_categories').STANDARD });
  ok('the inbox offers income for money in and expense for money out', !out.review.startsWith('ERR') && out.review.includes('value="income"') && out.review.includes('value="expense"') && out.review.includes('Not business'), out.review.startsWith('ERR') ? out.review.slice(0, 300) : undefined);
  ok('...and warns when a deposit is a payout from something already connected', out.review.includes('Looks like a payout from <strong>Stripe</strong>') && out.review.includes('already in your log'));

  if (process.env.CONN_OUT) {
    const css = x => x.replace(/href="\/css\/style\.css\?v=\d+"/, 'href="' + path.join(ROOT, 'public/css/style.css') + '"');
    for (const [k, v] of Object.entries(out)) fs.writeFileSync(path.join(process.env.CONN_OUT, k + '.html'), css(v));
  }
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
