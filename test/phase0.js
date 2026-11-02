// Phase 0 of the restructure: safe to start marketing.
//
//  - Premium is off: no page a member can reach mentions it, prices, upgrading
//    or billing, and every tool is open. The Stripe and PayPal webhooks stay
//    mounted so neither sees failures.
//  - The migrations that go with it are written for review, not applied.
//
//   node test/phase0.js

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

// ---------------------------------------------------------------------------
console.log('\nPremium is off:');
{
  const { FLAGS } = require('../src/features');
  // Shelved until there are members to want them. (Challenges, results,
  // collaborators and the help board came back on in Phase 1.)
  const SHELVED_FLAGS = ['premium', 'ladder', 'trophies', 'sprints', 'analytics', 'friendships'];
  ok('every shelved flag is off', SHELVED_FLAGS.every(k => FLAGS[k] === false), SHELVED_FLAGS.filter(k => FLAGS[k] !== false).join(', ') || SHELVED_FLAGS.join(', '));

  const premium = require('../src/premium');
  ok('every member has the tools', premium.hasPremium({ subscription_status: null }) === true);
  let passed = false;
  premium.requirePremium('quit')({ profile: {} }, { status: () => ({ render: () => {} }) }, () => { passed = true; });
  ok('...and no tool shows its sales page', passed);

  const server = read('server.js');
  ok('the billing pages are only mounted with the flag on', /if \(FLAGS\.premium\) app\.use\('\/', billing\.router\)/.test(server));
  ok('the Stripe and PayPal webhooks are mounted regardless',
     /^app\.post\('\/billing\/webhook'/m.test(server) && /^app\.post\('\/billing\/paypal\/webhook'/m.test(server));
  const billingRe = /\/billing\/\(\?!webhook\$\|paypal\\\/webhook\$\)/;
  ok('/pricing and /billing/* (not the webhooks) go to the dashboard', /checkout\|upgrade\|pricing/.test(server) && billingRe.test(server.replace(/\\\\/g, '\\')) || /billing\\\/\(\?!webhook\$\|paypal\\\/webhook\$\)/.test(server));
  ok('/pricing is in the sitemap only with the flag on', /\.\.\.\(FLAGS\.premium \? \[\{ loc: base \+ '\/pricing'/.test(server));

  // Render what a signed-in member sees and read the visible text.
  const V = f => path.join(ROOT, 'views', f);
  const base = {
    title: 'T', user: { id: 'u' }, profile: { id: 'u', username: 'u', display_name: 'U' }, plan: 'paid', currentPath: '/dashboard',
    canonicalUrl: 'https://nobossly.com/', unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: 'theme-light',
    settings: {}, pendingDeletion: null, reactivated: false, isPremium: true, flags: FLAGS, flashErr: null,
    affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false },
    premiumTools: premium.TOOLS, paths: require('../src/paths').MARKETED
  };
  const render = (f, data) => ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) });
  const visible = html => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // NoBossly's own paid tier. "Pricing" alone is not on the list: members price
  // their own work, and the pages say so ("a pricing page", the Pricing &
  // Margin Calculator). A link to /pricing is caught below.
  const SHELVED = /\b(premium|upgrade|billing|subscription)\b|\$\d+(\.\d\d)?\s*(\/\s*mo|a month|per month|a year)|see pricing/i;
  const pages = {
    'help.ejs': {}, 'how_it_works.ejs': {},
    'tools/index.ejs': { welcome: true },
    'account.ejs': { p: { id: 'u', username: 'u', email: 'u@x', is_lifetime: false, subscription_status: 'active', profile_is_public: true }, tierName: 'Premium Monthly', msg: null, err: null }
  };
  for (const [f, data] of Object.entries(pages)) {
    let html = '';
    try { html = render(f, data); } catch (e) { ok(`${f} renders`, false, e.message.split('\n').pop()); continue; }
    const text = visible(html);
    const hit = text.match(SHELVED);
    // Links count too: a member must not find a way to the pricing page.
    const link = /href="\/(pricing|billing)/.test(html);
    ok(`${f}: no Premium, pricing or billing in what a member sees`, !hit && !link, hit ? `"${hit[0]}"` : link ? 'a link to /pricing or /billing' : 'clean');
  }
  // The tools now sit under Workspace and Money (2026-11-02), so no nav says
  // Toolkit, and nothing shows the upgrade icon.
  ok('no nav says Toolkit, and the upgrade icon is gone',
     !/Toolkit/.test(read('views/partials/appnav.ejs') + read('views/partials/head.ejs')) && !/i-upgrade/.test(read('views/partials/appnav.ejs') + read('views/partials/head.ejs')));
  ok('no email mentions Premium', !/premium|upgrade|pricing/i.test(read('src/mailer.js')));
  ok('the Premium setup moved out of the README', !/STRIPE_SECRET_KEY/.test(read('README.md')) && /STRIPE_SECRET_KEY/.test(read('docs/premium-setup.md')));
}

// ---------------------------------------------------------------------------
console.log('\nEach migration says whether it is live:');
{
  const applied = ['lock_down_all_function_grants', 'personal_info_filter', 'drop_ai_era_tables', 'premium_off_everyone_has_tools'].map(n => `migrations/2026-11-01_${n}.sql`);
  for (const f of applied) ok(`${path.basename(f)} says it was applied`, /^-- Applied live 2026-11-0[12]/.test(read(f)));


  const grants = read('migrations/2026-11-01_lock_down_all_function_grants.sql');
  const KEEP_ANON = ['affiliate_go', 'increment_blog_views', 'log_app_error', 'proof_page', 'is_admin'];
  ok('nothing that must stay anonymous is revoked from anon',
     KEEP_ANON.every(fn => !new RegExp(`revoke execute on function public\\.${fn}\\(`).test(grants)));
  // Every RPC Express calls with a member's session keeps `authenticated`.
  const called = new Set();
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/\.rpc\('([a-z_]+)'/g)) called.add(m[1]);
  });
  walk(path.join(ROOT, 'src'));
  const SERVICE_ONLY = ['apply_subscription', 'find_user_by_stripe_sub', 'process_task_reminders'];
  const broken = [...called].filter(fn => !SERVICE_ONLY.includes(fn)
    && new RegExp(`revoke execute on function public\\.${fn}\\([^;]*from public, anon, authenticated;`).test(grants));
  ok('no RPC the app calls as a member loses EXECUTE for members', broken.length === 0, broken.join(', ') || `${called.size} RPCs checked`);
  ok('the service-only RPCs are called with the service key',
     /function subClient\(\) \{\s*return serviceClient\(\);\s*\}/.test(read('src/routes/billing.js'))
     && /sc\.rpc\('process_task_reminders'\)/.test(read('server.js')));

  const drop = read('migrations/2026-11-01_drop_ai_era_tables.sql');
  ok('the AI-table drop keeps a copy of every table with rows before dropping anything',
     ['founder_compasses','ai_credits','ai_credit_plans','ai_credit_costs','ai_memory','generation_jobs','questionnaire_responses','fit_criteria_library','business_taxonomy','founder_levels','guide_h2_backup']
       .every(t => drop.includes(`create table archive.${t}_2026_11`) && drop.indexOf(`create table archive.${t}_2026_11`) < drop.indexOf('drop table if exists')));
  ok('...out of reach of the site', /revoke all on schema archive from public, anon, authenticated;/.test(drop) && /revoke all on all tables in schema archive from public, anon, authenticated;/.test(drop));
  ok('...rewrites the signup function before dropping ai_memory', drop.indexOf('create or replace function public.bootstrap_new_user') < drop.indexOf('public.ai_memory,')
     && !/insert into public\.ai_memory/i.test(drop));
  ok('...and uses no CASCADE', !/\bcascade\b/i.test(drop.replace(/^--.*$/gm, '')));
  const DROPPED = ['generated_ideas', 'blueprints', 'founder_compasses', 'idea_signals', 'questionnaire_responses', 'generation_jobs', 'ai_credits', 'ai_memory'];
  const stillRead = [];
  const scan = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) scan(p);
    else if (p.endsWith('.js')) { const s = fs.readFileSync(p, 'utf8'); DROPPED.forEach(t => { if (s.includes(`from('${t}')`)) stillRead.push(path.relative(ROOT, p) + ':' + t); }); }
  });
  scan(path.join(ROOT, 'src'));
  ok('nothing in src/ still reads a table being dropped', stillRead.length === 0, stillRead.join(', ') || 'clean');
  ok('the AI job-polling route is gone', !fs.existsSync(path.join(ROOT, 'src/routes/jobs.js')) && !/routes\/jobs/.test(read('server.js')));
}

console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
process.exit(fail ? 1 : 0);
