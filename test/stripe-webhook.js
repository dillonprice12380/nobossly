// The Stripe webhook is the one route that grants paid access without a
// logged-in member in front of it. So: a forged or replayed body must be
// refused, and a checkout NoBossly didn't start must never unlock Premium.
//
//   node test/stripe-webhook.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifySignature } = require('../src/routes/billing');

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`); };

const secret = 'whsec_test';
const body = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}');
const now = 1790000000 * 1000;
const sign = (t, b, s) => crypto.createHmac('sha256', s || secret).update(t + '.' + b).digest('hex');
const t = String(now / 1000);

console.log('\nSignature check:');
ok('a correctly signed body is accepted', verifySignature(body, `t=${t},v1=${sign(t, body)}`, secret, now));
ok('...alongside a stale v1 from a rotated secret', verifySignature(body, `t=${t},v1=${sign(t, body, 'old')},v1=${sign(t, body)}`, secret, now));
ok('a tampered body is refused', !verifySignature(Buffer.from(body.toString().replace('completed', 'expired')), `t=${t},v1=${sign(t, body)}`, secret, now));
ok('the wrong secret is refused', !verifySignature(body, `t=${t},v1=${sign(t, body, 'nope')}`, secret, now));
ok('a replay older than five minutes is refused', !verifySignature(body, `t=${t},v1=${sign(t, body)}`, secret, now + 301000));
ok('a missing header is refused', !verifySignature(body, undefined, secret, now));
ok('garbage is refused', !verifySignature(body, 't=abc,v1=zz', secret, now));

console.log('\nOnly NoBossly checkouts unlock Premium:');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/billing.js'), 'utf8');
ok('checkout tags the session', /'metadata\[app\]': APP_TAG/.test(src));
ok('...and the subscription', /subscription_data\[metadata\]\[app\]/.test(src));
ok('the webhook skips untagged sessions', /metadata\.app !== APP_TAG/.test(src));
ok('a failure answers 5xx so Stripe retries', /res\.status\(500\)/.test(src));

console.log('\nButtons that leave for Stripe bypass Turbo:');
// Turbo submits forms with fetch(), and fetch() cannot follow the 303 to
// checkout.stripe.com / billing.stripe.com — the click silently does nothing.
const view = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// Whole lines, since the checkout form's action holds an EJS tag with a '>'.
const forms = [...view('views/pricing.ejs').match(/<form[^\n]*\/billing\/checkout[^\n]*/g) || [],
               ...view('views/account.ejs').match(/<form[^\n]*\/billing\/portal[^\n]*/g) || []];
ok('the checkout and billing-portal forms are all found', forms.length === 2);
ok('...and every one has data-turbo="false"', forms.length && forms.every(f => /data-turbo="false"/.test(f)));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
