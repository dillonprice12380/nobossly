// The mobile app (mobile/) shows these pages inside a native shell. Two things
// on the server make that work, and both are easy to break without noticing:
// the in-app layout, and the sign-in hand-off from the system browser.
//
//   node test/mobile-app.js
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`); };

const server = read('server.js');
const head = read('views/partials/head.ejs');
const auth = read('src/routes/auth.js');
const appConfig = read('mobile/src/lib/config.ts');

console.log('\nIn-app layout:');
ok('the server spots the app by its user agent', /inApp = \/\\bNoBosslyApp\\\/\//.test(server));
ok('...which is the one the app sends', /'NoBosslyApp\/'/.test(appConfig));
ok('pages hide the site header, footer and tab bars in the app',
   /body\.in-app > \.nav/.test(head) && /\.footer/.test(head) && /\.appnav/.test(head) && /\.appbar/.test(head));
ok('the marketing homepage sends app visitors to log in', /if \(res\.locals\.inApp\) return res\.redirect\('\/login'\)/.test(server));

console.log('\nApp sign-in hand-off:');
ok('/auth/app/finish exists', /router\.get\('\/auth\/app\/finish'/.test(auth));
ok('...and refuses requests without the app header (login CSRF)', /req\.get\('x-nobossly-app'\) !== '1'/.test(auth));
ok('...which the app sends', /'X-NoBossly-App': '1'/.test(read('mobile/src/lib/socialSignIn.ts')));
ok('web and app share one code exchange', (auth.match(/await finishOAuth\(/g) || []).length === 2);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
