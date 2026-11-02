// The leaked-password check (src/pwned.js), with a stand-in for the Have I
// Been Pwned range API, plus a check that every place a password is set uses it.
//
//   node test/pwned.js

const fs = require('fs');
const path = require('path');
const pwned = require('../src/pwned');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// "password" — the most breached password there is.
const HASH = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8';

// A stand-in for the range API: answers for one prefix, with padding rows.
function fakeApi(rows, calls) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, text: async () => rows.join('\r\n') };
  };
}

(async () => {
  console.log('Privacy:');
  ok('SHA-1 is computed the standard way', pwned.sha1('password') === HASH);
  const calls = [];
  await pwned.timesPwned('password', { fetchImpl: fakeApi([], calls) });
  ok('only the first five characters of the hash are sent', calls[0].url === pwned.API + '5BAA6' && !calls[0].url.slice(pwned.API.length).includes('password') && !calls[0].url.includes(HASH.slice(5)));
  ok('responses are padded so their size gives nothing away', calls[0].opts.headers['Add-Padding'] === 'true');
  ok('the request can be cut off if it hangs', !!calls[0].opts.signal);

  console.log('\nAnswers:');
  const rows = ['0018A45C4D1DEF81644B54AB7F969B88D65:1', HASH.slice(5) + ':10434004', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0'];
  ok('a breached password is found, with its count', (await pwned.timesPwned('password', { fetchImpl: fakeApi(rows, []) })) === 10434004);
  ok('...and refused with a plain message', (await pwned.refusal('password', { fetchImpl: fakeApi(rows, []) })) === pwned.MESSAGE);
  ok('a password not in the list passes', (await pwned.timesPwned('a-long-unusual-phrase-9417', { fetchImpl: fakeApi(rows, []) })) === 0);
  const padded = ['0018A45C4D1DEF81644B54AB7F969B88D65:0', HASH.slice(5) + ':0'];
  ok('padding rows (count 0) never count as a breach', (await pwned.refusal('password', { fetchImpl: fakeApi(padded, []) })) === null);
  ok('lower-case or spaced lines are read correctly', (await pwned.timesPwned('password', { fetchImpl: fakeApi(['  ' + HASH.slice(5) + ':3  '], []) })) === 3);

  console.log('\nWhen the service is unavailable, signing up still works:');
  const quiet = { quiet: true };
  ok('an error status skips the check', (await pwned.refusal('password', Object.assign({ fetchImpl: async () => ({ ok: false, status: 503 }) }, quiet))) === null);
  ok('a network failure skips the check', (await pwned.refusal('password', Object.assign({ fetchImpl: async () => { throw new Error('ECONNRESET'); } }, quiet))) === null);
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t0 = Date.now();
  ok('a hanging request gives up quickly', (await pwned.refusal('password', Object.assign({ fetchImpl: hang, timeoutMs: 50 }, quiet))) === null && Date.now() - t0 < 1000);
  ok('an empty password is not sent anywhere', (await pwned.timesPwned('', { fetchImpl: () => { throw new Error('should not be called'); } })) === null);

  console.log('\nEvery place a password is set checks it, before Supabase sees it:');
  const auth = read('src/routes/auth.js');
  const account = read('src/routes/account.js');
  const before = (src, start, check, call) => {
    const i = src.indexOf(start);
    const a = src.indexOf(check, i);
    const b = src.indexOf(call, i);
    return i > -1 && a > -1 && b > -1 && a < b;
  };
  ok('signup', before(auth, "router.post('/signup'", 'pwned.refusal(password)', 'sb.auth.signUp('));
  ok('password reset', before(auth, "router.post('/reset'", 'pwned.refusal(password)', "/auth/v1/user"));
  ok('password change', before(account, "router.post('/password'", 'pwned.refusal(password)', 'auth.updateUser('));

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
