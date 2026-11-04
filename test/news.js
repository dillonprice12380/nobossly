// News for each path: the scheduled job's logic (supabase/functions/path-news),
// the topics for every path, the /news page, the dashboard card, the alert
// switch, and the migration.
//
//   node test/news.js

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
const paths = require('../src/paths');
const { FLAGS } = require('../src/features');

const NOW = new Date('2026-11-03T15:00:00Z');
const hoursAgo = h => new Date(NOW.getTime() - h * 3600000);
const rss = items => '<?xml version="1.0"?><rss><channel>' + items.map(i =>
  `<item><title>${i.title} - ${i.pub}</title><link>${i.url}</link><pubDate>${i.when.toUTCString()}</pubDate><source url="https://${i.pub.toLowerCase().replace(/\W/g, '')}.com">${i.pub}</source></item>`).join('') + '</channel></rss>';

(async () => {
  const core = await import('../supabase/functions/path-news/core.js');
  const { TOPICS, PATHS, FEEDS } = await import('../supabase/functions/path-news/topics.js');

  console.log('Every path has news:');
  {
    const marketed = paths.MARKETED.map(p => p.slug);
    ok('every path has topics', marketed.every(p => (TOPICS[p] || []).length >= 2), marketed.filter(p => !(TOPICS[p] || []).length).join(', ') || marketed.length + ' paths');
    ok('...and every member gets news for everyone too', TOPICS.all.length >= 1 && !PATHS.includes('all'));
    const all = Object.values(TOPICS).flat();
    ok('topic keys are unique and safe to store', new Set(all.map(t => t.key)).size === all.length && all.every(t => /^[a-z_]{2,60}$/.test(t.key)));
    ok('every topic has a label, sources, and a working filter for shared feeds', all.every(t => t.label && ((t.feeds || []).length || (t.anyFrom || []).length)
       && (!(t.feeds || []).length || (() => { try { new RegExp(t.must, 'i'); return true; } catch (_) { return false; } })())), all.filter(t => !t.label || (t.feeds || []).length && !t.must).map(t => t.key).join(', ') || undefined);
    const unknownFeeds = all.flatMap(t => [...(t.feeds || []), ...(t.anyFrom || [])].filter(k => !FEEDS[k]).map(k => t.key + ':' + k));
    ok('every topic names real feeds', unknownFeeds.length === 0, unknownFeeds.join(', ') || Object.keys(FEEDS).length + ' feeds');
    ok('feeds are https publisher feeds, each used', Object.values(FEEDS).every(f => /^https:\/\//.test(f.url) && f.name) && Object.keys(FEEDS).every(k => all.some(t => (t.feeds || []).concat(t.anyFrom || []).includes(k))));
    const badSub = Object.entries(TOPICS).filter(([p]) => p !== 'all').flatMap(([p, ts]) => ts.filter(t => t.subpaths).flatMap(t => t.subpaths.filter(s => !(paths.subpathsOf(p) || []).some(x => x.slug === s)).map(s => p + ':' + t.key + ':' + s)));
    ok('topics for some subpaths name real subpaths', badSub.length === 0, badSub.join(', ') || 'clean');
    ok('the job and the app agree on the paths', JSON.stringify(PATHS.slice().sort()) === JSON.stringify(paths.SLUGS.slice().sort()));
  }

  console.log('\nReading Google-style feeds:');
  {
    const xml = rss([
      { title: 'Instagram is testing long-form videos for creators', pub: 'The Verge', url: 'https://news.google.com/a1', when: hoursAgo(2) },
      { title: 'Instagram tests long form videos, creators react', pub: 'TechCrunch', url: 'https://news.google.com/a2', when: hoursAgo(3) },
      { title: 'Stock market falls on rate fears', pub: 'Reuters', url: 'https://news.google.com/a3', when: hoursAgo(1) },
      { title: 'Instagram adds a feature from 2024', pub: 'Old News', url: 'https://news.google.com/a4', when: hoursAgo(80) },
      { title: 'Broken &amp; &#39;escaped&#39; <b>Instagram</b> item', pub: 'X', url: 'javascript:alert(1)', when: hoursAgo(1) }
    ]);
    const arts = core.parseNewsRss(xml);
    ok('headlines are read, with the publisher taken off the title', arts.length === 4 && arts[0].title === 'Instagram is testing long-form videos for creators' && arts[0].publisher === 'The Verge');
    ok('links that are not https are dropped', !arts.some(a => !/^https:/.test(a.url)));
    ok('a block page is not taken for a feed', !core.isFeed(200, '<html>captcha</html>') && core.isFeed(200, xml) && !core.isFeed(503, xml));
    const topic = { key: 'creator_instagram', label: 'Instagram', must: 'instagram', subpaths: ['social', 'other'] };
    const rows = core.collect([{ path: 'creator', topic, articles: arts }], NOW);
    ok('off-topic and old headlines are dropped', rows.every(r => /instagram/i.test(r.title)) && !rows.some(r => /2024/.test(r.title)));
    ok('the same story from a second outlet is kept once', rows.length === 1, rows.map(r => r.title).join(' | '));
    ok('a row carries its path, topic, label and time', rows[0].path === 'creator' && rows[0].topic === 'creator_instagram' && rows[0].label === 'Instagram' && rows[0].published_at === hoursAgo(2).toISOString());
    const many = Array.from({ length: 20 }, (_, i) => ({ title: ['Instagram', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ')[i], 'w' + i, 'z' + i * 7, 'q' + i * 13].join(' '), url: 'https://n.example/' + i, publisher: 'P', seen: hoursAgo(1 + i / 10) }));
    ok('different stories are not merged', !core.sameStory('Instagram is testing long-form videos for creators', 'Instagram removes likes count from Reels in Canada'));
    ok('a few per topic per run, newest first', core.collect([{ path: 'creator', topic, articles: many }], NOW).length === core.PER_TOPIC);
  }

  console.log('\nReading publishers\' feeds:');
  {
    const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>New Play policy for developers</title><link rel="replies" href="https://x.example/c"/><link rel="alternate" href="https://android-developers.googleblog.com/p1"/><published>' + hoursAgo(2).toISOString() + '</published></entry></feed>';
    const a = core.parseFeed(atom, 'android_dev', 'Android Developers Blog');
    ok('Atom feeds are read, using the article link', a.length === 1 && a[0].url === 'https://android-developers.googleblog.com/p1' && a[0].publisher === 'Android Developers Blog' && a[0].feed === 'android_dev');
    const rssx = '<rss><channel><item><title><![CDATA[Instagram tests long-form video]]></title><link>https://www.socialmediatoday.com/news/ig-long/</link><pubDate>' + hoursAgo(1).toUTCString() + '</pubDate></item>'
      + '<item><title>LinkedIn adds a new ad format</title><link>https://www.socialmediatoday.com/news/li/</link><pubDate>' + hoursAgo(1).toUTCString() + '</pubDate></item></channel></rss>';
    const smt = core.parseFeed(rssx, 'smt', 'Social Media Today');
    const yt = core.parseFeed('<rss><channel><item><title>Updates to how Shorts are recommended</title><link>https://blog.youtube/news/shorts/</link><pubDate>' + hoursAgo(3).toUTCString() + '</pubDate></item></channel></rss>', 'youtube_blog', 'YouTube Official Blog');
    const byFeed = { smt, youtube_blog: yt };
    const ig = TOPICS.creator.find(t => t.key === 'creator_instagram');
    const ytTopic = TOPICS.creator.find(t => t.key === 'creator_youtube');
    const li = TOPICS.consultant.find(t => t.key === 'con_linkedin');
    const rows = core.collect([
      { path: 'creator', topic: ig, articles: core.articlesFor(ig, byFeed) },
      { path: 'creator', topic: ytTopic, articles: core.articlesFor(ytTopic, byFeed) },
      { path: 'consultant', topic: li, articles: core.articlesFor(li, byFeed) }
    ], NOW);
    const by = k => rows.filter(r => r.topic === k).map(r => r.title).join(' | ');
    ok('the Instagram long-form story reaches the creators\' Instagram topic', by('creator_instagram') === 'Instagram tests long-form video');
    ok('a single-subject feed counts whole (the YouTube blog needs no keyword)', by('creator_youtube') === 'Updates to how Shorts are recommended');
    ok('the same feed\'s LinkedIn story goes to consultants, not creators', by('con_linkedin') === 'LinkedIn adds a new ad format' && !/LinkedIn/.test(by('creator_instagram')));
    ok('a headline from a feed the topic does not use is ignored', !core.relevant(Object.assign({}, smt[0], { feed: 'nrn' }), ig, NOW));
  }

  console.log('\nTuned on real headlines (2026-11-04):');
  {
    const find = k => Object.values(TOPICS).flat().find(t => t.key === k);
    const takes = (k, feed, title) => core.relevant({ feed, title, seen: hoursAgo(2), url: 'https://x.example/' + feed }, find(k), NOW);
    const yes = [
      ['bm_restaurants', 'nrn', 'The cookie conundrum: When viral demand meets permanent costs'],
      ['bm_restaurants', 'restaurantdive', 'FTC, states sue Toast over fees'],
      ['bm_retail', 'inc', 'Holiday Shoppers Plan to Spend More at Small Businesses. Many Owners Overlook 1 Key Priority'],
      ['shop_tariffs', 'practicalecom', 'USPS Can Bill Sellers for Foreign Duties'],
      ['shop_amazon', 'practicalecom', 'Amazon raises FBA fees for the holidays'],
      ['all_tax', 'entrepreneur', 'That ‘100% Tax Write-Off’ on Your Company Car Isn’t What You Think'],
      ['con_coaching', 'cpa', 'Selling Advice, Not Hours: Packaging Advisory Services Clients Understand'],
      ['creator_youtube', 'tubefilter', 'YouTube is giving some creators a 30-day fix-it period before terminating their channels'],
      ['creator_economy', 'tubefilter', 'X, like YouTube, is offering bonuses to creators who consistently upload new videos'],
      ['sw_appstores', 'apple_dev', 'Upcoming: New age rating content descriptors in App Store Connect'],
      ['fl_marketing', 'seroundtable', 'Google AI Mode Now With Up To Four Ads'],
      ['loc_google', 'seroundtable', 'Google Business Profile adds new review reporting tools'],
      ['shop_growth', 'practicalecom', 'Marketers’ Guide to Late BFCM Email'],
      ['ex_sidehustle', 'entrepreneur', 'He Left Google to Fix a ‘Really Stupid’ Household Product']
    ];
    const no = [
      ['bm_restaurants', 'nrn', 'McDonald’s U.S. same-store sales decline on weak traffic'],
      ['bm_restaurants', 'nrn', 'Red Robin reports best same-store sales since 2023'],
      ['bm_restaurants', 'restaurantdive', 'Outback’s largest U.S. franchisee goes bankrupt'],
      ['shop_amazon', 'modernretail', 'What DoorDash’s proposed acquisition of Instacart means for Uber, Amazon and the rest'],
      ['shop_amazon', 'modernretail', 'Amazon says more than 400M customers have used Alexa for Shopping'],
      ['shop_tariffs', 'smallbiztrends', 'UPS Unveils Groundbreaking RFID Tech for Enhanced Package Tracking'],
      ['shop_tariffs', 'supplychaindive', 'FedEx Network 2.0 headed to Los Angeles, other markets post-holidays'],
      ['prod_tariffs', 'supplychaindive', '3M closes 16 factories, plans changes at 10 more in network revamp'],
      ['con_coaching', 'inc', 'An NBA Championship Coach Uses AI Every Day. His Reason Is Surprisingly Simple'],
      ['creator_youtube', 'tubefilter', 'Top 50 Most Subscribed YouTube Channels Worldwide • Week Of 11/01/2026'],
      ['creator_podcast', 'podnews', 'The Podcast Show London 2027 tickets go on sale: new stages announced'],
      ['sw_appstores', 'ninetofivemac', 'Apple releases first iOS 27.3 developer beta for iPhone'],
      ['sw_appstores', 'apple_dev', 'Get ready with the latest beta releases'],
      ['all_tax', 'accountingtoday', 'Democrats press IRS for tax gap accounting after midterm election'],
      ['bm_rent', 'smallbiztrends', 'Small Businesses Risk Losing Holiday Shoppers Due to Engagement Gap'],
      ['fl_ai_design', 'ninetofivemac', '‘Stick’ season 2 premieres on Apple TV'],
      ['sw_indie', 'ninetofivegoogle', 'Google shuts down a sneaky malware backdoor on millions of Android TV boxes'],
      ['creator_instagram', 'smt', 'Deals: Instagram creators get 20% off ring lights']
    ];
    const missed = yes.filter(([k, f, t]) => !takes(k, f, t)).map(x => x[0] + ': ' + x[2]);
    const leaked = no.filter(([k, f, t]) => takes(k, f, t)).map(x => x[0] + ': ' + x[2]);
    ok('useful headlines reach their topic', missed.length === 0, missed.join(' | ') || yes.length + ' headlines');
    ok('chains, earnings, betas, listicles, sports coaches and event tickets stay out', leaked.length === 0, leaked.join(' | ') || no.length + ' headlines');
    ok('Search Engine Journal bylines come off titles', core.parseFeed('<rss><item><title>Google Says X via @sejournal, @MattGSouthern</title><link>https://sej.example/a</link><pubDate>' + hoursAgo(1).toUTCString() + '</pubDate></item></rss>', 'sej', 'SEJ')[0].title === 'Google Says X');
    const thin = paths.SLUGS.flatMap(p => (paths.subpathsOf(p) || []).map(x => x.slug).concat([null])
      .filter(sub => (TOPICS[p] || []).filter(t => !sub || !t.subpaths || t.subpaths.includes(sub)).length < 2).map(sub => p + ':' + sub));
    ok('members on every subpath have at least two topics', thin.length === 0, thin.join(', ') || 'clean');
  }

  console.log('\nWho gets alerted:');
  {
    const row = { id: 'n1', path: 'creator', topic: 'creator_instagram', label: 'Instagram', subpaths: ['social', 'other'], title: 'Instagram is testing long-form videos', published_at: hoursAgo(2).toISOString() };
    const members = [
      { id: 'a', path: 'creator', subpath: 'social', news_alerts: true },
      { id: 'b', path: 'creator', subpath: 'youtube', news_alerts: true },
      { id: 'c', path: 'creator', subpath: null, news_alerts: true },
      { id: 'd', path: 'creator', subpath: 'social', news_alerts: false },
      { id: 'e', path: 'freelancer', subpath: null, news_alerts: true },
      { id: 'f', path: 'creator', subpath: 'social', news_alerts: true, account_status: 'deactivated' },
      { id: 'g', path: 'creator', subpath: 'social', news_alerts: true }
    ];
    const to = core.audience(row, members, new Set(['g'])).map(m => m.id).join('');
    ok('an Instagram story reaches social creators and creators with no subpath', to === 'ac', to);
    ok('...not YouTubers, people who turned alerts off, other paths, closed accounts, or anyone alerted today', !/[bdefg]/.test(to));
    ok('news for everyone reaches every path', core.audience(Object.assign({}, row, { path: 'all', subpaths: null }), members, new Set()).map(m => m.id).join('') === 'abceg');
    const picks = core.pickAlerts([row, Object.assign({}, row, { id: 'n2', published_at: hoursAgo(1).toISOString() }), Object.assign({}, row, { id: 'n3', path: 'freelancer', published_at: hoursAgo(20).toISOString() })], NOW);
    ok('one alert per path per run, the freshest', picks.length === 1 && picks[0].id === 'n2');
    ok('...and stale news never becomes a notification', !picks.some(p => p.id === 'n3'));
    ok('the message says what it is about', core.alertMessage(row) === '📰 Instagram: Instagram is testing long-form videos' && core.alertMessage(Object.assign({}, row, { title: 'x'.repeat(400) })).length === 200);
    ok('at most one news notification a day', core.ALERT_GAP_HOURS >= 20);
  }

  console.log('\nThe scheduled job:');
  {
    const fn = read('supabase/functions/path-news/index.ts');
    ok('it refuses callers without the secret', /app_secrets"\)\.select\("value"\)\.eq\("key", "cron_path_news"\)/.test(fn) && /unauthorized" \}, 401/.test(fn));
    ok('it compares the secret in constant time', /function same\(a: string, b: string\)/.test(fn));
    ok('it reads each feed once, with a time limit, a few at a time', /setTimeout\(\(\) => ctl\.abort\(\), 20000\)/.test(fn) && /pool\(feeds, 6,/.test(fn) && /articlesFor\(topic, byFeed\)/.test(fn));
    ok('it reports why a feed failed', /note\(key \+ ": "/.test(fn) && /problems \}\)/.test(fn));
    ok('it never stores the same link twice for a path', /onConflict: "path,url", ignoreDuplicates: true/.test(fn));
    ok('it skips stories already stored this week from another outlet', /sameStory\(t, r\.title\)/.test(fn));
    ok('it keeps a month of news', /30 \* 86400000/.test(fn));
  }

  console.log('\nThe member side:');
  const news = require('../src/news');
  const router = require('../src/routes/news');
  function fakeSb(rows, calls = []) {
    const chain = new Proxy({}, { get(_, k) {
      if (k === 'then') return (res) => Promise.resolve({ data: rows, error: null }).then(res);
      if (k === 'update') return (p) => { calls.push({ update: p }); return chain; };
      return (...a) => { calls.push([k].concat(a)); return chain; };
    } });
    return { from: t => { calls.push({ table: t }); return chain; }, calls };
  }
  {
    const rows = [
      { id: '1', path: 'creator', topic: 'creator_instagram', label: 'Instagram', subpaths: ['social'], title: 'IG', url: 'https://x/1', published_at: hoursAgo(1).toISOString() },
      { id: '2', path: 'creator', topic: 'creator_youtube', label: 'YouTube', subpaths: ['youtube'], title: 'YT', url: 'https://x/2', published_at: hoursAgo(2).toISOString() },
      { id: '3', path: 'all', topic: 'all_tax', label: 'Self-employment tax', subpaths: null, title: 'Tax', url: 'https://x/3', published_at: hoursAgo(3).toISOString() }
    ];
    const calls = [];
    const r = await news.forMember(fakeSb(rows, calls), { path: 'creator', subpath: 'social' });
    ok('a member sees their path and everyone\'s news, for their subpath', r.items.map(n => n.id).join('') === '13');
    ok('...from the last two weeks', calls.some(c => Array.isArray(c) && c[0] === 'in' && JSON.stringify(c[2]) === '["creator","all"]') && calls.some(c => Array.isArray(c) && c[0] === 'gte' && c[1] === 'published_at'));
    const browse = await news.forMember(fakeSb(rows), { path: 'creator', subpath: 'social' }, { path: 'creator' });
    ok('browsing their path\'s news by name keeps the subpath filter', browse.items.length === 2);
    const none = await news.forMember(fakeSb(rows), { path: null });
    ok('no path yet: news for everyone', none.items.map(n => n.id).join('') === '123');
    ok('times read naturally', news.ago(hoursAgo(0.01), NOW) === 'just now' && news.ago(hoursAgo(3), NOW) === '3h ago' && news.ago(hoursAgo(30), NOW) === 'yesterday');

    const run = (method, url, body, sb) => new Promise(resolve => {
      const q = {}; new URL('http://x' + url).searchParams.forEach((v, k) => { q[k] = v; });
      const req = { method, url, body: body || {}, query: q, params: {}, sb, user: { id: 'me' }, profile: { id: 'me', path: 'creator', subpath: 'social', news_alerts: true } };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, redirect(t) { resolve({ redirect: t }); }, render(v, d) { resolve({ view: v, data: d }); } };
      router.handle(req, res, e => resolve({ error: e || 'next' }));
    });
    const page = await run('GET', '/?topic=creator_instagram', null, fakeSb(rows));
    ok('/news renders the member\'s news', page.view === 'news' && page.data.chosenPath === 'creator' && page.data.alertsOn === true);
    const sw = [];
    const off = await run('POST', '/alerts', { on: '0' }, fakeSb([], sw));
    ok('the switch turns alerts off for this member only', sw.some(c => c.update && c.update.news_alerts === false) && sw.some(c => Array.isArray(c) && c[0] === 'eq' && c[2] === 'me') && /msg=/.test(off.redirect));

    const V = f => path.join(ROOT, 'views', f);
    const base = { title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me' }, plan: 'paid', currentPath: '/news', canonicalUrl: 'x', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false, isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
    const render = (f, d) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, d), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
    const html = render('news.ejs', page.data);
    ok('the page renders, with links out and the alert switch', !html.startsWith('ERR') && html.includes('href="https://x/1"') && html.includes('rel="noopener noreferrer nofollow"') && html.includes('action="/news/alerts"'));
    const card = render('partials/news_card.ejs', { news: rows, ago: news.ago });
    ok('the dashboard card renders', !card.startsWith('ERR') && card.includes('All news'));
    ok('the dashboard shows it', /pathNews = await news\.forMember\(req\.sb, p, \{ limit: 4 \}\)/.test(read('src/routes/dashboard.js')) && read('views/dashboard.ejs').includes("include('partials/news_card'"));
    ok('account settings have the switch', read('views/account.ejs').includes('action="/news/alerts"'));
    ok('News is a Dashboard page', /key: 'news', href: '\/news', label: 'News'/.test(read('views/partials/appnav.ejs')));
    ok('a news notification opens the story on /news', read('src/routes/notifications.js').includes("path_news: id => '/news#n-' + id"));
  }

  console.log('\nThe migration:');
  {
    const sql = read('migrations/2026-11-03_path_news.sql');
    ok('it is marked as applied', /^-- Applied live 2026-11-03/.test(sql));
    ok('members can read news but never write it; anon cannot read it', /revoke all on public\.path_news from anon/.test(sql) && /revoke insert, update, delete on public\.path_news from authenticated/.test(sql) && /enable row level security/.test(sql));
    ok('links are https only', /url ~\* '\^https:\/\/'/.test(sql));
    ok('alerts are on by default and members can switch them', /add column if not exists news_alerts boolean not null default true/.test(sql));
    ok('"news" is an allowed notification type, and every old type is kept', ["'levels'", "'cohort'", "'group'", "'system'", "'help'", "'news'"].every(t => sql.includes(t)));
    ok('the job runs every 30 minutes with a secret made in the database', /cron\.schedule\('path-news', '\*\/30 \* \* \* \*'/.test(sql) && /'cron_path_news', replace\(gen_random_uuid\(\)/.test(sql));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
