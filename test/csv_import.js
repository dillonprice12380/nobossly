// Importing payments into the income log from a CSV export
// (src/csv_import.js, the /budget/import routes, views/budget_import.ejs).
//
//   node test/csv_import.js

const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const csv = require('../src/csv_import');
const { FLAGS } = require('../src/features');
const TODAY = '2026-11-20';

const STRIPE = `id,Description,Seller Message,Created date (UTC),Amount,Amount Refunded,Currency,Captured,Converted Amount,Fee,Status,Customer Email
ch_1,Subscription update,Payment complete.,2026-11-02 14:03:11,29.00,0.00,usd,true,29.00,1.14,Paid,a@x.com
ch_2,"Invoice 0012, Pro plan",Payment complete.,2026-11-05 09:00:00,29.00,0.00,usd,true,29.00,1.14,Paid,b@x.com
ch_3,One-off setup,Payment complete.,2026-11-06 10:00:00,"1,200.00",0.00,usd,true,1200.00,35.10,Paid,c@x.com
ch_4,Subscription creation,Refunded,2026-11-07 10:00:00,29.00,29.00,usd,true,29.00,1.14,Refunded,d@x.com
ch_5,Subscription update,Declined,2026-11-07 11:00:00,29.00,0.00,usd,false,29.00,0,Failed,e@x.com
`;
const PAYPAL = `"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","Balance Impact"
"11/03/2026","10:01:02","PST","Jo Client","Express Checkout Payment","Completed","USD","150.00","-4.85","145.15","jo@x.com","Credit"
"11/04/2026","11:00:00","PST","","General Withdrawal","Completed","USD","-145.15","0.00","-145.15","","Debit"
"11/05/2026","12:00:00","PST","Sam","Subscription Payment","Completed","USD","9.99","-0.64","9.35","sam@x.com","Credit"
"11/06/2026","12:00:00","PST","Lee","Express Checkout Payment","Pending","USD","40.00","-1.46","38.54","lee@x.com","Credit"
`;
const BANK = 'Account Summary\r\nAccount,Checking ****1234\r\n\r\nPosting Date,Description,Debit,Credit,Balance\r\n10/01/2026,ACH DEPOSIT UPWORK ESCROW,,850.00,2350.00\r\n10/02/2026,COFFEE SHOP,4.50,,2345.50\r\n10/03/2026,ZELLE FROM JANE DOE,,120.00,2465.50\r\n10/10/2026,ACH DEPOSIT UPWORK ESCROW,,850.00,3315.50\r\n12/25/2099,FUTURE DEPOSIT,,10.00,3325.50\r\n';
const EU = '﻿Datum;Omschrijving;Bedrag\n08-11-2026;Klant A;1.234,56\n09-11-2026;Huur;-800,00\n13-11-2026;Klant B;45,50\n';
const SHEET = 'Day,Who,Money,Running\n2026-11-02,Client A,300.00,1300.00\n2026-11-03,Rent,-800.00,500.00\n2026-11-04,Client B,75,575\n';
const summary = p => p.rows.map(r => (r.skip ? 'skip:' + r.skip : r.date + ' ' + r.amount + (r.recurring ? ' R' : ''))).join(' | ');

