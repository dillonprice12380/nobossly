// Stripe → income log: the read-only key check, turning charges into income,
// the sync (paging, refunds, subscriptions, duplicates, failures), the timer,
// and the connect page end to end. Stripe is faked; nothing leaves the machine.
//
//   node test/stripe_sync.js

const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

// The routes take the service client from src/supabase; give them a fake one.
const fakeService = { current: null };
require.cache[require.resolve('../src/supabase')] = { id: 'supabase', filename: require.resolve('../src/supabase'), loaded: true,
  exports: { serviceClient: () => { if (!fakeService.current) throw new Error('no service key'); return fakeService.current; }, anonClient: () => null, userClient: () => null } };
const stripe = require('../src/stripe_sync');
const { FLAGS } = require('../src/features');

// Fake keys are assembled at runtime, never written out whole, so secret
// scanners do not take them for real ones.
const fakeKey = (kind, mode, tail = '1234') => [kind, mode, 'FAKE' + 'x'.repeat(24) + tail].join('_');
const KEY = fakeKey('rk', 'live');
const NOW = new Date('2026-11-20T12:00:00Z');
const t = iso => Math.floor(new Date(iso).getTime() / 1000);
const charge = (id, created, amount, extra = {}) => Object.assign({ id, object: 'charge', status: 'succeeded', paid: true, captured: true, amount, amount_refunded: 0, currency: 'usd', created: t(created), description: null, invoice: null, billing_details: { name: null } }, extra);

// A fake Stripe: charges newest first, paged by starting_after; can refuse
// invoice expansion (a key without Invoices: Read) or fail a given page.
function fakeStripe(charges, { noInvoices = false, status = 200, failPage = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const u = new URL(url);
    calls.push({ url: u, auth: opts && opts.headers && opts.headers.Authorization, version: opts && opts.headers && opts.headers['Stripe-Version'] });
    const json = (code, body) => ({ status: code, json: async () => body });
    if (status !== 200) return json(status, { error: { message: 'nope' } });
    if (noInvoices && u.searchParams.get('expand[]')) return json(403, { error: { message: 'The provided key does not have the required permissions for this endpoint: rak_invoice_read' } });
    const since = Number(u.searchParams.get('created[gte]') || 0);
    const limit = Number(u.searchParams.get('limit') || 10);
    const all = charges.filter(c => c.created >= since).sort((a, b) => b.created - a.created);
    const after = u.searchParams.get('starting_after');
    const start = after ? all.findIndex(c => c.id === after) + 1 : 0;
    const pageNo = after ? Math.round(start / limit) : 0;
    if (failPage !== null && pageNo === failPage) return json(500, { error: { message: 'boom' } });
    const data = all.slice(start, start + limit).map(c => (u.searchParams.get('expand[]') ? c : Object.assign({}, c, { invoice: c.invoice && typeof c.invoice === 'object' ? c.invoice.id : c.invoice })));
    return json(200, { object: 'list', data, has_more: start + limit < all.length });
  };
  fn.calls = calls;
  return fn;
}

