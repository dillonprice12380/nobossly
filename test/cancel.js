// Cancelling Premium must not crash when Stripe has already ended the
// subscription (cancelled or refunded in the dashboard while we missed the webhook).
//
//   node test/cancel.js
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.SUB_SYNC_SECRET = 'sync-secret';
let fail = 0;
const ok = (n, c) => { if (!c) fail++; console.log(`  ${c ? '✓' : '✗'} ${n}`); };

const rpcCalls = [];
const fakeClient = { rpc: async (fn, args) => { rpcCalls.push({ fn, args }); return { data: null, error: null }; } };
const sp = require.resolve('../src/supabase');
require.cache[sp] = { id: sp, filename: sp, loaded: true, exports: { anonClient: () => fakeClient, serviceClient: () => fakeClient } };
const billing = require('../src/routes/billing');
const layer = billing.router.stack.find(l => l.route && l.route.path === '/billing/cancel');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

let post, get;
global.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET';
  const r = method === 'POST' ? post : get;
  return { ok: r.status < 400, status: r.status, json: async () => r.json };
};
const run = async () => {
  rpcCalls.length = 0; let to = null, nexted = null;
  await handler({ user: { id: 'u1' }, profile: { stripe_subscription_id: 'sub_1' } }, { redirect: u => { to = u; } }, e => { nexted = e; });
  return { to, nexted, applied: rpcCalls.filter(c => c.fn === 'apply_subscription').map(c => c.args) };
};
const end = new Date(Math.floor(Date.now() / 1000) * 1000 + 864e5 * 20).toISOString();
const subOk = { id: 'sub_1', status: 'active', items: { data: [{ current_period_end: Math.floor(Date.parse(end) / 1000) }] } };
const err = m => ({ status: 400, json: { error: { message: m } } });

(async () => {
  post = { status: 200, json: subOk };
  let r = await run();
  ok('a live subscription is set to end with the period', r.to === '/account?sub=canceled' && r.applied.length === 1 && r.applied[0].p_status === 'canceled' && r.applied[0].p_period_end === end);

  post = err('A canceled subscription can only update its cancellation_details and metadata.'); get = { status: 200, json: { id: 'sub_1', status: 'canceled' } };
  r = await run();
  const t = r.applied[0] && Date.parse(r.applied[0].p_period_end);
  ok('a subscription Stripe already ended is closed here, with no error page', r.to === '/account?sub=canceled' && !r.nexted && r.applied.length === 1 && r.applied[0].p_status === 'canceled' && t && Math.abs(t - Date.now()) < 60000);

  post = err('No such subscription: sub_1'); get = err('No such subscription: sub_1');
  r = await run();
  ok('a subscription Stripe no longer knows is closed too', r.to === '/account?sub=canceled' && r.applied.length === 1);

  post = err('Stripe is having a bad day'); get = { status: 200, json: { id: 'sub_1', status: 'active' } };
  r = await run();
  ok('any other Stripe failure changes nothing and says so', !r.applied.length && !r.nexted && /^\/account\?e=/.test(r.to));

  if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch(e => { console.error(e); process.exit(1); });
