// Path dashboards, steps 2 and 3: creator, freelancer, Apps & Software,
// exploring, consultant, local service, online store, physical product.
//
//  - Each config's stages are exactly that path's stage answers, in order, so
//    the member's setup answer always finds its place.
//  - Everything a config names (boards, metrics, checklists, worksheets,
//    featured tools) exists, for every subpath and every stage.
//  - Links on checklists go to real pages.
//  - The comparison matrix keeps only what it should and ranks honestly.
//  - The dashboard panel loads, survives a missing table, and renders.
//
//   node test/path_dashboards.js

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

const paths = require('../src/paths');
const dash = require('../src/path_dashboards');
const ws = require('../src/workspace/worksheets');
const matrix = require('../src/workspace/matrix');
const { registry } = require('../src/engines');
const { FLAGS } = require('../src/features');

const SLUGS = ['creator', 'freelancer', 'software', 'exploring', 'consultant', 'local_service', 'online_store', 'physical_product', 'brick_mortar'];
const PREFIX = /^(creator|fl|sw|ex|con|loc|shop|prod|bm)_/;

// A stand-in for supabase-js: every query resolves to the rows given for its
// table (or an error), whatever filters are chained on.
function fakeSb(rows = {}, errors = {}) {
  const calls = [];
  const chain = table => {
    const q = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          const out = errors[table] ? { data: null, error: errors[table] } : { data: rows[table] || [], error: null };
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        return (...args) => { calls.push({ table, prop, args }); return q; };
      }
    });
    return q;
  };
  return { from: t => chain(t), calls };
}

// ---------------------------------------------------------------------------
console.log('Setup questions:');
{
  const wp = dash.setupQuestions('software').find(q => q.name === 'who_pays');
  ok('apps and software: "who pays for it" takes more than one answer', wp && wp.type === 'checks' && wp.options.includes('Consumers') && wp.options.includes('Small businesses'));
  const form = read('views/choose_path_setup.ejs');
  ok('...and an answer saved when it was a single choice still shows ticked', /Array\.isArray\(a\) \? a : \(a \? \[a\] : \[\]\)/.test(form));
}

console.log('Each path has its own dashboard:');
ok('all nine paths are configured', SLUGS.every(s => dash.dashboardFor(s)), Object.keys(dash.DASHBOARDS).join(', '));
ok('only the fallback path has none', Object.keys(dash.PATHS).every(s => dash.dashboardFor(s)) && !dash.dashboardFor('default'));

for (const slug of SLUGS) {
  const d = dash.dashboardFor(slug);
  const stageQ = paths.ownQuestions(slug).find(q => q.name === 'stage');
  ok(`${slug}: stages are the path's own stage answers, in order`,
    JSON.stringify(d.stages.map(s => s.answer)) === JSON.stringify(stageQ.options));
  ok(`${slug}: stages are statuses, with no advice attached`, d.stages.length >= 3 && d.stages.every(s => typeof s.answer === 'string' && !('next' in s) && !('href' in s)));

  const subs = [null].concat(paths.subpathsOf(slug).map(s => s.slug));
  const stages = [null].concat(d.stages.map(s => s.answer));
  const problems = [];
  for (const subpath of subs) for (const stage of stages) {
    const ctx = { subpath, stage, answers: {} };
    const north = d.northStar(ctx);
    if (north && !registry.metric(north)) problems.push('metric ' + north);
    const nl = d.northStarChecklist ? d.northStarChecklist(ctx) : null;
    if (nl && !registry.checklist(nl)) problems.push('checklist ' + nl);
    const nb = dash.northBoardOf(d, ctx);
    if (nb && !registry.board(nb)) problems.push('board ' + nb);
    if (!north && !nb && !nl) problems.push('no north star at ' + subpath + '/' + stage);
    d.supporting(ctx).forEach(k => { if (!registry.metric(k)) problems.push('metric ' + k); });
    if (north && d.supporting(ctx).includes(north)) problems.push(north + ' shown twice');
    d.boards(ctx).forEach(k => { if (!registry.board(k)) problems.push('board ' + k); });
    d.checklists(ctx).forEach(k => { if (!registry.checklist(k)) problems.push('checklist ' + k); });
  }
  (d.worksheets || []).forEach(k => { if (!ws.WORKSHEETS[k] || !dash.TOOLS[k]) problems.push('worksheet ' + k); });
  ok(`${slug}: everything it names exists, for every subpath and stage`, !problems.length, problems.slice(0, 5).join('; ') || 'clean');

  const own = [].concat(...[null].concat(paths.subpathsOf(slug).map(s => s.slug))
    .map(subpath => d.boards({ subpath, stage: null }).concat(d.checklists({ subpath, stage: null }))));
  ok(`${slug}: its keys are prefixed, so no two paths can collide`, own.every(k => PREFIX.test(k)));

  const ranked = dash.workspaceFor(slug);
  // Money tools are counted under Money (2026-11-02), the rest in the Workspace.
  const named = dash.PATHS[slug].featured.concat(dash.PATHS[slug].available);
  ok(`${slug}: featured and available tools all exist`, named.every(k => dash.TOOLS[k])
     && ranked.featured.length + ranked.available.length === named.filter(k => !dash.isMoney(k)).length
     && named.filter(k => dash.isMoney(k)).every(k => dash.moneyToolsFor(slug).mine.some(t => t.key === k)));
}

