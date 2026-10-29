// A test copy of the site (PAYPAL_ENV=sandbox) uses sandbox plan ids from its own
// environment; a live site never does.
//   node test/sandbox-plans.js
let fail = 0;
const ok = (n, c) => { if (!c) fail++; console.log(`  ${c ? '✓' : '✗'} ${n}`); };
const sp = require.resolve('../src/supabase');
const rows = { month: { key: 'month', mode: 'subscription', paypal_plan_id: 'P-LIVEMONTH' }, year: { key: 'year', mode: 'subscription', paypal_plan_id: 'P-LIVEYEAR' } };
const fake = { from: () => { const f = {}; const q = { select: () => q, eq: (c, v) => { f[c] = v; return q; }, maybeSingle: async () => ({ data: f.key ? rows[f.key] : Object.values(rows).find(r => r.paypal_plan_id === f.paypal_plan_id) || null }) }; return q; }, rpc: async () => ({ data: null, error: null }) };
require.cache[sp] = { id: sp, filename: sp, loaded: true, exports: { anonClient: () => fake, serviceClient: () => fake } };
delete process.env.PAYPAL_ENV;
const billing = require('../src/routes/billing');
ok('a live site keeps the stored plan ids', billing.withPlan(rows.month).paypal_plan_id === 'P-LIVEMONTH');
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_SANDBOX_PLAN_MONTH = 'P-SBMONTH1';
ok('a sandbox site uses its own plan id', billing.withPlan(rows.month).paypal_plan_id === 'P-SBMONTH1');
ok('...without touching the stored row', rows.month.paypal_plan_id === 'P-LIVEMONTH');
ok('...and sells nothing for a plan it was not given', billing.withPlan(rows.year).paypal_plan_id === null);
process.env.PAYPAL_SANDBOX_PLAN_YEAR = 'not a plan';
ok('a malformed id is ignored', billing.withPlan(rows.year).paypal_plan_id === null);
ok('lifetime (no plan) passes through', billing.withPlan({ key: 'lifetime', mode: 'payment' }).paypal_plan_id === null);
(async () => {
  if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
  console.log('\nall passed');
})();
