// Affiliate networks in the income log (src/connections/affiliates,
// src/connections/affiliate_common.js, src/routes/connect.js): a member pastes
// their own read-only details for impact.com, CJ, Awin, Rakuten, PartnerStack,
// ClickBank, Travelpayouts or Admitad; approved commissions come in as income,
// pending ones as a total on the way, reversed ones come back out. Amazon
// Associates comes in through the CSV import. Every outside call is a fake.
//
//   node test/affiliate_connections.js        (AFF_OUT=dir also writes the pages as HTML)

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
const A = require('../src/connections/affiliate_common');
const AF = require('../src/connections/affiliates');

// fetch fake: routes[url-prefix] → (url, opts) => [status, body (object or CSV text)].
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find(k => url.startsWith(k));
    if (!key) return { status: 404, json: async () => ({}), text: async () => '' };
    const [status, body] = await routes[key](url, opts);
    return { status, json: async () => { if (typeof body === 'string') throw new Error('not json'); return body; }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  f.calls = calls;
  return f;
}
function fakeSb(answers = {}, rpcs = {}) {
  const writes = [], calls = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, eq: {}, in: {}, single: false };
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
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return (p, o) => { state.op = k; state.payload = p; writes.push({ table, op: k, payload: p, opts: o, state }); return chain; };
        return () => chain;
      }
    });
    return chain;
  };
  return { from: q, writes, calls, rpc: (n, a) => { calls.push({ name: n, args: a }); const r = rpcs[n]; return Promise.resolve(typeof r === 'function' ? r(a) : (r || { data: null, error: null })); } };
}
const now = new Date('2026-11-18T15:00:00Z');
const scFor = secret => fakeSb({
  revenue_entries: s => ({ data: s.op === 'upsert' ? s.payload.map((r, i) => ({ id: 'r' + i })) : s.op === 'delete' ? (s.in.external_id || []).filter(id => /rev/.test(id)).map(id => ({ id })) : [], error: null })
}, { payment_connection_secret: { data: JSON.stringify(secret), error: null } });
const upserted = sc => (sc.writes.find(w => w.table === 'revenue_entries' && w.op === 'upsert') || { payload: [] }).payload;
const pendingOf = sc => (sc.writes.find(w => w.table === 'payment_connections' && w.payload.pending) || { payload: {} }).payload.pending;