{
  const c = dash.dashboardFor('creator');
  const n = sub => c.northStar({ subpath: sub });
  ok('creator: the number follows the medium', n('youtube') === 'creator_subscribers' && n('podcast') === 'creator_downloads' && n('blog') === 'creator_visits' && n('social') === 'creator_followers' && n(null) === 'creator_followers');
  ok('creator: newsletters also track open rate', c.supporting({ subpath: 'newsletter' }).includes('creator_open_rate') && !c.supporting({ subpath: 'youtube' }).includes('creator_open_rate'));
  const s = dash.dashboardFor('software');
  ok('software: before launch the number is the waitlist', s.northStar({ stage: 'Building it' }) === 'sw_waitlist');
  ok('software: live with users, it is active users', s.northStar({ stage: 'Live with users' }) === 'sw_active');
  ok('software: with paying customers, it is paying customers', s.northStar({ stage: 'Paying customers' }) === 'sw_paying');
  ok('software: B2B adds a sales pipeline', s.boards({ subpath: 'saas' }).includes('sw_sales') && !s.boards({ subpath: 'consumer' }).includes('sw_sales'));
  ok('software: churn is better when lower', registry.metric('sw_churn').higherIsBetter === false);
  ok('exploring: the north star is experiments finished', dash.dashboardFor('exploring').northStarBoard === 'ex_experiments');
}

{
  const c = dash.dashboardFor('consultant');
  ok('consultant: health and finance coaches get the "what you can claim" list', c.checklists({ subpath: 'health' }).includes('con_claims') && c.checklists({ subpath: 'finance' }).includes('con_claims') && !c.checklists({ subpath: 'business' }).includes('con_claims'));
  const o = dash.dashboardFor('online_store');
  ok('online store: supplied stores get a suppliers board, makers do not', o.boards({ subpath: 'dropship' }).includes('shop_suppliers') && !o.boards({ subpath: 'handmade' }).includes('shop_suppliers'));
  const p = dash.dashboardFor('physical_product');
  ok('physical product: before samples, the development gates are the north star', p.northStar({ stage: 'Prototype made' }) === null && p.northStarChecklist({ stage: 'Prototype made' }) === 'prod_gates');
  ok('physical product: at samples, pre-orders; once selling, units sold', p.northStar({ stage: 'Samples from a manufacturer' }) === 'prod_preorders' && p.northStar({ stage: 'Selling it' }) === 'prod_units' && p.northStarChecklist({ stage: 'Selling it' }) === null);
  ok('local service: no board asks for an address', ['loc_jobs', 'loc_regulars'].every(k => registry.board(k).fields.every(f => !/address|street|phone|email/i.test(f.key))));
}

