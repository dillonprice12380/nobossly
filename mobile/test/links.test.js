// Where each link in the app goes. The rules live in src/lib/links.ts; this
// compiles that one file with TypeScript and checks it without a device.
//
//   npm test
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const src = fs.readFileSync(path.join(__dirname, '../src/lib/links.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { classifyLink, isAuthPath } = mod.exports;

const SITE = 'https://nobossly.com/';
let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`); };
const kind = url => classifyLink(url, SITE).kind;

console.log('\nStays in the app:');
ok('site pages', kind('https://nobossly.com/quests') === 'load');
ok('the www host too', kind('https://www.nobossly.com/community/abc') === 'load');
ok('Stripe checkout, so it returns to the signed-in web view', kind('https://checkout.stripe.com/c/pay/cs_live_x') === 'load');
ok('the Stripe billing portal', kind('https://billing.stripe.com/p/session/x') === 'load');
ok('about:blank', kind('about:blank') === 'load');

console.log('\nSocial sign-in runs natively (Google blocks it in web views):');
for (const p of ['google', 'linkedin', 'github']) {
  const a = classifyLink('https://nobossly.com/auth/oauth/' + p, SITE);
  ok(p, a.kind === 'social' && a.provider === p);
}
ok('an unknown provider is just a page', kind('https://nobossly.com/auth/oauth/myspace') === 'load');
ok('the web callback is just a page', kind('https://nobossly.com/auth/callback?code=x') === 'load');

console.log('\nLeaves the app:');
ok('other websites open in the browser sheet', kind('https://www.youtube.com/watch?v=1') === 'browser');
ok('a look-alike host is not the site', kind('https://nobossly.com.evil.io/') === 'browser');
ok('...nor a look-alike Stripe', kind('https://stripe.com.evil.io/') === 'browser');
ok('mailto: goes to the mail app', kind('mailto:hello@nobossly.com') === 'system');
ok('tel: goes to the phone', kind('tel:+15555550123') === 'system');

console.log('\nSign-in state changes are spotted:');
ok('/login', isAuthPath('https://nobossly.com/login'));
ok('/auth/app/finish', isAuthPath('https://nobossly.com/auth/app/finish?code=1'));
ok('/logout', isAuthPath('https://nobossly.com/logout'));
ok('/dashboard is not', !isAuthPath('https://nobossly.com/dashboard'));
ok('a page that merely starts with "login" is not', !isAuthPath('https://nobossly.com/logins-guide'));
ok('/reset/session is', isAuthPath('https://nobossly.com/reset/session'));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
