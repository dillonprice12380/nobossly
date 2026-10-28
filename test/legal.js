// The privacy policy and terms describe what the code actually does. These
// checks fail when the two drift apart: a new analytics tag, a renamed cookie,
// a changed deletion window, or a page that stops rendering.
//
//   node test/legal.js

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const base = {
  title: 'T', user: null, profile: null, plan: 'free', currentPath: '/privacy',
  canonicalUrl: 'https://nobossly.com/privacy', unreadCount: 0, unreadMsgs: 0,
  metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null,
  reactivated: false, operator: 'NoBossly', contact: 'support@nobossly.com', updated: 'January 1, 2026'
};
const render = file => ejs.render(fs.readFileSync(path.join(VIEWS, file), 'utf8'),
  base, { filename: path.join(VIEWS, file) });
const text = html => html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const pages = {};
console.log('\nPages render:');
for (const name of ['privacy', 'terms']) {
  try { pages[name] = render(name + '.ejs'); } catch (e) { ok(`${name}.ejs renders`, false, e.message); continue; }
  const body = text(pages[name]);
  ok(`${name}.ejs renders a full page`, body.length > 8000, body.length + ' characters');
  ok(`${name}.ejs shows the contact address and date`, body.includes(base.contact) && body.includes(base.updated));
  const ids = new Set([...pages[name].matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const anchors = [...pages[name].matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
  const broken = anchors.filter(a => !ids.has(a));
  ok(`${name}.ejs: every table-of-contents link has a heading`, anchors.length > 5 && !broken.length,
     broken.length ? 'missing: ' + broken.join(', ') : anchors.length + ' links');
  ok(`${name}.ejs: nothing left unfilled`, !/undefined|\[object|<%|TODO|\[YOUR/i.test(pages[name]));
}
if (!pages.privacy || !pages.terms) { console.log(`\n${fail} failed`); process.exit(1); }

const priv = text(pages.privacy);
const terms = text(pages.terms);
const mentions = (s, w) => s.toLowerCase().includes(w.toLowerCase());

console.log('\nPrivacy policy matches the code:');

const head = read('views/partials/head.ejs');
if (/googletagmanager\.com|gtag\(/.test(head)) ok('Google Analytics is loaded, and the policy says so', mentions(priv, 'Google Analytics') && mentions(priv, '_ga'));
if (/plausible|posthog|hotjar|fbq\(|connect\.facebook\.net/i.test(head))
  ok('no analytics or ad tag beyond the ones the policy names', false, 'head.ejs loads a tracker the policy does not describe');
else ok('no analytics or ad tag beyond the ones the policy names', true);

const mw = read('src/middleware/auth.js') + read('src/routes/auth.js');
for (const cookie of ['sb_access', 'sb_refresh', 'pkce_verifier'])
  ok(`cookie ${cookie} is set by the code and listed in the policy`, mw.includes(cookie) && priv.includes(cookie));
const days = /maxAge:\s*1000 \* 60 \* 60 \* 24 \* (\d+)/.exec(read('src/middleware/auth.js'));
ok('session cookie lifetime matches the policy', days && priv.includes('Up to ' + days[1] + ' days'), days ? days[1] + ' days' : 'not found');

const account = read('src/routes/account.js');
ok('deletion window in the code is 7 days and the policy says seven', /in 7 days/.test(account) && /seven days/.test(priv) && /seven days/.test(terms));

const files = [read('server.js'), ...fs.readdirSync(path.join(ROOT, 'src/routes')).map(f => read('src/routes/' + f)), read('src/mailer.js'), read('src/supabase.js')].join('\n');
const providers = [['Stripe', /stripe\.com|STRIPE_SECRET_KEY/], ['Resend', /RESEND_API_KEY|api\.resend\.com/], ['Supabase', /SUPABASE_URL/]];
for (const [name, re] of providers) if (re.test(files)) ok(`${name} is used by the code and named in the policy`, mentions(priv, name));
for (const p of ['Google', 'LinkedIn', 'GitHub']) ok(`${p} sign-in exists in the code and is named in the policy`, /OAUTH_PROVIDERS/.test(read('src/routes/auth.js')) && mentions(priv, p));
ok('affiliate click tracking is disclosed', /affiliate_go/.test(read('src/routes/affiliates.js')) && mentions(priv, 'Recommendation clicks'));
ok('public uploads bucket is disclosed', /getPublicUrl/.test(read('src/routes/uploads.js')) && mentions(priv, 'public storage bucket'));
ok('minimum age is stated the same way in both documents', mentions(priv, 'at least 18') && mentions(terms, 'at least 18'));

console.log('\nTerms match the code:');
ok('Premium cancel-at-period-end matches the code', /cancel_at_period_end/.test(read('src/routes/billing.js')) && mentions(terms, 'until the end of the period you have already paid for'));
ok('terms link to the privacy policy and the affiliate disclosure', terms.length && pages.terms.includes('href="/privacy"') && pages.terms.includes('href="/affiliate-disclosure"'));
ok('privacy policy links to the terms', pages.privacy.includes('href="/terms"'));
ok('not-professional-advice language is kept', mentions(terms, 'legal, tax, financial, accounting') && mentions(terms, 'attorney-client'));

console.log('\nRoutes:');
const legal = read('src/routes/legal.js');
const server = read('server.js');
ok('/privacy and /terms are served by legal.js', /router\.get\('\/privacy'/.test(legal) && /router\.get\('\/terms'/.test(legal));
ok('legal router is mounted before the CMS catch-all', server.indexOf("routes/legal") > 0 && server.indexOf("routes/legal") < server.indexOf("routes/publiccms"));
ok('footer links to both pages', /href="\/terms"/.test(read('views/partials/foot.ejs')) && /href="\/privacy"/.test(read('views/partials/foot.ejs')));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