{
  const b = dash.dashboardFor('brick_mortar');
  const at = stage => ({ north: b.northStar({ stage }), board: dash.northBoardOf(b, { stage }) });
  ok('brick and mortar: while looking, money raised is the number', at('Looking at premises').board === 'bm_funding' && at(null).board === 'bm_funding' && at('Just an idea').north === null);
  ok('brick and mortar: from the lease to opening, the opening plan', at('Fitting out').board === 'bm_opening' && at('Signed or about to sign a lease').board === 'bm_opening');
  ok('brick and mortar: once open, takings, with rent share beside it', at('Open and trading').north === 'bm_takings' && at('Open and trading').board === null && b.supporting({ stage: 'Open and trading' }).includes('bm_rent_share'));
  ok('brick and mortar: rent share and staff share are better lower', registry.metric('bm_rent_share').higherIsBetter === false && registry.metric('bm_staff_cost').higherIsBetter === false);
  ok('brick and mortar: venue rules follow the venue', b.checklists({ subpath: 'food' }).includes('bm_food') && b.checklists({ subpath: 'bar' }).includes('bm_food') && b.checklists({ subpath: 'salon' }).includes('bm_salon') && b.checklists({ subpath: 'fitness' }).includes('bm_fitness') && !b.checklists({ subpath: 'retail' }).some(k => ['bm_food', 'bm_salon', 'bm_fitness'].includes(k)));
  ok('brick and mortar: once open, the opening checklists step aside', !b.checklists({ stage: 'Open and trading' }).includes('bm_lease') && b.checklists({ stage: 'Looking at premises' }).includes('bm_lease'));
  ok('brick and mortar: the site scout shows while looking, not once building', b.boards({ stage: 'Looking at premises' }).includes('bm_sites') && !b.boards({ stage: 'Fitting out' }).includes('bm_sites'));
}