// A fake service-role client over in-memory tables.
function fakeSc(store) {
  const from = table => {
    const st = { filters: [], op: 'select', payload: null, opts: null, single: false };
    const q = new Proxy({}, { get(_, prop) {
      if (prop === 'then') return (res, rej) => {
        const rows = store[table] = store[table] || [];
        const match = r => st.filters.every(([op, c, v]) => (op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c]) >= String(v) : true));
        let out = { data: null, error: null };
        if (st.op === 'select') out.data = st.single ? (rows.filter(match)[0] || null) : rows.filter(match);
        if (st.op === 'update') { rows.filter(match).forEach(r => Object.assign(r, st.payload)); }
        if (st.op === 'upsert') {
          const added = [];
          for (const r of st.payload) {
            if (rows.some(x => x.user_id === r.user_id && x.external_id && x.external_id === r.external_id)) continue;
            const row = Object.assign({ id: 'rev' + (rows.length + 1) }, r); rows.push(row); added.push({ id: row.id });
          }
          out.data = added;
        }
        return Promise.resolve(out).then(res, rej);
      };
      if (prop === 'select') return () => q;
      if (prop === 'update') return p => { st.op = 'update'; st.payload = p; return q; };
      if (prop === 'upsert') return (p, o) => { st.op = 'upsert'; st.payload = p; st.opts = o; return q; };
      if (prop === 'eq' || prop === 'gte') return (c, v) => { st.filters.push([prop, c, v]); return q; };
      if (prop === 'or') return () => q;   // runAll's "due" filter; the test controls what is due
      if (prop === 'maybeSingle') return () => { st.single = true; return q; };
      return () => q;
    } });
    return q;
  };
  return { from, rpc: async (fn, args) => (fn === 'payment_connection_secret' ? { data: store._keys[args.p_id] || null, error: null } : { data: null, error: { message: 'unknown rpc' } }), store };
}

