// The home page (views/home.ejs, src/home.js): three parts (Workspace, Money,
// Community) with real previews, a "What are you building?" picker that works
// without JavaScript and carries the choice through sign-up, an FAQ, and the
// tags that decide how the site looks when shared or searched.
//
//   node test/home.js        (HOME_OUT=dir also writes the page as HTML)

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
const home = require('../src/home');
const { FLAGS } = require('../src/features');

const base = { title: 'Build Your Way Out of the 9 to 5', user: null, profile: null, plan: 'free', currentPath: '/', canonicalUrl: 'https://nobossly.com/', unreadCount: 0, unreadMsgs: 0, metaDescription: 'NoBossly is a free workspace and community.', bodyTheme: 'theme-dark', settings: {}, pendingDeletion: null, reactivated: false, isPremium: false, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false } };
const html = ejs.render(read('views/home.ejs'), Object.assign({}, base, { paths: paths.MARKETED, previews: home.previews(), faq: home.FAQ, structuredData: home.structuredData() }), { filename: path.join(ROOT, 'views/home.ejs') });
const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

console.log('The three parts:');
ok('Workspace, Money and Community, each with a section and a link to it', ['id="workspace"', 'id="money"', 'id="community"', 'href="#workspace"', 'href="#money"', 'href="#community"'].every(x => html.includes(x)));
ok('it talks about what is there now: connections, tax-time export, co-working, helpful answers, profiles', ['connect Stripe or Shopify read-only', 'Export for tax time', 'Co-working', 'mark the reply that helped', 'Profiles with your business on them'].every(x => text.includes(x)));
ok('...and promises nothing that is not live (no bank, Square, Gumroad or PayPal connection)', !/connect (your )?bank|Square|Gumroad|connect PayPal/i.test(text));
ok('the old stock images and the scrolling marquee are gone', !html.includes('light-bulb') && !html.includes('class="marquee"'));

console.log('\nReal previews:');
for (const [img, w, h] of [['dashboard', 1560, 1080], ['money', 1560, 627], ['community', 1560, 1038]]) {
  const file = path.join(ROOT, 'public/img/home', img + '.jpg');
  const tag = (html.match(new RegExp('<img src="/img/home/' + img + '\\.jpg"[^>]*>')) || [])[0] || '';
  ok(img + ': the file exists and is not huge, the tag has its size, alt text and lazy loading', fs.existsSync(file) && fs.statSync(file).size < 400 * 1024 && tag.includes('width="' + w + '"') && tag.includes('height="' + h + '"') && /alt="[^"]{30,}"/.test(tag) && tag.includes('loading="lazy"'), fs.existsSync(file) ? Math.round(fs.statSync(file).size / 1024) + ' KB' : 'missing');
}
ok('the previews are made from the real pages by a script anyone can re-run', read('scripts/home_shots.js').includes("run('dashboard.js'") && read('scripts/home_shots.js').includes("run('money.js'") && read('scripts/home_shots.js').includes("run('community.js'"));

console.log('\n"What are you building?":');
const slugs = paths.MARKETED.map(p => p.slug);
ok('one choice per marketed path, one of them already picked', slugs.every(s => html.includes('id="hp-' + s + '"') && html.includes('for="hp-' + s + '"')) && (html.match(/class="hm-radio" checked/g) || []).length === 1);
ok('each shows that path\'s own numbers, boards and tools', html.includes('Billable income') && html.includes('Client pipeline') && html.includes('Proposal &amp; quote'));
ok('...and its button carries the choice through sign-up', slugs.every(s => html.includes('href="/signup?path=' + s + '"')) && read('src/routes/auth.js').includes("router.get('/signup'"));
ok('...and the button reads "as an online store", not "as a online store"', !/as a [aeiou]/i.test(html));
ok('it works without JavaScript: a CSS rule shows each panel when its choice is picked', slugs.every(s => html.includes('#hp-' + s + ':checked ~ .hm-panels .hm-panel-' + s)));
ok('...and is usable by keyboard', html.includes(':focus-visible ~ .hm-chips') && /\.hm-radio \{ position: absolute; opacity: 0;/.test(html) && !/\.hm-radio \{[^}]*display: none/.test(html));

console.log('\nFAQ and search:');
ok('the FAQ answers free, keeping your job, privacy, read-only connections and accelerators', ['Is it really free?', 'Do I have to quit my job?', 'Is my data private?', 'read-only', 'Does it replace an accelerator'].every(x => text.includes(x)));
const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
let parsed = null; try { parsed = JSON.parse(ld); } catch (_) { /* invalid */ }
ok('structured data is valid JSON: the organisation, the site and the FAQ', Array.isArray(parsed) && parsed.map(x => x['@type']).join() === 'Organization,WebSite,FAQPage' && parsed[2].mainEntity.length === home.FAQ.length);
ok('...and cannot break out of its script tag', !/<\/script/i.test(JSON.stringify(home.structuredData())) && read('views/home.ejs').includes(".replace(/</g, '\\\\u003c')"));
ok('every page has share tags: title, description, image, large card', ['property="og:title"', 'property="og:description"', 'property="og:image" content="https://nobossly.com/img/home/og.jpg"', 'name="twitter:card" content="summary_large_image"'].every(x => html.includes(x)));
ok('the share image is 1200×630', fs.existsSync(path.join(ROOT, 'public/img/home/og.jpg')) && html.includes('og:image:width" content="1200"'));
ok('the home page sets its canonical address', html.includes('<link rel="canonical" href="https://nobossly.com/">') && read('server.js').includes("canonicalUrl: home.SITE + '/'"));

console.log('\nTone:');
const COACHING = /\b(quests?|electives?|next (real )?step|fit test|playbooks?|step-by-step|curriculum|nudges?)\b/i;
ok('it reads as a workspace and a community, not a program', !COACHING.test(text) && text.includes("NoBossly doesn't teach; programs do"), (text.match(COACHING) || [])[0]);

if (process.env.HOME_OUT) fs.writeFileSync(path.join(process.env.HOME_OUT, 'home.html'), html.replace(/href="\/css\/([a-z]+)\.css\?v=\d+"/g, (m, n) => 'href="' + path.join(ROOT, 'public/css/' + n + '.css') + '"').replace(/src="\/img\//g, 'src="' + path.join(ROOT, 'public/img') + '/'));
console.log(fail ? `\n${fail} failed` : '\nAll good');
process.exit(fail ? 1 : 0);