console.log('\nWorksheets that do the arithmetic:');
{
  const sum = (k, d) => ws.summaryOf(ws.WORKSHEETS[k], d);
  const val = (rows, label) => (rows.find(r => r.label.startsWith(label)) || {}).value;
  const q = sum('loc_quote', { hours: 3, rate: 45, materials: 100, markup: 10, callout: 25 });
  ok('a quote adds labour, marked-up materials and call-out', val(q, 'Quote total') === '$270', JSON.stringify(q));
  const qm = sum('loc_quote', { hours: 0.5, rate: 40, minimum: 60 });
  ok('a small job is raised to the minimum', val(qm, 'Quote total') === '$60' && !!val(qm, 'Raised to your minimum'));
  ok('an empty quote shows nothing', sum('loc_quote', {}).length === 0);
  const sp = sum('shop_product', { price: 40, cost: 12, fee_pct: 10, shipping: 5, packaging: 1, ad_cost: 4 });
  ok('a product\'s profit takes off fees, shipping, packaging and ads', val(sp, 'Profit per order') === '$14' && val(sp, 'Margin') === '35%', JSON.stringify(sp));
  const sl = sum('shop_product', { price: 20, cost: 15, fee_pct: 10, shipping: 6 });
  ok('a loss is shown as a loss', /-\$|−\$|\(\$/.test(val(sl, 'Profit per order')) && sl.find(r => r.label === 'Profit per order').tone === 'bad', val(sl, 'Profit per order'));
  ok('handmade time is costed when given', val(sum('shop_product', { price: 40, cost: 5, hours: 1, hourly: 20 }), 'All costs') === '$25');
  ok('low stock says reorder', val(sum('shop_product', { price: 10, stock: 3, reorder_at: 5 }), 'Stock') === 'Time to reorder');
  const b = sum('prod_bom', { unit_cost: 6, packaging: 1, freight: 1.5, duty: 0.5, tooling: 2000, order_qty: 1000, retail: 40 });
  ok('landed cost spreads tooling over the run', val(b, 'Landed cost') === '$11', JSON.stringify(b));
  ok('cash needed for the run includes tooling', val(b, 'Cash needed') === '$11,000');
  ok('wholesale defaults to half of retail', val(b, 'Margin at wholesale (half of retail)') === '45%');
  ok('the 4× rule is checked', /^No/.test(val(b, 'Retail at least 4×')) && /^Yes/.test(val(sum('prod_bom', { unit_cost: 5, retail: 40 }), 'Retail at least 4×')));
  ok('the offer builder says how many clients a goal needs', val(sum('con_offer', { price: 1500 }), 'Clients a month') === '4 at $1,500');
  const be = sum('bm_breakeven', { rent: 3000, staff: 9000, other_fixed: 3000, avg_spend: 12, cost_pct: 30, days: 26, expected: 100 });
  ok('break-even: customers a month and a day', val(be, 'Customers a month') === '1,786' && val(be, 'Customers a day') === '69', JSON.stringify(be));
  ok('break-even: takings needed and rent share', val(be, 'Takings needed') === '$21,432' && val(be, 'Rent at break-even') === '14%');
  ok('break-even: profit at the expected trade', val(be, 'At your expected customers') === 'Profit $6,840 a month');
  ok('break-even: a sale that loses money is flagged', val(sum('bm_breakeven', { rent: 1000, avg_spend: 10, cost_pct: 120 }), 'Each sale loses money') !== undefined);
  const st = sum('bm_startup', { deposit: 9000, fitout: 40000, equipment: 25000, stock: 4000, monthly: 15000, reserve_months: 3, have: 50000 });
  ok('start-up: one-off costs, reserve and total', val(st, 'One-off costs') === '$78,000' && val(st, 'Running-cost reserve') === '$45,000' && val(st, 'Total needed') === '$123,000', JSON.stringify(st));
  ok('start-up: what is still to raise, and a missing contingency', val(st, 'Still to raise') === '$73,000' && !!val(st, 'No contingency yet'));
  ok('a broken summary never breaks the page', ws.summaryOf({ summary: () => { throw new Error('x'); } }, {}).length === 0);
}

// ---------------------------------------------------------------------------
console.log('\nChecklist links go somewhere real:');
{
  const server = read('server.js');
  const pages = ['/tools/proof', '/tools/pricing', '/tools/tax', '/tools/interviews', '/budget', '/choose-path', '/surveys'];
  const bad = [];
  for (const c of registry.all().checklists.filter(c => PREFIX.test(c.key))) {
    for (const it of c.items) {
      if (!it.link) continue;
      if (/^https:\/\//.test(it.link)) continue;
      const m = it.link.match(/^\/workspace\/(boards|docs)\/([a-z0-9_]+)$/);
      if (m) {
        if (m[1] === 'boards' ? !registry.board(m[2]) : !ws.WORKSHEETS[m[2]]) bad.push(it.link);
        continue;
      }
      if (!pages.includes(it.link)) bad.push(it.link);
    }
  }
  ok('every internal link is a known page, board or worksheet', !bad.length, bad.join(', ') || 'clean');
  ok('external links are https only', registry.all().checklists.every(c => c.items.every(i => !i.link || i.link.startsWith('/') || i.link.startsWith('https://'))));
  ok('the tools those links point at are mounted', ['/tools', '/budget', '/choose-path', '/workspace', '/surveys'].every(m => server.includes(`'${m}'`)));
}

// ---------------------------------------------------------------------------
console.log('\nPath worksheets:');
{
  ok('defining the same worksheet twice fails loudly', (() => { try { ws.defineWorksheet('fl_proposal', { label: 'x', sections: [{ key: 'a', label: 'A', type: 'text' }] }); return false; } catch (e) { return /already/.test(e.message); } })());
  ok('a bad section type fails loudly', (() => { try { ws.defineWorksheet('zz_bad', { label: 'x', sections: [{ key: 'aa', label: 'A', type: 'colour' }] }); return false; } catch (e) { return /type/.test(e.message); } })());
  const d = ws.clean(ws.WORKSHEETS.fl_proposal, { price: '$1,200', deposit: '400', status: 'Sent', deliverables: 'Logo\nBrand sheet\n', evil: 'x', revisions: 'two' });
  ok('a proposal keeps prices as numbers and drops unknown fields', d.price === 1200 && d.deposit === 400 && d.status === 'Sent' && !('evil' in d) && !('revisions' in d) && d.deliverables.length === 2);
  ok('an unknown status is dropped', !('status' in ws.clean(ws.WORKSHEETS.fl_proposal, { status: 'Won!!' })));
  ok('the MVP scope keeps its ship date', ws.clean(ws.WORKSHEETS.sw_mvp_scope, { ship_by: '2027-01-15' }).ship_by === '2027-01-15');
}

// ---------------------------------------------------------------------------
console.log('\nThe options matrix:');
{
  const def = ws.WORKSHEETS.ex_options;
  const body = {
    opt_0: 'Dog walking', opt_1: '', opt_2: 'Etsy prints', opt_3: 'Tutoring',
    crit_0: 'Uses my skills', w_0: '3', crit_1: 'Low cost', w_1: '1', crit_2: '', w_2: '3', crit_3: 'Fits my hours', w_3: '9',
    s_0_0: '2', s_0_1: '5', s_0_3: '5',
    s_2_0: '4', s_2_1: '4', s_2_3: '3',
    s_3_0: '5', s_3_1: '3', s_3_3: '4', s_3_2: '5',
    s_1_0: '5', s_9_9: '5', s_0_0x: '4'
  };
  const data = ws.clean(def, body);
  ok('blank options and criteria are dropped, order kept', JSON.stringify(data.options) === '["Dog walking","Etsy prints","Tutoring"]' && data.criteria.map(c => c.label).join('|') === 'Uses my skills|Low cost|Fits my hours');
  ok('a weight outside 1–3 becomes "matters"', data.criteria[2].weight === 2 && data.criteria[0].weight === 3 && data.criteria[1].weight === 1);
  ok('scores follow their option and criterion when blanks close up', data.scores['1:0'] === 4 && data.scores['2:2'] === 4 && data.scores['0:2'] === 5);
  ok('scores for blank rows or columns are dropped', Object.keys(data.scores).length === 9, Object.keys(data.scores).join(','));
  const r = matrix.results(data);
  ok('weighted totals rank the options', r.ranked[0].label === 'Tutoring' && r.ranked[0].total === 5 * 3 + 3 * 1 + 4 * 2, r.ranked.map(x => x.label + ' ' + x.total).join(', '));
  ok('a percentage of the best possible score', r.ranked[0].pct === Math.round(26 / 30 * 100));
  ok('a tie at the top names no leader', matrix.results({ options: ['A', 'B'], criteria: [{ label: 'x', weight: 2 }], scores: { '0:0': 3, '1:0': 3 } }).tie === true);
  ok('nothing scored names no leader', matrix.results({ options: ['A', 'B'], criteria: [{ label: 'x', weight: 2 }], scores: {} }).leader === null);
  ok('progress counts fully scored options', ws.progress(def, data).done === 3);
  ok('an empty matrix is safe', matrix.results(undefined).rows.length === 0 && ws.progress(def, {}).done === 0);
}

// ---------------------------------------------------------------------------
async function panels() {
  console.log('\nThe dashboard panel:');
  const now = new Date('2026-11-15T12:00:00Z');
  const sb = fakeSb({
    metric_entries: [{ id: 'e1', metric: 'fl_income', period: '2026-11-01', value: 2400, note: null }, { id: 'e2', metric: 'fl_income', period: '2026-10-01', value: 1800, note: null }],
    pipeline_items: [{ stage: 'lead', value: 500 }, { stage: 'won', value: 1200 }],
    checklist_progress: [{ item: 'scope', done_at: '2026-11-01T00:00:00Z', due_on: null, note: null }]
  });
  const profile = { path: 'freelancer', subpath: 'design', path_answers: { stage: 'Some regular clients' } };
  const p = await dash.panelFor(sb, 'me', profile, now);
  ok('it knows the stage, and hands down no next step', p.stage.index === 2 && p.stage.current === 'Some regular clients' && !('next' in p.stage));
  ok('the north star is billable income', p.north && p.north.def.key === 'fl_income' && p.north.display.latest.includes('2,400'), p.north && p.north.display.latest);
  ok('supporting numbers and boards load; checklists stay in the workspace', p.supporting.length === 3 && p.boards.length === 2 && !('checklists' in p));
  ok('every query is the member\'s own', sb.calls.filter(c => c.prop === 'eq' && c.args[0] === 'user_id').every(c => c.args[1] === 'me') && sb.calls.some(c => c.prop === 'eq' && c.args[0] === 'user_id'));
  ok('not "being set up" when the tables are there', p.notReady === false);

  const missing = { code: 'PGRST205', message: "Could not find the table 'public.metric_entries'" };
  const p2 = await dash.panelFor(fakeSb({}, { metric_entries: missing, pipeline_items: missing, checklist_progress: missing }), 'me', profile, now);
  ok('a missing table marks it "being set up" instead of failing', p2 && p2.notReady === true && p2.north === null && p2.boards.length === 0);

  const p3 = await dash.panelFor(fakeSb(), 'me', { path: 'exploring', path_answers: {} }, now);
  ok('no stage answered: it just has none', p3.stage.index === -1 && p3.stage.current === null);
  ok('exploring shows its experiments board as the number', p3.northBoard && p3.northBoard.def.key === 'ex_experiments' && p3.boards.length === 0);
  ok('a path without a dashboard gets none', (await dash.panelFor(fakeSb(), 'me', { path: 'default' }, now)) === null);
  ok('a member with no path gets none', (await dash.panelFor(fakeSb(), 'me', {}, now)) === null);

  const items = dash.pathItemsFor({ path: 'software', subpath: 'saas', path_answers: { stage: 'Building it' } });
  ok('the workspace hub lists the path\'s boards, numbers and checklists', items.boards.length === 3 && items.metrics[0].key === 'sw_waitlist' && items.checklists.length === 2);

  // Rendering.
  const V = f => path.join(ROOT, 'views', f);
  const base = {
    title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me', path: 'freelancer' }, plan: 'paid', currentPath: '/dashboard', canonicalUrl: 'x',
    unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
    isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [],
    affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
  };
  const render = (f, data) => ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) });
  let html = '';
  try { html = render('partials/path_panel.ejs', { panel: p, pathInfo: { label: 'Freelancer', emoji: '💻' } }); } catch (e) { html = 'ERR ' + e.message; }
  ok('the panel renders the stage as a label, the numbers and the boards, and no advice', html.includes('Your freelancer dashboard') && html.includes('Where you are:') && html.includes('Some regular clients') && html.includes('Billable income') && html.includes('Client pipeline') && !html.includes('Contract essentials') && !/Next:/.test(html), html.startsWith('ERR') ? html.slice(0, 200) : undefined);
  let html3 = '';
  try { html3 = render('partials/path_panel.ejs', { panel: p3, pathInfo: { label: 'Still figuring it out', emoji: '🧭' } }); } catch (e) { html3 = 'ERR ' + e.message; }
  ok('with no stage, it points at path settings', html3.includes('path settings') && html3.includes('Two-week experiments'), html3.startsWith('ERR') ? html3.slice(0, 200) : undefined);
  let html2 = '';
  try { html2 = render('partials/path_panel.ejs', { panel: p2, pathInfo: { label: 'Freelancer', emoji: '💻' } }); } catch (e) { html2 = 'ERR ' + e.message; }
  ok('before the tables exist, it says so', html2.includes('being set up'), html2.startsWith('ERR') ? html2.slice(0, 200) : undefined);

  const def = ws.WORKSHEETS.ex_options;
  const data = ws.clean(def, { opt_0: 'A', opt_1: 'B', crit_0: 'Money', w_0: '3', s_0_0: '4', s_1_0: '2', decision: 'Test A first' });
  let mx = '';
  try {
    mx = render('workspace/doc.ejs', { def, kind: 'ex_options', doc: { id: 'd1', title: 'Which one', updated_at: now.toISOString() }, data,
      progress: ws.progress(def, data), score: null, pitch: null, saved: false, matrix: matrix.results(data) });
  } catch (e) { mx = 'ERR ' + e.message; }
  ok('the matrix page renders the grid, the leader and the decision', mx.includes('name="s_1_0"') && mx.includes('Leading: A') && mx.includes('Test A first') && mx.includes('name="crit_3"'), mx.startsWith('ERR') ? mx.slice(0, 200) : undefined);
  let mx2 = '';
  try {
    mx2 = render('workspace/doc.ejs', { def, kind: 'ex_options', doc: { id: 'd1', title: '', updated_at: now.toISOString() }, data: {},
      progress: ws.progress(def, {}), score: null, pitch: null, saved: false, matrix: matrix.results({}) });
  } catch (e) { mx2 = 'ERR ' + e.message; }
  ok('a new matrix suggests criteria and waits for options', mx2.includes('placeholder="Uses my skills"') && mx2.includes('scoring grid appears'), mx2.startsWith('ERR') ? mx2.slice(0, 200) : undefined);

  const prop = ws.WORKSHEETS.fl_proposal;
  let pr = '';
  try { pr = render('workspace/doc.ejs', { def: prop, kind: 'fl_proposal', doc: { id: 'd2', title: 'Bakery site', updated_at: now.toISOString() }, data: { price: 1200 }, progress: ws.progress(prop, { price: 1200 }), score: null, pitch: null, saved: false, matrix: null }); } catch (e) { pr = 'ERR ' + e.message; }
  ok('a path worksheet renders like any other', pr.includes('Payment terms') && pr.includes('value="1200"'), pr.startsWith('ERR') ? pr.slice(0, 200) : undefined);

  let hub = '';
  try {
    hub = render('workspace/index.ejs', { tools: dash.workspaceFor('software'), recent: {}, notReady: false, pathDef: paths.get('software'), needsSetup: false, msg: null, pathItems: items });
  } catch (e) { hub = 'ERR ' + e.message; }
  ok('the workspace hub links the path\'s boards and logs', hub.includes('/workspace/boards/sw_roadmap') && hub.includes('/workspace/metrics/sw_waitlist') && hub.includes('/workspace/checklists/sw_launch') && hub.includes('MVP scope'), hub.startsWith('ERR') ? hub.slice(0, 200) : undefined);

  const qdef = ws.WORKSHEETS.loc_quote;
  const qdata = { hours: 3, rate: 45, materials: 100 };
  let qh = '';
  try { qh = render('workspace/doc.ejs', { def: qdef, kind: 'loc_quote', doc: { id: 'd3', title: 'Fence', updated_at: now.toISOString() }, data: qdata, progress: ws.progress(qdef, qdata), score: null, pitch: null, saved: false, matrix: null, summary: ws.summaryOf(qdef, qdata) }); } catch (e) { qh = 'ERR ' + e.message; }
  ok('a worksheet page shows its worked-out total', qh.includes('Quote total') && qh.includes('$235'), qh.startsWith('ERR') ? qh.slice(0, 200) : undefined);

  const pp = await dash.panelFor(fakeSb({ checklist_progress: [{ item: 'problem', done_at: '2026-11-01T00:00:00Z' }] }), 'me', { path: 'physical_product', subpath: 'outdoor', path_answers: { stage: 'Prototype made' } }, now);
  ok('a product in development: no number yet, and no checklist pushed onto the dashboard', pp.north === null && !('northChecklist' in pp) && pp.boards.length === 0);
  let ph = '';
  try { ph = render('partials/path_panel.ejs', { panel: pp, pathInfo: { label: 'Physical product', emoji: '🔧' } }); } catch (e) { ph = 'ERR ' + e.message; }
  ok('...and renders without it', !ph.startsWith('ERR') && !ph.includes('Development gates') && ph.includes('Checklist templates are in'), ph.startsWith('ERR') ? ph.slice(0, 200) : undefined);

  const bm = await dash.panelFor(fakeSb({ pipeline_items: [{ stage: 'approved', value: 40000 }, { stage: 'drawn', value: 25000 }] }), 'me', { path: 'brick_mortar', subpath: 'food', path_answers: { stage: 'Looking at premises' } }, now);
  ok('brick and mortar while looking: funding is the number, the site scout a board', bm.northBoard && bm.northBoard.def.key === 'bm_funding' && bm.boards.map(b => b.def.key).join() === 'bm_sites');
  let bh = '';
  try { bh = render('partials/path_panel.ejs', { panel: bm, pathInfo: { label: 'Brick and mortar', emoji: '🏪' } }); } catch (e) { bh = 'ERR ' + e.message; }
  ok('...and renders it', bh.includes('Funding') && bh.includes('Site scout') && !bh.includes('Food and drink'), bh.startsWith('ERR') ? bh.slice(0, 200) : undefined);

  const dashView = read('views/dashboard/sections/path.ejs');
  ok('the dashboard shows the panel', dashView.includes("include('../../partials/path_panel'"));
  ok('the dashboard route loads it', read('src/routes/dashboard.js').includes('dashboards.panelFor('));
}

panels().then(() => {
  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
