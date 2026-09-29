// Social sign-in broke silently: Turbo prefetched the Google/LinkedIn/GitHub
// buttons on hover, and every prefetch minted a new PKCE verifier over the
// cookie of the sign-in actually clicked, so Supabase's code could never be
// exchanged. These checks keep the buttons out of Turbo and the server deaf to
// prefetches.
//
//   node test/oauth.js

const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`); };

console.log('\nSocial sign-in buttons:');
for (const view of ['views/login.ejs', 'views/signup.ejs']) {
  const links = read(view).match(/<a[^>]*href="\/auth\/oauth\/[^"]*"[^>]*>/g) || [];
  ok(`${view} has all three providers`, links.length === 3);
  ok(`${view}: every button bypasses Turbo`, links.length && links.every(a => /data-turbo="false"/.test(a)));
  ok(`${view}: ...and is never prefetched`, links.length && links.every(a => /data-turbo-prefetch="false"/.test(a)));
}

console.log('\nServer side:');
const auth = read('src/routes/auth.js');
ok('a prefetch of /auth/oauth/* does not start a sign-in', /if \(isPrefetch\(req\)\) return res\.status\(204\)/.test(auth));
ok('a code delivered to the Site URL is forwarded to /auth/callback', /res\.redirect\('\/auth\/callback\?'/.test(read('server.js')));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