(async () => {
  console.log('The key:');
  ok('a live restricted key is accepted', stripe.checkKey(' ' + KEY + ' ').key === KEY);
  ok('a full secret key is refused, with a warning never to share it', /Never share it/.test(stripe.checkKey(fakeKey('sk', 'live')).error || ''));
  ok('test-mode and publishable keys are refused', /test-mode/.test(stripe.checkKey(fakeKey('rk', 'test')).error) && /publishable/.test(stripe.checkKey(fakeKey('pk', 'live')).error));
  ok('anything else is refused', !!stripe.checkKey('hello').error && !!stripe.checkKey('').error);
  ok('Stripe refusals become something a member can act on', /not valid any more/.test(stripe.explain(401)) && /Charges and Invoices to Read/.test(stripe.explain(403, { error: { message: 'rak_charge_read' } })));

  console.log('\nCharges into income:');
  {
    const r = stripe.rowOf('me', charge('ch_1', '2026-11-02T10:00:00Z', 2900, { description: 'Subscription update', billing_details: { name: 'Ada' }, invoice: { id: 'in_1', subscription: 'sub_1', billing_reason: 'subscription_cycle', number: 'A-1' } }));
    ok('a subscription payment: $29.00, dated, from the customer, ticked Recurring, with its Stripe id', r.amount === 29 && r.entry_date === '2026-11-02' && r.source === 'Stripe · Ada' && r.is_recurring === true && r.external_id === 'stripe:ch_1' && r.entry_type === 'revenue', JSON.stringify(r));
    const oneOff = stripe.rowOf('me', charge('ch_2', '2026-11-03T10:00:00Z', 120000, { invoice: { id: 'in_2', subscription: null, billing_reason: 'manual', number: 'A-2' } }));
    ok('an invoice that is not a subscription is income but not Recurring', oneOff.amount === 1200 && oneOff.is_recurring === false && oneOff.description === 'Invoice A-2' && oneOff.source === 'Stripe');
    ok('a partly refunded payment counts what was kept', stripe.rowOf('me', charge('ch_3', '2026-11-03', 5000, { amount_refunded: 2000 })).amount === 30);
    ok('a fully refunded, failed, pending or uncaptured one is not income', [charge('a', '2026-11-03', 5000, { amount_refunded: 5000 }), charge('b', '2026-11-03', 5000, { status: 'failed' }), charge('c', '2026-11-03', 5000, { status: 'pending' }), charge('d', '2026-11-03', 5000, { captured: false })].every(c => stripe.rowOf('me', c) === null));
    ok('yen are whole units, and the currency is kept', stripe.rowOf('me', charge('ch_j', '2026-11-03', 3000, { currency: 'jpy' })).amount === 3000 && stripe.rowOf('me', charge('ch_j', '2026-11-03', 3000, { currency: 'jpy' })).currency === 'JPY');
    ok('without invoice access, a subscription is still recognised from its description', stripe.rowOf('me', charge('ch_4', '2026-11-03', 900, { invoice: 'in_4', description: 'Subscription creation' })).is_recurring === true);
  }

  console.log('\nSyncing:');
  {
    const charges = [];
    for (let i = 0; i < 150; i++) charges.push(charge('ch_' + i, new Date(Date.UTC(2026, 9, 1) + i * 3600 * 1000 * 4).toISOString(), 1000 + i, i % 3 === 0 ? { invoice: { id: 'in_' + i, subscription: 'sub_x', billing_reason: 'subscription_cycle' } } : {}));
    charges.push(charge('ch_ref', '2026-11-10T00:00:00Z', 4000, { amount_refunded: 4000 }));
    charges.push(charge('ch_hand', '2026-11-12T09:00:00Z', 5000));   // already typed in by hand
    const store = { _keys: { c1: KEY }, payment_connections: [{ id: 'c1', user_id: 'me', provider: 'stripe', status: 'active', imported_count: 0, synced_through: null }],
      revenue_entries: [{ id: 'm1', user_id: 'me', entry_type: 'revenue', entry_date: '2026-11-12', amount: 50, source: 'Cash', external_id: null }] };
    const sc = fakeSc(store);
    const api = fakeStripe(charges);
    const conn = store.payment_connections[0];
    const r = await stripe.syncConnection(sc, Object.assign({}, conn), { fetchImpl: api, now: NOW });
    const synced = store.revenue_entries.filter(x => x.external_id);
    ok('every succeeded charge across both pages is logged once', r.imported === 150 && synced.length === 150 && new Set(synced.map(x => x.external_id)).size === 150, JSON.stringify(r));
    ok('the refunded one is left out, and the one typed in by hand is not added again', !synced.some(x => x.external_id === 'stripe:ch_ref') && !synced.some(x => x.external_id === 'stripe:ch_hand') && r.skipped === 1);
    ok('subscription payments are ticked Recurring', synced.filter(x => x.is_recurring).length === 50);
    ok('the first sync reads a year back, with the key, the pinned API version and invoices expanded', api.calls[0].url.searchParams.get('created[gte]') === String(t('2026-11-20T12:00:00Z') - 365 * 86400) && api.calls[0].auth === 'Bearer ' + KEY && api.calls[0].version === stripe.VERSION && api.calls[0].url.searchParams.get('expand[]') === 'data.invoice');
    ok('...and pages with starting_after', api.calls.length === 2 && !!api.calls[1].url.searchParams.get('starting_after'));
    ok('the connection records the sync', conn.status === 'active' && conn.imported_count === 150 && conn.last_synced_at === NOW.toISOString() && conn.synced_through === new Date(t('2026-11-12T09:00:00Z') * 1000).toISOString(), JSON.stringify(conn));

    const api2 = fakeStripe(charges);
    const again = await stripe.syncConnection(sc, Object.assign({}, conn), { fetchImpl: api2, now: NOW });
    ok('syncing again adds nothing', again.imported === 0 && store.revenue_entries.filter(x => x.external_id).length === 150);
    ok('...and only re-reads from two days before where it got to', api2.calls[0].url.searchParams.get('created[gte]') === String(t('2026-11-12T09:00:00Z') - 2 * 86400));
  }
  {
    const store = { _keys: { c1: KEY }, payment_connections: [{ id: 'c1', user_id: 'me', provider: 'stripe', status: 'active', imported_count: 0 }], revenue_entries: [] };
    const r = await stripe.syncConnection(fakeSc(store), store.payment_connections[0], { fetchImpl: fakeStripe([charge('ch_a', '2026-11-02', 900, { invoice: { id: 'in_a', subscription: 'sub' }, description: 'Subscription update' })], { noInvoices: true }), now: NOW });
    ok('a key without invoice access still syncs', r.imported === 1 && r.invoices === false && store.revenue_entries[0].is_recurring === true);
  }
  {
    const store = { _keys: { c1: KEY }, payment_connections: [{ id: 'c1', user_id: 'me', provider: 'stripe', status: 'active', imported_count: 0 }], revenue_entries: [] };
    const r = await stripe.syncConnection(fakeSc(store), store.payment_connections[0], { fetchImpl: fakeStripe([], { status: 401 }), now: NOW });
    ok('a deleted key marks the connection as needing attention, with the reason', /not valid any more/.test(r.error) && store.payment_connections[0].status === 'error' && /not valid/.test(store.payment_connections[0].last_error));
  }
  {
    const many = [];
    for (let i = 0; i < 250; i++) many.push(charge('ch_' + i, new Date(Date.UTC(2026, 9, 1) + i * 3600 * 1000).toISOString(), 1000));
    const prev = '2026-09-20T00:00:00.000Z';
    const store = { _keys: { c1: KEY }, payment_connections: [{ id: 'c1', user_id: 'me', provider: 'stripe', status: 'active', imported_count: 0, synced_through: prev }], revenue_entries: [] };
    const r = await stripe.syncConnection(fakeSc(store), store.payment_connections[0], { fetchImpl: fakeStripe(many, { failPage: 1 }), now: NOW });
    ok('a sync that fails partway keeps what it got, but does not move past the older charges it missed', r.imported === 100 && store.payment_connections[0].synced_through === prev && store.payment_connections[0].status === 'error');
  }
  {
    const store = { _keys: {}, payment_connections: [{ id: 'c9', user_id: 'me', provider: 'stripe', status: 'active', imported_count: 0 }], revenue_entries: [] };
    const r = await stripe.syncConnection(fakeSc(store), store.payment_connections[0], { fetchImpl: fakeStripe([]), now: NOW });
    ok('a key that cannot be read stops the sync with a reason', /could not be read/.test(r.error) && store.payment_connections[0].status === 'error');
  }
  {
    const store = { _keys: { c1: KEY, c2: KEY }, payment_connections: [
      { id: 'c1', user_id: 'a', provider: 'stripe', status: 'active', imported_count: 0 },
      { id: 'c2', user_id: 'b', provider: 'stripe', status: 'error', imported_count: 0 }], revenue_entries: [] };
    const r = await stripe.runAll(fakeSc(store), { fetchImpl: fakeStripe([charge('ch_z', '2026-11-02', 700)]), now: NOW });
    ok('the timer syncs every connection that is due, each into its own log', r.connections === 2 && r.imported === 2 && store.revenue_entries.filter(x => x.user_id === 'a').length === 1 && store.revenue_entries.filter(x => x.user_id === 'b').length === 1);
    ok('server.js runs it on a timer', /stripeSync\.runAll\(sc\)/.test(read('server.js')));
  }

  console.log('\nThe connect page, end to end:');
  {
    const store = { _keys: {}, payment_connections: [], revenue_entries: [] };
    const sc = fakeSc(store);
    fakeService.current = sc;
    const rpcs = [];
    // The member's own client: reads their connection, connects and disconnects through the functions.
    const userSb = {
      from: table => sc.from(table),
      rpc: async (fn, args) => {
        rpcs.push({ fn, args });
        if (fn === 'payment_connect_stripe') { store.payment_connections.push({ id: 'c1', user_id: 'me', provider: 'stripe', key_hint: args.p_key.slice(-4), status: 'active', imported_count: 0 }); store._keys.c1 = args.p_key; return { data: 'c1', error: null }; }
        if (fn === 'payment_disconnect') { store.payment_connections.length = 0; return { data: true, error: null }; }
        return { data: null, error: null };
      }
    };
    const realFetch = global.fetch;
    const fakeApi = fakeStripe([charge('ch_p1', '2026-10-02T10:00:00Z', 2900, { invoice: { id: 'in', subscription: 'sub' }, description: 'Subscription update' }), charge('ch_p2', '2026-10-05T10:00:00Z', 15000)]);
    global.fetch = (url, opts) => (String(url).startsWith('https://api.stripe.com/') ? fakeApi(url, opts) : realFetch(url, opts));
    const app = express();
    app.set('view engine', 'ejs'); app.set('views', path.join(ROOT, 'views'));
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
      req.sb = userSb; req.user = { id: 'me' }; req.profile = { id: 'me', username: 'me', path: 'software' };
      Object.assign(res.locals, { user: req.user, profile: req.profile, plan: 'free', currentPath: req.path, canonicalUrl: 'x', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } });
      next();
    });
    app.use('/budget', require('../src/routes/budget'));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (p, body) => realFetch(base + p, { method: 'POST', body: new URLSearchParams(body || {}), redirect: 'manual' }).then(r => decodeURIComponent(r.headers.get('location') || ''));
    try {
      const page = await (await realFetch(base + '/budget/connect/stripe')).text();
      ok('the page explains how to make the read-only key', page.includes('Create restricted key') && page.includes('<strong>Charges</strong> to <strong>Read</strong>') && page.includes('<strong>Invoices</strong> to <strong>Read</strong>') && page.includes('rk_live_'));
      ok('...and the key field is not remembered by the browser', /name="key"[^>]*autocomplete="off"/.test(page));

      const refused = await post('/budget/connect/stripe', { key: fakeKey('sk', 'live') });
      ok('pasting a full secret key is refused before anything is stored', /Never share it/.test(refused) && !rpcs.length && !fakeApi.calls.length);

      const done = await post('/budget/connect/stripe', { key: KEY });
      ok('a good key is checked with Stripe, stored through the database function, and synced straight away', /Connected\. Synced: 2 new payments from Stripe/.test(done) && rpcs[0].fn === 'payment_connect_stripe' && rpcs[0].args.p_key === KEY && store.revenue_entries.length === 2, done);
      ok('...the subscription payment ticked Recurring', store.revenue_entries.find(x => x.external_id === 'stripe:ch_p1').is_recurring === true);

      const after = await (await realFetch(base + '/budget/connect/stripe')).text();
      ok('the page then shows the connection by its last four characters only, never the key', after.includes('Key ending <strong>1234</strong>') && !after.includes(KEY) && after.includes('Sync now'));

      store.payment_connections[0].last_synced_at = new Date().toISOString();
      ok('Sync now is not hammered: once a minute at most', /less than a minute ago/.test(await post('/budget/connect/stripe/sync')));
      store.payment_connections[0].last_synced_at = new Date(Date.now() - 3600000).toISOString();
      ok('...after that it syncs, and finds nothing new', /Nothing new from Stripe/.test(await post('/budget/connect/stripe/sync')));

      const gone = await post('/budget/connect/stripe/disconnect');
      ok('disconnecting goes through the database function and keeps the payments', /Disconnected/.test(gone) && rpcs.some(x => x.fn === 'payment_disconnect') && store.payment_connections.length === 0 && store.revenue_entries.length === 2);
    } finally { server.close(); global.fetch = realFetch; }
  }

  console.log('\nOn the Money page and in the migration:');
  ok('the income log links to Connect Stripe, and says when it is connected', /href="\/budget\/connect\/stripe">Connect Stripe/.test(read('views/budget.ejs')) && /Stripe connected/.test(read('views/budget.ejs')));
  {
    const sql = read('migrations/2026-11-08_stripe_connection.sql');
    ok('the migration is marked as not applied yet, and listed as pending', /^-- NOT APPLIED/.test(sql) && JSON.parse(read('test/schema-pending.json')).migrations['2026-11-08_stripe_connection.sql']);
    ok('keys live in the Vault, and only the sync job can read them', /vault\.create_secret/.test(sql) && /grant execute on function public\.payment_connection_secret\(uuid\) to service_role/.test(sql) && /revoke all on function public\.payment_connection_secret\(uuid\) from public, anon, authenticated/.test(sql));
    ok('members never get the column that points at the key', !/grant select \([^)]*secret_id/.test(sql));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
