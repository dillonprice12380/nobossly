// The weekly news digest (src/digest.js and the weekly_brief email).
//
//   node test/digest.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const digest = require('../src/digest');

const at = s => new Date(s);
const row = (o) => Object.assign({ path: 'creator', topic: 'creator_youtube', label: 'YouTube', subpaths: null, title: 'T', url: 'https://x.example/' + Math.random(), publisher: 'P', published_at: '2026-11-02T10:00:00Z' }, o);

(async () => {
  console.log('When it goes out:');
  ok('Monday 9:00 New York (14:00 UTC in November): yes', digest.due(at('2026-11-09T14:05:00Z')));
  ok('Monday 8:00 New York: not yet', !digest.due(at('2026-11-09T13:00:00Z')));
  ok('Tuesday: catch-up after downtime', digest.due(at('2026-11-10T20:00:00Z')));
  ok('Wednesday to Sunday: no', ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'].every(d => !digest.due(at(d + 'T15:00:00Z'))));
  ok('summer time is followed (Monday 9:00 EDT = 13:00 UTC)', digest.due(at('2026-06-01T13:05:00Z')) && !digest.due(at('2026-06-01T12:55:00Z')));

  console.log('\nWhat each member gets:');
  {
    const rows = [
      row({ title: 'YT 1', published_at: '2026-11-08T10:00:00Z' }),
      row({ title: 'YT 2', published_at: '2026-11-07T10:00:00Z' }),
      row({ title: 'YT 3', published_at: '2026-11-06T10:00:00Z' }),
      row({ title: 'IG', topic: 'creator_instagram', label: 'Instagram', subpaths: ['social'], published_at: '2026-11-08T11:00:00Z' }),
      row({ title: 'Tax', path: 'all', topic: 'all_tax', label: 'Self-employment tax', published_at: '2026-11-05T10:00:00Z' }),
      row({ title: 'Shop', path: 'online_store', topic: 'shop_shopify', label: 'Shopify' })
    ];
    const yt = digest.pick(rows, { path: 'creator', subpath: 'youtube' }).map(r => r.title).join(',');
    ok('their path and everyone\'s news, newest first, two per topic', yt === 'YT 1,YT 2,Tax', yt);
    ok('topics for other subpaths left out', !/IG/.test(yt));
    ok('no subpath: every topic of the path', /IG/.test(digest.pick(rows, { path: 'creator' }).map(r => r.title).join(',')));
    ok('no path yet: news for everyone', digest.pick(rows, { path: null }).map(r => r.title).join(',') === 'Tax');
    ok('at most eight headlines', digest.pick(Array.from({ length: 30 }, (_, i) => row({ topic: 't' + i, title: 'H' + i })), { path: 'creator' }).length === digest.MAX_ITEMS);
  }

  console.log('\nA run:');
  {
    process.env.RESEND_API_KEY = 'test';
    const news = [row({ title: 'A' }), row({ title: 'B', topic: 'creator_tiktok' }), row({ title: 'C', path: 'all', topic: 'all_tax' })];
    const members = [
      { id: 'u1', username: 'cara', display_name: 'Cara', path: 'creator', subpath: null },
      { id: 'u2', username: 'off', path: 'creator', weekly_digest_enabled: false },
      { id: 'u3', username: 'gone', path: 'creator', account_status: 'deactivated' },
      { id: 'u4', username: 'recent', path: 'creator' },
      { id: 'u5', username: 'thin', path: null },
      { id: 'u6', username: 'noemail', path: 'creator' }
    ];
    const sc = { from: t => {
      const data = { path_news: news, profiles: members, email_log: [{ user_id: 'u4' }] }[t];
      const chain = new Proxy({}, { get(_, k) { if (k === 'then') return r => Promise.resolve({ data, error: null }).then(r); return () => chain; } });
      return chain;
    } };
    const sent = [];
    const out = await digest.run(sc, at('2026-11-09T14:05:00Z'), {
      emailOf: async (_, id) => (id === 'u6' ? null : id + '@example.com'),
      send: async (type, to, name, o) => { sent.push({ type, to, name, o }); return true; }
    });
    ok('it sends to members with the digest on and enough news', sent.map(s => s.to).join(',') === 'u1@example.com', sent.map(s => s.to).join(','));
    ok('...not to those who turned it off, closed accounts, anyone sent one this week, or thin weeks', out.already === 1 && out.thin === 1 && out.noEmail === 1 && out.sent === 1, JSON.stringify(out));
    ok('...as the weekly_brief email, with their headlines and path', sent[0] && sent[0].type === 'weekly_brief' && sent[0].o.template.items.length === 3 && sent[0].o.template.pathLabel === 'Content creator' && sent[0].o.userId === 'u1');
    const early = await digest.run(sc, at('2026-11-11T14:05:00Z'), { send: async () => { throw new Error('should not send'); } });
    ok('outside its window it does nothing', early.skipped === 'not due');
    delete process.env.RESEND_API_KEY;
    const nokey = await digest.run(sc, at('2026-11-09T14:05:00Z'));
    ok('without the email key it does nothing', nokey.skipped === 'RESEND_API_KEY unset');
  }

  console.log('\nThe email:');
  {
    process.env.RESEND_API_KEY = 'test';
    let body = null;
    const realFetch = global.fetch;
    global.fetch = async (url, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({ id: 'r1' }) }; };
    const mailer = require('../src/mailer');
    await mailer.send('weekly_brief', 'cara@example.com', 'Cara <b>', { sb: { from: () => ({ insert: async () => ({}) }) }, template: { pathLabel: 'Content creator', items: [
      row({ title: 'YouTube gives creators a 30-day fix-it period <script>', url: 'https://www.tubefilter.com/a', publisher: 'Tubefilter' }),
      row({ title: 'Bad link', url: 'javascript:alert(1)', label: 'Instagram' })
    ] } });
    global.fetch = realFetch; delete process.env.RESEND_API_KEY;
    ok('the subject names the path and the top story', body && /^This week for content creators: YouTube gives creators a 30-day fix-it period/.test(body.subject), body && body.subject);
    ok('headlines link to the publisher, grouped by topic', body && body.html.includes('href="https://www.tubefilter.com/a"') && body.html.includes('>YouTube</p>') && body.html.includes('>Instagram</p>'));
    ok('everything is escaped, and a bad link points at /news instead', body && !body.html.includes('<script>') && !body.html.includes('javascript:') && body.html.includes('Cara &lt;b&gt;'));
    ok('it says how to turn it off', body && /weekly digest is on\. <a href="[^"]+\/account"/.test(body.html));
  }

  console.log('\nWiring:');
  ok('a 30-minute timer runs it in the server, with the service key', /digest\.run\(sc\)/.test(read('server.js')) && /30 \* 60 \* 1000/.test(read('server.js')));
  ok('members can switch it on the News page and in account settings', read('views/news.ejs').includes('action="/news/digest"') && read('views/account.ejs').includes('action="/news/digest"') && /router\.post\('\/digest'/.test(read('src/routes/news.js')));
  ok('the switch only changes the member\'s own setting', /update\(\{ weekly_digest_enabled: on \}\)\.eq\('id', req\.user\.id\)/.test(read('src/routes/news.js')));

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
