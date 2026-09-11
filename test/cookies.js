// Cookie scope has one definition, and it is the right one.
//
// The bug this guards: src/routes/auth.js used to carry its own
// COOKIE_DOMAIN default of '.nobossly.com' while src/middleware/auth.js
// defaulted to host-only. The PKCE verifier was therefore pinned to
// .nobossly.com on every host — and a browser on localhost or a staging
// domain rejects that cookie outright, so the verifier never came back and
// social sign-in failed with "Sign-in was cancelled or expired".
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const fs = require('fs');

let fail = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ✓ ' + label + (detail ? '  — ' + detail : ''));
  else { fail++; console.log('  ✗ ' + label + (detail ? '  — ' + detail : '')); }
};
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// --- the source itself ----------------------------------------------------
console.log('\nThere is one definition of cookie scope:');
const mw = read('src/middleware/auth.js');
const routes = read('src/routes/auth.js');
ok('only the middleware reads COOKIE_DOMAIN from the environment',
   (routes.match(/process\.env\.COOKIE_DOMAIN/g) || []).length === 0 &&
   (mw.match(/process\.env\.COOKIE_DOMAIN/g) || []).length === 1);
ok('...and the routes import that scope rather than redefining it',
   /require\('\.\.\/middleware\/auth'\)/.test(routes) && /cookieDomainOpts/.test(routes));
ok('no cookie is pinned to .nobossly.com when it is set',
   !/res\.cookie\([^)]*\.nobossly\.com/.test(routes) && !/res\.cookie\([^)]*\.nobossly\.com/.test(mw),
   'a hardcoded domain is rejected on every other host');
ok('secure is decided from the request, not NODE_ENV',
   !/secure: process\.env\.NODE_ENV/.test(routes),
   'behind a TLS-terminating proxy req.secure is false but x-forwarded-proto is https');

// --- what the server actually sends ---------------------------------------
// Drive the real /auth/oauth/google route and read Set-Cookie off the wire.
function serve(envDomain, done) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('src', 'middleware', 'auth')) || k.includes(path.join('src', 'routes', 'auth'))) {
      delete require.cache[k];
    }
  }
  if (envDomain === null) delete process.env.COOKIE_DOMAIN;
  else process.env.COOKIE_DOMAIN = envDomain;
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'stub';

  const app = express();
  app.use(cookieParser());
  app.use(require(path.join(__dirname, '..', 'src/routes/auth.js')));
  const server = app.listen(0, () => {
    const port = server.address().port;
    http.get({ host: '127.0.0.1', port, path: '/auth/oauth/google', headers: { host: hostHeader } }, res => {
      const set = (res.headers['set-cookie'] || []).find(c => c.startsWith('pkce_verifier=')) || '';
      server.close(() => done(set));
      res.resume();
    });
  });
}

let hostHeader = 'localhost';
console.log('\nWhat the server actually sends:');
serve(null, onLocal);

function onLocal(set) {
  ok('on localhost the verifier is set at all', /^pkce_verifier=.+/.test(set), set || '(no cookie)');
  ok('...with no Domain, so the browser keeps it',
     !/Domain=/i.test(set), set);
  ok('...and not marked Secure over plain http', !/;\s*Secure/i.test(set), set);
  ok('...httpOnly, so script cannot read the verifier', /HttpOnly/i.test(set), set);

  hostHeader = 'nobossly.com';
  serve(null, onProd);
}

function onProd(set) {
  ok('on nobossly.com it is still host-only by default', !/Domain=/i.test(set), set);
  hostHeader = 'nobossly.com';
  serve('.nobossly.com', onConfigured);
}

function onConfigured(set) {
  ok('setting COOKIE_DOMAIN still widens it when you want that',
     /Domain=\.nobossly\.com/i.test(set), set);

  // And the same env var must reach the session cookies, not just this one.
  delete require.cache[require.resolve(path.join(__dirname, '..', 'src/middleware/auth.js'))];
  process.env.COOKIE_DOMAIN = '.example.test';
  const auth = require(path.join(__dirname, '..', 'src/middleware/auth.js'));
  const opts = auth.cookieOpts({ headers: { 'x-forwarded-proto': 'https' }, protocol: 'http' });
  ok('session cookies read the same COOKIE_DOMAIN', opts.domain === '.example.test', String(opts.domain));
  ok('...and trust x-forwarded-proto for Secure', opts.secure === true);
  const short = auth.cookieOpts({ headers: {}, protocol: 'http' }, { maxAge: 600000 });
  ok('...and a short-lived cookie keeps the same scope, only a shorter life',
     short.maxAge === 600000 && short.domain === '.example.test' && short.secure === false);

  console.log(fail ? `\n${fail} failing` : '\nAll good');
  process.exit(fail ? 1 : 0);
}