(async () => {
  console.log('Reading values:');
  ok('amounts: $, thousands, brackets, minus, CR/DR, decimal comma', csv.amountOf('$1,234.50') === 1234.5 && csv.amountOf('(12.00)') === -12 && csv.amountOf('-40') === -40 && csv.amountOf('12.00 CR') === 12 && csv.amountOf('45.00 DR') === -45 && csv.amountOf('1.234,56') === 1234.56 && csv.amountOf('12,50', { comma: true }) === 12.5 && csv.amountOf('abc') === null);
  ok('dates: ISO with time, US, day-first, month names, compact', csv.dateOf('2026-11-08 14:02:11') === '2026-11-08' && csv.dateOf('11/08/2026') === '2026-11-08' && csv.dateOf('08/11/2026', true) === '2026-11-08' && csv.dateOf('Nov 8, 2026') === '2026-11-08' && csv.dateOf('08-Nov-26') === '2026-11-08' && csv.dateOf('20261108') === '2026-11-08');
  ok('impossible dates are refused', csv.dateOf('2026/02/30') === null && csv.dateOf('13/13/2026') === null && csv.dateOf('soon') === null);
  ok('day-first files are recognised from their dates', csv.dayFirst(['08/11/2026', '13/11/2026']) === true && csv.dayFirst(['11/08/2026', '11/13/2026']) === false && csv.dayFirst(['01/02/2026']) === null);
  ok('quoted fields, commas and newlines inside quotes, BOM, CRLF', JSON.stringify(csv.parse('﻿a,"b, c","d ""q"""\r\n1,"two\nlines",3\r\n')) === JSON.stringify([['a', 'b, c', 'd "q"'], ['1', 'two\nlines', '3']]));
  ok('semicolon and tab files are recognised', csv.delimiterOf('a;b;c\n1;2;3') === ';' && csv.delimiterOf('a\tb\tc\n1\t2\t3') === '\t' && csv.delimiterOf('a,b\n1,2') === ',');

  console.log('\nReal exports:');
  {
    const p = csv.plan(STRIPE, { today: TODAY });
    ok('Stripe: the paid charges come in, refunded and failed ones do not', summary(p) === '2026-11-02 29 R | 2026-11-05 29 R | 2026-11-06 1200 | skip:status | skip:status', summary(p));
    ok('...subscription and plan payments are ticked Recurring, the one-off is not', p.counts.recurring === 2 && p.counts.import === 3 && p.counts.total_amount === 1258);
    ok('...and the file is recognised as Stripe', p.source === 'Stripe');
  }
  {
    const p = csv.plan(PAYPAL, { today: TODAY });
    ok('PayPal: gross payments in, the withdrawal and the pending payment out', summary(p) === '2026-11-03 150 | skip:out | 2026-11-05 9.99 R | skip:status', summary(p));
    ok('...named after who paid', p.rows[0].source === 'Jo Client' && p.source === 'PayPal');
  }
  {
    const existing = [{ entry_date: '2026-10-10', amount: 850, source: 'ACH DEPOSIT UPWORK ESCROW' }];
    const p = csv.plan(BANK, { today: TODAY, existing });
    ok('a bank statement with a summary above the header is read from the real header', p.headers[0] === 'Posting Date' && p.source === 'Bank');
    ok('...credits come in, debits do not, a payment already logged is skipped, a future date is skipped', summary(p) === '2026-10-01 850 | skip:out | 2026-10-03 120 | skip:duplicate | skip:future', summary(p));
  }
  {
    const p = csv.plan(EU, { today: TODAY });
    ok('a Dutch semicolon file with decimal commas and day-first dates', summary(p) === '2026-11-08 1234.56 | skip:out | 2026-11-13 45.5', summary(p));
  }
  {
    const p = csv.plan(SHEET, { today: TODAY });
    ok('a home-made sheet: columns guessed from the values, and the running balance is not taken for the amount', p.columns.date === 0 && p.columns.amount === 2 && p.columns.description === 1 && summary(p) === '2026-11-02 300 | skip:out | 2026-11-04 75', JSON.stringify(p.columns));
  }
  {
    const twice = STRIPE + 'ch_6,One-off setup,Payment complete.,2026-11-06 10:00:00,"1,200.00",0.00,usd,true,1200.00,35.10,Paid,c@x.com\n';
    const p = csv.plan(twice, { today: TODAY });
    ok('the same payment twice in one file comes in once', p.counts.duplicate === 1 && p.counts.import === 3);
    const none = csv.plan(STRIPE, { today: TODAY, recurring: 'none' }), all = csv.plan(STRIPE, { today: TODAY, recurring: 'all' });
    ok('Recurring can be ticked for none or all instead', none.counts.recurring === 0 && all.counts.recurring === 3);
    const swapped = csv.plan(STRIPE, { today: TODAY, columns: { amount: 9 } });
    ok('a column the member picks overrides the guess', swapped.rows[2].amount === 35.1 && swapped.columns.amount === 9);
    const PAYOUTS = 'Date,Description,Amount\n2026-10-02,STRIPE TRANSFER ST-XYZ,58.00\n2026-10-03,PAYPAL TRANSFER,140.00\n2026-10-04,ZELLE FROM JANE,120.00\n2026-10-05,Balance,0\n';
    const bankish = csv.plan(PAYOUTS, { today: TODAY, source: 'Bank' });
    ok('a bank file counts the payouts from Stripe and PayPal, but still imports them by default', bankish.counts.payouts === 2 && bankish.counts.import === 3);
    const skipped = csv.plan(PAYOUTS, { today: TODAY, source: 'Bank', skipPayouts: true });
    ok('...and skips them when asked, so a Stripe file imported too is not counted twice', skipped.counts.payout === 2 && skipped.counts.import === 1 && skipped.rows[2].skip === null);
    ok('a Stripe file itself never treats its own payments as payouts', csv.plan(STRIPE, { today: TODAY }).counts.payouts === 0);
    const noDate = csv.plan(STRIPE, { today: TODAY, columns: { date: -1 } });
    ok('with no date column chosen, nothing imports and the preview says why', noDate.counts.import === 0 && noDate.counts.columns === 5);
  }

  console.log('\nThe pages, end to end:');
  {
    // A real server: the budget router with a stand-in database.
    const store = { revenue_entries: [{ user_id: 'me', entry_type: 'revenue', entry_date: '2026-10-10', amount: 850, source: 'ACH DEPOSIT UPWORK ESCROW' }] };
    const sb = {
      from: table => {
        const st = { insert: null };
        const q = new Proxy({}, { get(_, prop) {
          if (prop === 'then') return (res, rej) => {
            if (st.insert) { (store[table] = store[table] || []).push(...[].concat(st.insert)); return Promise.resolve({ data: null, error: null }).then(res, rej); }
            return Promise.resolve({ data: (store[table] || []).slice(), error: null }).then(res, rej);
          };
          if (prop === 'insert') return r => { st.insert = r; return q; };
          return () => q;
        } });
        return q;
      }
    };
    const app = express();
    app.set('view engine', 'ejs'); app.set('views', path.join(ROOT, 'views'));
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
      req.sb = sb; req.user = { id: 'me' }; req.profile = { id: 'me', username: 'me', path: 'software' };
      Object.assign(res.locals, { user: req.user, profile: req.profile, plan: 'free', currentPath: req.path, canonicalUrl: 'x', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } });
      next();
    });
    app.use('/budget', require('../src/routes/budget'));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      const up = await (await fetch(base + '/budget/import')).text();
      ok('the upload page renders, with a file field and where-to-find-it help', up.includes('type="file" name="file"') && up.includes('enctype="multipart/form-data"') && up.includes('PayPal'), up.slice(0, 120));

      const form = new FormData();
      form.append('file', new Blob([BANK], { type: 'text/csv' }), 'statement.csv');
      const pv = await (await fetch(base + '/budget/import', { method: 'POST', body: form })).text();
      ok('uploading shows the preview: 2 to import, $970, and why the rest are skipped', pv.includes('2 payments to import') && pv.includes('$970.00') && pv.includes('already in your income log') && pv.includes('money going out') && pv.includes('dated in the future'), pv.slice(pv.indexOf('<h2'), pv.indexOf('<h2') + 200));
      ok('money going out reads −$4.50, not $-4.50', pv.includes('−$4.50') && !pv.includes('$-4.50'));
      ok('...with the guessed columns selected, to change if wrong', /<option value="0" selected>Posting Date<\/option>/.test(pv) && /<option value="3" selected>Credit<\/option>/.test(pv));
      const carried = pv.match(/<textarea name="csv" hidden>([\s\S]*?)<\/textarea>/);
      ok('...and the file travels with the form, escaped', !!carried && carried[1].includes('ZELLE FROM JANE DOE') && !carried[1].includes('<'));
      ok('nothing is saved by previewing', store.revenue_entries.length === 1);

      const decode = s => s.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const again = new FormData();
      again.append('csv', decode(carried[1])); again.append('col_date', '0'); again.append('col_amount', '3'); again.append('col_description', '1'); again.append('source', 'My bank'); again.append('recurring', 'none');
      const save = await fetch(base + '/budget/import/save', { method: 'POST', body: again, redirect: 'manual' });
      const loc = decodeURIComponent(save.headers.get('location') || '');
      ok('saving imports the two new payments and says so', save.status === 302 && /Imported 2 payments \(\$970\.00\)/.test(loc) && /3 rows were skipped/.test(loc), loc);
      const added = store.revenue_entries.slice(1);
      ok('...as income-log rows with date, amount, who paid and the Recurring flag', added.length === 2 && added[0].entry_type === 'revenue' && added[0].entry_date === '2026-10-01' && added[0].amount === 850 && added[0].source === 'ACH DEPOSIT UPWORK ESCROW' && added[0].is_recurring === false && added[0].user_id === 'me', JSON.stringify(added[0]));

      const third = new FormData();
      third.append('csv', decode(carried[1]));
      const repeat = await fetch(base + '/budget/import/save', { method: 'POST', body: third, redirect: 'manual' });
      ok('importing the same file again adds nothing', /Nothing new to import/.test(decodeURIComponent(repeat.headers.get('location') || '')) && store.revenue_entries.length === 3);

      const big = new FormData();
      big.append('file', new Blob(['a'.repeat(2 * 1024 * 1024 + 10)], { type: 'text/csv' }), 'big.csv');
      const tooBig = await fetch(base + '/budget/import', { method: 'POST', body: big, redirect: 'manual' });
      ok('a file over 2 MB is turned away with a reason', tooBig.status === 302 && /over 2 MB/.test(decodeURIComponent(tooBig.headers.get('location') || '')));
      const empty = await fetch(base + '/budget/import', { method: 'POST', body: new FormData(), redirect: 'manual' });
      ok('no file: back to the upload page', /Choose a CSV file/.test(decodeURIComponent(empty.headers.get('location') || '')));
    } finally { server.close(); }
  }

  console.log('\nOn the Money page:');
  ok('the income log links to the import', fs.readFileSync(path.join(ROOT, 'views/budget.ejs'), 'utf8').includes('href="/budget/import"'));

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