(async () => {
  console.log('Commissions to income:');
  const net = { key: 'impact', label: 'impact.com' };
  const r0 = A.rowsOf('me', net, [
    { id: 'a1', amount: 12.5, currency: 'usd', date: '2026-11-02', state: 'approved', advertiser: 'Canva' },
    { id: 'a2', amount: 8, currency: 'USD', date: '2026-11-03', state: 'pending' },
    { id: 'a3', amount: 4, currency: 'EUR', date: '2026-11-03', state: 'pending' },
    { id: 'a4', amount: 3, currency: 'USD', date: '2026-11-04', state: 'reversed' },
    { id: 'a5', amount: 0, currency: 'USD', date: '2026-11-04', state: 'approved' },
    { id: 'a6', amount: 5, date: '2026-11-04', state: 'mystery' }
  ]);
  ok('approved ones become income, named for the network and the brand', r0.income.length === 1 && r0.income[0].external_id === 'impact:a1' && r0.income[0].source === 'impact.com · Canva' && r0.income[0].currency === 'USD' && r0.income[0].amount === 12.5);
  ok('pending ones are a total per currency, not income', JSON.stringify(r0.pending) === '{"USD":8,"EUR":4}' && r0.pendingCount === 2);
  ok('reversed ones are listed to take back out; zero and unknown ones are left alone', r0.reversed.join() === 'impact:a4');
  const nt = A.netted([{ id: 'x1', order: 'o1', amount: 10, state: 'approved' }, { id: 'x2', order: 'o1', amount: -10, state: 'approved' }, { id: 'x3', order: 'o2', amount: 7, state: 'approved' }, { id: 'x4', order: 'o2', amount: -2, state: 'approved' }], i => i.order);
  ok('a return reported as a negative record nets out the order', nt.find(i => i.id === 'x1').state === 'reversed' && nt.find(i => i.id === 'x3').amount === 5 && nt.length === 2);
  ok('each sync re-reads four months, so late approvals are caught; the first goes back a year', A.sinceOf({ synced_through: '2026-11-17T00:00:00Z' }, now).toISOString().slice(0, 10) === '2026-07-21' && A.sinceOf({}, now).toISOString().slice(0, 10) === '2025-11-18');
  ok('long reads are split into windows', A.windows(new Date('2026-01-01'), new Date('2026-03-01'), 31).length === 2);
  {
    const sc = scFor({});
    const r = await A.saveCommissions(sc, { id: 'c1', user_id: 'me', imported_count: 2 }, net, [
      { id: 'a1', amount: 12.5, date: '2026-11-02', state: 'approved' }, { id: 'rev1', amount: 3, date: '2026-11-02', state: 'reversed' }, { id: 'a2', amount: 8, date: '2026-11-03', state: 'pending' }
    ], { now });
    const del = sc.writes.find(w => w.table === 'revenue_entries' && w.op === 'delete');
    ok('saving logs the approved, removes the reversed, and records the pending total', r.imported === 1 && r.removed === 1 && del.state.in.external_id.join() === 'impact:rev1' && del.state.eq.user_id === 'me' && pendingOf(sc).amounts.USD === 8 && pendingOf(sc).count === 1);
    const sc2 = scFor({});
    await A.saveCommissions(sc2, { id: 'c1', user_id: 'me' }, net, [{ id: 'a2', amount: 8, date: '2026-11-03', state: 'pending' }], { now, complete: false });
    ok('...but a read that stopped part-way leaves the pending total alone', !pendingOf(sc2));
  }
  ok('"$8.00 pending" reads plainly', AF.pendingText({ pending: { amounts: { USD: 8, EUR: 4 }, count: 2 } }) === '$8.00 + €4.00 pending' && AF.pendingText({ pending: { amounts: {}, count: 0 } }) === '' && AF.pendingText(null) === '');

  console.log('\nimpact.com:');
  const impact = AF.BY.impact;
  ok('it needs an Account SID and a token', !!impact.checkInput({ sid: 'x', token: 'y' }).error && !impact.checkInput({ sid: 'IRabc1234567', token: 'tok_' + 'a'.repeat(24) }).error);
  {
    let pages = 0;
    const f = fakeFetch({ 'https://api.impact.com/Mediapartners/IRabc1234567/Actions': (u, o) => {
      if (!/^Basic /.test(o.headers.Authorization)) return [401, {}];
      if (!/ActionDateStart=2026-10-17|Page=2/.test(u)) return [200, { Actions: [] }];
      pages++;
      return [200, pages === 1
        ? { '@nextpageuri': '/Mediapartners/IRabc1234567/Actions?Page=2', Actions: [{ Id: '1.2', Payout: '12.50', Currency: 'USD', EventDate: '2026-11-02T10:00:00-05:00', State: 'APPROVED', CampaignName: 'Canva' }] }
        : { Actions: [{ Id: '1.3', Payout: '4.00', Currency: 'USD', EventDate: '2026-11-03T10:00:00-05:00', State: 'PENDING', CampaignName: 'Notion' }, { Id: '1.4', Payout: '2.00', Currency: 'USD', EventDate: '2026-11-03', State: 'REVERSED' }] }];
    } });
    const sc = scFor({ sid: 'IRabc1234567', token: 'tok' });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'impact', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    ok('actions are read with Basic auth as JSON, following the next page', f.calls[0].opts.headers.Accept === 'application/json' && f.calls.some(c => /Page=2/.test(c.url)));
    ok('...in windows under 45 days', f.calls.filter(c => /ActionDateStart/.test(c.url)).length >= 3);
    ok('approved ones become income, pending ones a total', r.imported === 1 && upserted(sc)[0].external_id === 'impact:1.2' && upserted(sc)[0].source === 'impact.com · Canva' && pendingOf(sc).amounts.USD === 4);
    ok('a refused token says so', /did not accept/.test((await impact.verify({ sid: 'IRabc1234567', token: 'x' }, { fetchImpl: fakeFetch({ 'https://api.impact.com/': () => [401, {}] }), now })).error));
  }

  console.log('\nCJ:');
  const cj = AF.BY.cj;
  ok('it needs a CID and a token', !!cj.checkInput({ cid: 'abc', token: 'x' }).error && cj.checkInput({ cid: '1234567', token: 'a'.repeat(30) }).secret.cid === '1234567');
  {
    const f = fakeFetch({ 'https://commissions.api.cj.com/query': (u, o) => [200, { data: { publisherCommissions: { count: 3, payloadComplete: true, records: /sincePostingDate: \\"2026-10-19/.test(o.body) ? [
      { commissionId: 'k1', orderId: 'o1', actionStatus: 'locked', advertiserId: 'ad1', advertiserName: 'Shoe Co', eventDate: '2026-11-01T10:00:00Z', postingDate: '2026-11-01T12:00:00Z', pubCommissionAmountUsd: 20 },
      { commissionId: 'k2', orderId: 'o1', actionStatus: 'locked', advertiserId: 'ad1', advertiserName: 'Shoe Co', eventDate: '2026-11-05T10:00:00Z', postingDate: '2026-11-05T12:00:00Z', pubCommissionAmountUsd: -5 },
      { commissionId: 'k3', orderId: 'o2', actionStatus: 'new', advertiserId: 'ad2', advertiserName: 'Bag Co', eventDate: '2026-11-06T10:00:00Z', postingDate: '2026-11-06T12:00:00Z', pubCommissionAmountUsd: 9 }
    ] : [] } } }] });
    const sc = scFor({ cid: '1234567', token: 'tok' });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'cj', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    ok('it asks the Commission Detail API for this publisher, with a Bearer token', /forPublishers: \["1234567"\]/.test(JSON.parse(f.calls[0].opts.body).query) && f.calls[0].opts.headers.Authorization === 'Bearer tok');
    ok('a return nets the order; locked ones are income, new ones pending', r.imported === 1 && upserted(sc)[0].amount === 15 && upserted(sc)[0].external_id === 'cj:k1' && pendingOf(sc).amounts.USD === 9);
    let split = 0;
    const f2 = fakeFetch({ 'https://commissions.api.cj.com/query': () => { split++; return [200, { data: { publisherCommissions: { payloadComplete: split > 1, records: [] } } }]; } });
    await AF.sync(scFor({ cid: '1234567', token: 'tok' }), { id: 'c1', user_id: 'me', provider: 'cj', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f2, now });
    ok('a window CJ cannot return in full is split in half', split > 4);
    ok('a GraphQL "not authorized" error reads as refused', /did not accept/.test((await cj.verify({ cid: '1', token: 't' }, { fetchImpl: fakeFetch({ 'https://commissions.api.cj.com/query': () => [200, { errors: [{ message: 'Not Authorized' }] }] }), now })).error));
  }

  console.log('\nAwin (and former ShareASale):');
  const awin = AF.BY.awin;
  ok('it needs a token; the publisher ID is optional', !awin.checkInput({ token: 'a1b2c3d4-0000-1111-2222-333344445555' }).error && !!awin.checkInput({ token: 'a1b2c3d4-0000-1111-2222-333344445555', publisher_id: 'abc' }).error);
  {
    const f = fakeFetch({
      'https://api.awin.com/accounts': () => [200, { accounts: [{ accountId: 98765, accountName: 'Ana Blog', accountType: 'publisher' }, { accountId: 1, accountName: 'Adv', accountType: 'advertiser' }] }],
      'https://api.awin.com/publishers/98765/programmes': () => [200, [{ id: 11, name: 'Garden Shop' }]],
      'https://api.awin.com/publishers/98765/transactions/': (u) => [200, /startDate=2026-10-2/.test(u) ? [
        { id: 555, advertiserId: 11, commissionAmount: { amount: 6.4, currency: 'GBP' }, commissionStatus: 'approved', transactionDate: '2026-11-01T09:00:00' },
        { id: 556, advertiserId: 11, commissionAmount: { amount: 3, currency: 'GBP' }, commissionStatus: 'pending', transactionDate: '2026-11-02T09:00:00' },
        { id: 557, advertiserId: 11, commissionAmount: { amount: 2, currency: 'GBP' }, commissionStatus: 'declined', transactionDate: '2026-11-02T09:00:00' }
      ] : []]
    });
    const v = await awin.verify({ token: 't' }, { fetchImpl: f });
    ok('it finds the publisher account behind the token', v.ok && v.meta.publisher_id === '98765' && v.label === 'Ana Blog · publisher 98765');
    ok('...or says the named one is not there', /cannot see publisher account 4/.test((await awin.verify({ token: 't' }, { fetchImpl: f, publisherId: '4' })).error));
    const sc = scFor({ token: 't' });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'awin', meta: { publisher_id: '98765' }, synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    const tx = f.calls.filter(c => /transactions/.test(c.url));
    ok('transactions are read 31 days at a time, in UTC', tx.length === 4 && tx.every(c => /timezone=UTC/.test(c.url) && /dateType=transaction/.test(c.url)));
    ok('approved ones come in with the programme name and currency', r.imported === 1 && upserted(sc)[0].source === 'Awin · Garden Shop' && upserted(sc)[0].currency === 'GBP' && pendingOf(sc).amounts.GBP === 3);
  }

  console.log('\nRakuten Advertising:');
  const rak = AF.BY.rakuten;
  const link = 'https://ran-reporting.rakutenmarketing.com/en/reports/signature-activity-report/filters?start_date=2026-01-01&end_date=2026-01-31&include_summary=Y&network=1&tz=GMT&date_type=process&token=ZW5jcnlwdGVk';
  ok('only a Rakuten report link with a token is taken', !rak.checkInput({ url: link }).error && !!rak.checkInput({ url: 'https://evil.example.com/en/reports/x/filters?token=1' }).error && !!rak.checkInput({ url: link.replace(/&token=[^&]+/, '') }).error);
  const swapped = new URL(rak.linkFor({ url: link }, new Date('2026-10-01'), new Date('2026-11-18')));
  ok('...and only its dates are changed', swapped.searchParams.get('start_date') === '2026-10-01' && swapped.searchParams.get('end_date') === '2026-11-18' && swapped.searchParams.get('token') === 'ZW5jcnlwdGVk' && swapped.searchParams.get('network') === '1' && swapped.searchParams.get('date_type') === 'transaction');
  {
    const csvText = 'Member ID,MID,Advertiser Name,Order ID,Transaction Date,Transaction Time,SKU,Sales,# of Items,Total Commission,Process Date\n'
      + 'ana,123,Shoe Co,ORD1,11/02/2026,10:00:00,S1,"$100.00",1,"$8.00",11/03/2026\n'
      + 'ana,123,Shoe Co,ORD1,11/05/2026,10:00:00,S1,"-$50.00",-1,"-$4.00",11/06/2026\n'
      + 'ana,456,Hat Co,ORD2,11/06/2026,10:00:00,H1,"$30.00",1,"$2.40",11/07/2026\n';
    const f = fakeFetch({ 'https://ran-reporting.rakutenmarketing.com/': () => [200, csvText] });
    const sc = scFor({ url: link });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'rakuten', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    ok('the CSV is read by column name, returns netted per order', r.imported === 2 && upserted(sc).map(x => x.amount + '@' + x.source).join() === '4@Rakuten Advertising · Shoe Co,2.4@Rakuten Advertising · Hat Co');
    const bad = await rak.verify({ url: link }, { fetchImpl: fakeFetch({ 'https://ran-reporting.rakutenmarketing.com/': () => [200, 'Advertiser,Clicks\nShoe Co,40\n'] }), now });
    ok('a report without commissions is refused with a reason', !bad.ok && /no commission and date columns/.test(bad.error));
  }

  console.log('\nPartnerStack:');
  {
    const f = fakeFetch({ 'https://api.partnerstack.com/api/v2/rewards': (u, o) => [o.headers.Authorization === 'Bearer pk' ? 200 : 401, { data: { has_more: false, items: [
      { key: 'rew_1', amount: 2500, currency: 'USD', status: 'approved', created_at: 1762300000000, company: { name: 'Notion' } },
      { key: 'rew_2', amount: 1000, currency: 'USD', status: 'pending', created_at: 1762400000000, company: { name: 'Notion' } },
      { key: 'rew_3', amount: 500, currency: 'USD', status: 'declined', created_at: 1762400000000 }
    ] } }] });
    const sc = scFor({ key: 'pk' });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'partnerstack', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    ok('rewards are read with the partner key, amounts in cents', r.imported === 1 && upserted(sc)[0].amount === 25 && upserted(sc)[0].source === 'PartnerStack · Notion' && pendingOf(sc).amounts.USD === 10 && /min_created=\d{13}/.test(f.calls[0].url));
  }

  console.log('\nClickBank:');
  const cb = AF.BY.clickbank;
  ok('only an API- key is taken', !!cb.checkInput({ key: 'DEV-123' }).error && !cb.checkInput({ key: 'API-ABCDEFGH1234567890' }).error);
  {
    let page = 0;
    const f = fakeFetch({ 'https://api.clickbank.com/rest/1.3/orders2/list': (u, o) => {
      if (o.headers.Authorization !== 'API-KEY1234567890') return [403, {}];
      if (!/startDate=2026-10/.test(u)) return [200, { orderData: [] }];
      page++;
      return page === 1
        ? [206, { orderData: [{ receipt: 'ABC123', transactionTime: '2026-11-02T10:00:00-08:00', transactionType: 'SALE', totalAccountAmount: 31.2, currency: 'USD', vendor: 'yogabook' }] }]
        : [200, { orderData: [{ receipt: 'ABC123', transactionTime: '2026-11-04T10:00:00-08:00', transactionType: 'RFND', totalAccountAmount: -31.2, currency: 'USD', vendor: 'yogabook' }, { receipt: 'XYZ9', transactionTime: '2026-11-05T10:00:00-08:00', transactionType: 'SALE', totalAccountAmount: 12, vendor: 'fitapp' }] }];
    } });
    const sc = scFor({ key: 'API-KEY1234567890' });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'clickbank', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    const del = sc.writes.find(w => w.table === 'revenue_entries' && w.op === 'delete');
    ok('affiliate orders are read page by page, as AFFILIATE', f.calls.every(c => /role=AFFILIATE/.test(c.url)) && f.calls.some(c => c.opts.headers.Page === '2'));
    ok('sales are income; a refund takes its sale back out', upserted(sc).map(x => x.external_id).join() === 'clickbank:ABC123,clickbank:XYZ9' && del && del.state.in.external_id.join() === 'clickbank:ABC123');
  }

  console.log('\nTravelpayouts:');
  {
    const f = fakeFetch({
      'https://api.travelpayouts.com/finance/v2/get_user_balance': (u, o) => [o.headers['X-Access-Token'] === 'tp' + 'a'.repeat(30) ? 200 : 401, { balance: {} }],
      'https://api.travelpayouts.com/finance/v2/get_user_actions_affecting_balance': () => [200, { actions: [
        { action_id: '100:01', campaign_id: 100, action_state: 'paid', profit: 14.2, created_at: '2026-11-01 10:00:00' },
        { action_id: '100:02', campaign_id: 100, action_state: 'processing', profit: 6, created_at: '2026-11-02 10:00:00' },
        { action_id: '100:03', campaign_id: 100, action_state: 'cancelled', profit: 3, created_at: '2026-11-02 10:00:00' }
      ] }]
    });
    ok('the token is checked against the balance', (await AF.BY.travelpayouts.verify({ token: 'tp' + 'a'.repeat(30) }, { fetchImpl: f })).ok && !(await AF.BY.travelpayouts.verify({ token: 'nope' }, { fetchImpl: f })).ok);
    const sc = scFor({ token: 'tp' + 'a'.repeat(30) });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'travelpayouts', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    ok('paid actions are income in dollars, processing ones pending', r.imported === 1 && upserted(sc)[0].amount === 14.2 && upserted(sc)[0].currency === 'USD' && pendingOf(sc).amounts.USD === 6 && f.calls.some(c => /currency=usd/.test(c.url)));
  }

  console.log('\nAdmitad:');
  {
    const f = fakeFetch({
      'https://api.admitad.com/token/': (u, o) => [/scope=statistics/.test(o.body) && !/scope=.*(advcampaigns|manage)/.test(o.body) ? 200 : 400, { access_token: 'adm' }],
      'https://api.admitad.com/statistics/actions/': (u, o) => [o.headers.Authorization === 'Bearer adm' ? 200 : 401, { _meta: { count: 3 }, results: [
        { action_id: 9001, payment: 7.5, currency: 'EUR', action_date: '2026-11-03 12:00:00', status: 'approved', advcampaign_name: 'AliExpress' },
        { action_id: 9002, payment: 2, currency: 'EUR', action_date: '2026-11-04 12:00:00', status: 'approved_but_stalled', advcampaign_name: 'AliExpress' },
        { action_id: 9003, payment: 1, currency: 'EUR', action_date: '2026-11-04 12:00:00', status: 'declined' }
      ] }]
    });
    const sc = scFor({ client_id: 'abcdefghij12', client_secret: 'zyxwvutsrq98' });
    const r = await AF.sync(sc, { id: 'c1', user_id: 'me', provider: 'admitad', synced_through: '2026-11-17T00:00:00Z' }, { fetchImpl: f, now });
    ok('it asks only for the read-only statistics scope', /scope=statistics/.test(f.calls[0].opts.body) && /^Basic /.test(f.calls[0].opts.headers.Authorization));
    ok('approved actions are income; held ones pending; dates as Admitad wants them', r.imported === 1 && upserted(sc)[0].source === 'Admitad · AliExpress' && pendingOf(sc).amounts.EUR === 2 && /date_start=21\.07\.2026/.test(f.calls[1].url));
  }

  console.log('\nConnecting:');
  {
    const stored = [];
    const sc = fakeSb({}, { payment_connection_store: a => { stored.push(a); return { data: 'c1', error: null }; } });
    const bad = await AF.connect(sc, 'me', 'impact', { sid: 'x' });
    ok('a bad paste is refused before anything is sent', !!bad.error && !stored.length);
    const f = fakeFetch({ 'https://api.awin.com/accounts': () => [200, { accounts: [{ accountId: 98765, accountName: 'Ana Blog', accountType: 'publisher' }] }] });
    const good = await AF.connect(sc, 'me', 'awin', { token: 'a1b2c3d4-0000-1111-2222-333344445555' }, { fetchImpl: f });
    ok('a good one is checked, then stored by the server with its account', good.ok && stored[0].p_provider === 'awin' && JSON.parse(stored[0].p_secret).token && stored[0].p_meta.publisher_id === '98765' && stored[0].p_label === 'Ana Blog · publisher 98765');
    const refused = await AF.connect(sc, 'me', 'awin', { token: 'a1b2c3d4-0000-1111-2222-333344445555' }, { fetchImpl: fakeFetch({ 'https://api.awin.com/accounts': () => [401, {}] }) });
    ok('...a refused one is not stored', /did not accept/.test(refused.error) && stored.length === 1);
    const scBad = scFor(null);
    const r = await AF.sync(fakeSb({}, { payment_connection_secret: { data: 'not json', error: null } }), { id: 'c1', user_id: 'me', provider: 'cj' }, { fetchImpl: fakeFetch({}) , now });
    ok('an unreadable secret asks to connect again', /connect CJ again/.test(r.error || '') && !!scBad);
  }
  ok('every network has a page: label, blurb, fields and where to find them', AF.list().length === 8 && AF.list().every(n => n.label && n.blurb && n.fields.length && n.where.length));
  ok('the background pass syncs affiliate networks too', require('../src/connections').ALL.impact.mod === AF && /Object\.keys\(ALL\)/.test(read('src/connections/index.js')));

  console.log('\nAmazon Associates (CSV):');
  const csv = require('../src/csv_import');
  const amz = 'Fee-Earnings report for ana-20\nCategory,Name,ASIN,Seller,Tracking ID,Date Shipped,Price,Items Shipped,Returns,Revenue,Ad Fees,Device Type Group\n'
    + 'Books,Atomic Habits,B07D23CFGR,Amazon,ana-20,2026-11-02,16.99,1,0,16.99,0.76,DESKTOP\n'
    + 'Home,Desk lamp,B0000LAMP1,Seller X,ana-20,2026-11-03,45.00,1,0,45.00,1.80,PHONE\n';
  const p = csv.plan(amz, { today: '2026-11-18' });
  ok('the earnings report is recognised and its commission is "Ad Fees", not the price', p.source === 'Amazon Associates' && p.rows.map(r => r.amount).join() === '0.76,1.8');
  ok('...each row is from Amazon Associates, with the product as the note', p.rows[0].source === 'Amazon Associates' && p.rows[0].description === 'Atomic Habits' && p.counts.import === 2);

  console.log('\nPages:');
  const base = { title: 'Connect', user: { id: 'me' }, profile: { id: 'me', username: 'ana' }, plan: 'free', currentPath: '/budget/connect', canonicalUrl: '', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
  const render = (v, d) => { try { return ejs.render(read('views/' + v), Object.assign({}, base, d), { filename: path.join(ROOT, 'views', v) }); } catch (e) { return 'ERR ' + e.message; } };
  const C = require('../src/connections');
  const hub = render('budget_connect.ejs', { by: { impact: { status: 'active', last_synced_at: '2026-11-18T12:00:00Z', imported_count: 5, pending: { amounts: { USD: 42.5 }, count: 3 } } }, ready: true, banks: [], banksReady: true, waiting: 0,
    providers: Object.values(C.PROVIDERS).map(x => ({ key: x.key, label: x.label, emoji: x.emoji, how: x.how, blurb: x.blurb, ready: true })), plaidReady: false, canSync: true, everyHours: 6,
    networks: AF.list(), affiliatesReady: true, pendingText: AF.pendingText });
  ok('the hub has an affiliate section with every network', !hub.startsWith('ERR') && hub.includes('id="affiliate"') && AF.KEYS.every(k => hub.includes('href="/budget/connect/affiliate/' + k + '"')), hub.startsWith('ERR') ? hub.slice(0, 300) : undefined);
  ok('...a connected one shows what is pending', hub.includes('$42.50 pending'));
  ok('...and Amazon points to the CSV import', /Amazon Associates[\s\S]*?Fee-Earnings[\s\S]*?href="\/budget\/import"/.test(hub));
  const hubOff = render('budget_connect.ejs', { by: {}, ready: true, banks: [], banksReady: true, waiting: 0, providers: [], plaidReady: false, canSync: true, everyHours: 6, networks: AF.list(), affiliatesReady: false, pendingText: AF.pendingText });
  ok('before the migration it says "being switched on"', (hubOff.match(/Being switched on/g) || []).length >= 8);
  const page = (key, conn) => render('budget_connect_affiliate.ejs', { net: AF.BY[key].network, conn, ready: true, pendingText: AF.pendingText, others: AF.list().filter(n => n.key !== key), canSync: true, everyHours: 6 });
  const pg = page('cj', null);
  ok('a network page asks for its own fields, secrets hidden', !pg.startsWith('ERR') && pg.includes('name="cid"') && /name="token" type="password"/.test(pg) && pg.includes('developers.cj.com'), pg.startsWith('ERR') ? pg.slice(0, 300) : undefined);
  ok('...the optional Awin publisher ID is not required', /name="publisher_id" type="text" spellcheck/.test(page('awin', null)));
  const pc = page('impact', { status: 'error', last_error: 'impact.com did not accept those details.', account_label: 'Account IRabc1…', last_synced_at: '2026-11-18T12:00:00Z', imported_count: 1, pending: { amounts: { USD: 4 }, count: 1 } });
  ok('...a connected one shows the pending total, the error, sync and disconnect', pc.includes('$4.00 pending') && pc.includes('did not accept') && pc.includes('action="/budget/connect/affiliate/impact/sync"') && pc.includes('action="/budget/connect/affiliate/impact/disconnect"'));
  const routes = read('src/routes/connect.js');
  ok('routes: a page, connect, sync and disconnect per network; secrets stored by the server', /'\/connect\/affiliate\/:network\(' \+ NETS \+ '\)'/.test(routes) && routes.includes("/sync'") && routes.includes("/disconnect'") && read('src/connections/affiliates/index.js').includes('store(sc, userId, key'));
  ok('the migration is marked applied, and pending is in the live snapshot', /^-- Applied live/.test(read('migrations/2026-11-18_affiliate_connections.sql')) && !require('./schema-pending.json').migrations['2026-11-18_affiliate_connections.sql'] && require('./schema-snapshot.json').columns.payment_connections.includes('pending'));

  if (process.env.AFF_OUT) {
    const fix = h => h.replace(/href="\/css\/([a-z]+)\.css\?v=\d+"/g, (m, n) => 'href="' + path.join(ROOT, 'public/css/' + n + '.css') + '"');
    fs.writeFileSync(path.join(process.env.AFF_OUT, 'hub.html'), fix(hub));
    fs.writeFileSync(path.join(process.env.AFF_OUT, 'impact.html'), fix(page('impact', { status: 'active', account_label: 'Account IRabc1…', last_synced_at: '2026-11-18T12:00:00Z', imported_count: 12, pending: { amounts: { USD: 42.5 }, count: 3 } })));
    fs.writeFileSync(path.join(process.env.AFF_OUT, 'cj.html'), fix(pg));
  }
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
