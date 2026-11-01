// Path dashboards, step 1: the workspace and path setup.
//
//  - Every path has setup questions that really exist, and a ranking of the
//    shared tools; nothing is fenced off (every tool reachable from any path).
//  - The six worksheets save only what they define, score and time honestly.
//  - Setup keeps the subpath and answers; switching path clears the old ones.
//  - Pages work before the migration lands, and render with real data after.
//
//   node test/workspace.js

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
const { FLAGS } = require('../src/features');

function run(router, method, url, { body = {}, query = {}, sb, profile } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user: { id: 'me' },
      profile: Object.assign({ id: 'me', username: 'me', display_name: 'Me', onboarding_completed: true }, profile || {}) };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      redirect(to) { resolve({ redirect: to, status: this.statusCode }); },
      render(view, data) { resolve({ view, data, status: this.statusCode }); }
    };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}
function fakeSb(answers = {}) {
  const writes = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          const out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) {
          return (p) => { state.op = k; state.payload = p; writes.push({ table, op: k, payload: p }); return chain; };
        }
        return () => chain;
      }
    });
    return chain;
  };
  return { from: q, rpc: () => Promise.resolve({ data: null, error: null }), writes };
}

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nEvery path is configured, and nothing is fenced off:');
  const slugs = paths.PATHS.map(p => p.slug).filter(s => s !== 'default');
  ok('every path has a dashboard config', slugs.every(s => dash.PATHS[s]), slugs.filter(s => !dash.PATHS[s]).join(', ') || slugs.length + ' paths');
  const broken = slugs.filter(s => dash.setupQuestions(s).length !== dash.PATHS[s].setup.length);
  ok('every setup question exists in that path\'s questions', broken.length === 0, broken.join(', ') || 'all resolve');
  ok('setup is short — four questions at most, plus the subpath', slugs.every(s => dash.PATHS[s].setup.length <= 4));
  const unknown = slugs.flatMap(s => dash.PATHS[s].featured.concat(dash.PATHS[s].available).filter(k => !dash.TOOLS[k]).map(k => s + ':' + k));
  ok('every featured or listed tool exists', unknown.length === 0, unknown.join(', ') || 'clean');
  const fenced = slugs.filter(s => { const w = dash.workspaceFor(s); return w.featured.length + w.available.length + w.library.length !== Object.keys(dash.TOOLS).length; });
  ok('every tool is reachable from every path (featured, listed, or in the library)', fenced.length === 0, fenced.join(', ') || 'clean');
  ok('paths really differ: no two paths feature the same tools in the same order',
     new Set(slugs.map(s => dash.PATHS[s].featured.join(','))).size === slugs.length);
  ok('a café leads with the business plan; a creator does not feature it',
     dash.PATHS.brick_mortar.featured[0] === 'business_plan' && !dash.PATHS.creator.featured.includes('business_plan'));
  ok('the software path is called Apps & Software', paths.get('software').label === 'Apps & Software');
  ok('worksheet tools point at a defined worksheet', Object.entries(dash.TOOLS).filter(([, t]) => t.kind).every(([k, t]) => ws.WORKSHEETS[k] && t.href === '/workspace/docs/' + k));

  ok('needs setup: a creator with no subpath yet', dash.needsSetup({ path: 'creator', subpath: null }));
  ok('...not once the subpath and answers are in', !dash.needsSetup({ path: 'creator', subpath: 'youtube', path_answers: { stage: 'Posting occasionally' } }));
  ok('...and nobody without a path is asked', !dash.needsSetup({ path: null }));

  // -------------------------------------------------------------------------
  console.log('\nThe worksheets:');
  const lean = ws.WORKSHEETS.lean_canvas;
  const d = ws.clean(lean, { problem: 'Too slow\n\n  Too costly  \n', uvp: 'x'.repeat(5000), invented: 'nope' });
  ok('lists split by line and drop blanks', JSON.stringify(d.problem) === JSON.stringify(['Too slow', 'Too costly']));
  ok('long text is capped', d.uvp.length === 3000);
  ok('fields a worksheet does not define are dropped', d.invented === undefined);
  ok('a Lean Canvas has its 11 boxes; the Business Model Canvas its 9', lean.sections.length === 11 && ws.WORKSHEETS.business_model_canvas.sections.length === 9);
  const plan = ws.clean(ws.WORKSHEETS.business_plan, { startup: '$12,500.505', monthly: 'lots' });
  ok('money parses "$12,500.50" and rejects words', plan.startup === 12500.51 && plan.monthly === undefined, JSON.stringify(plan));
  const idea = ws.clean(ws.WORKSHEETS.idea_refiner, { s_pain: '5', s_reach: '2', s_deliver: '9', s_pay: '4', s_fit: '3', verdict: 'Keep going' });
  ok('scores outside 1–5 are dropped', idea.s_deliver === undefined && idea.s_pain === 5);
  const sc = ws.ideaScore(idea);
  ok('the idea score totals what is scored and names the weakest', sc.total === 14 && sc.of === 20 && /reach/i.test(sc.weakest) && !sc.complete, JSON.stringify(sc));
  ok('a pitch of 75 words is about 30 seconds', ws.pitchStats(Array(75).fill('word').join(' ')).seconds === 30);
  ok('progress counts filled sections', ws.progress(lean, d).done === 2 && ws.progress(lean, d).total === 11);

  // -------------------------------------------------------------------------
  console.log('\nPath setup:');
  const choose = require('../src/routes/choose_path');
  {
    const sb = fakeSb();
    const r = await run(choose, 'POST', '/setup', { sb, profile: { path: 'freelancer', path_answers: {} },
      body: { subpath: 'design', stage: 'Some regular clients', service: 'Brand identity for cafés', client_source: ['Referrals', 'Invented'], pricing_model: 'Not an option' } });
    const w = sb.writes.find(x => x.table === 'profiles');
    ok('the subpath and answers are saved', !!w && w.payload.subpath === 'design' && w.payload.path_answers.service === 'Brand identity for cafés', JSON.stringify(w && w.payload));
    ok('...cleaned to the options each question allows', w && JSON.stringify(w.payload.path_answers.client_source) === '["Referrals"]' && w.payload.path_answers.pricing_model === undefined);
    ok('...then on to the dashboard', /^\/dashboard/.test(r.redirect || ''));
  }
  {
    const sb = fakeSb();
    await run(choose, 'POST', '/setup', { sb, profile: { path: 'creator' }, body: { subpath: 'podcast', stage: 'Posting occasionally' } });
    const w = sb.writes.find(x => x.table === 'profiles');
    ok('before the migration, only the subpath is written (no missing column)', !!w && w.payload.subpath === 'podcast' && !('path_answers' in w.payload));
  }
  {
    const sb = fakeSb();
    const r = await run(choose, 'POST', '/setup', { sb, profile: { path: 'freelancer', path_answers: {} }, body: { service: 'Call me on 555 123 4567' } });
    ok('contact details in an answer are refused', /err=/.test(r.redirect || '') && !sb.writes.some(x => x.table === 'profiles'));
  }
  {
    const sb = fakeSb();
    const r = await run(choose, 'POST', '/', { sb, profile: { path: 'creator', subpath: 'youtube', path_answers: { stage: 'x' } }, body: { path: 'local_service' } });
    const w = sb.writes.find(x => x.table === 'profiles');
    ok('switching path clears the old subpath and answers', !!w && w.payload.subpath === null && JSON.stringify(w.payload.path_answers) === '{}');
    ok('...and goes to setup for the new path', r.redirect === '/choose-path/setup');
  }

  // -------------------------------------------------------------------------
  console.log('\nThe workspace pages:');
  const wr = require('../src/routes/workspace');
  {
    const sb = fakeSb({ workspace_docs: { data: null, error: { code: '42P01', message: 'relation "public.workspace_docs" does not exist' } } });
    const r = await run(wr, 'GET', '/', { sb, profile: { path: 'software' } });
    ok('before the migration the hub still opens, saying it is being set up', r.view === 'workspace/index' && r.data.notReady === true);
    ok('...ordered for the path (Apps & Software leads with the Lean Canvas)', r.data.tools.featured[0].key === 'lean_canvas');
  }
  {
    const r = await run(wr, 'GET', '/docs/not_a_tool', { sb: fakeSb() });
    ok('an unknown worksheet is a 404', r.status === 404);
  }
  {
    const sb = fakeSb({ workspace_docs: s => (s.op === 'select' ? { data: { data: { pitch: 'We help nurses eat well.', versions: [] } }, error: null } : { data: null, error: null }) });
    await run(wr, 'POST', '/docs/elevator_pitch/abc', { sb, body: { title: 'Networking', pitch: 'We help night-shift nurses eat well without cooking.' } });
    const w = sb.writes.find(x => x.op === 'update');
    ok('saving a new pitch keeps the old wording as a version', !!w && w.payload.data.versions[0].text === 'We help nurses eat well.' && w.payload.data.pitch.startsWith('We help night-shift'));
  }
  {
    const sb = fakeSb();
    const r = await run(wr, 'POST', '/goals', { sb, body: { title: '', why: 'x' } });
    ok('a goal needs a name', /err=/.test(r.redirect || '') && !sb.writes.length);
    const sb2 = fakeSb();
    await run(wr, 'POST', '/goals', { sb: sb2, body: { title: 'Three paying clients', target: '2027-02-01', status: 'nonsense' } });
    const w = sb2.writes.find(x => x.table === 'workspace_docs');
    ok('a goal is a workspace doc of kind goal, with a known status', !!w && w.payload.kind === 'goal' && w.payload.data.status === 'active' && w.payload.data.target === '2027-02-01');
  }

  // Render every page with real-looking data.
  const V = f => path.join(ROOT, 'views', f);
  const base = {
    title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me' }, plan: 'paid', currentPath: '/workspace', canonicalUrl: 'x',
    unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
    isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [],
    affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
  };
  const render = (f, data) => ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) });
  const now = new Date().toISOString();
  const pages = {
    'workspace/index.ejs': { tools: dash.workspaceFor('brick_mortar'), recent: { business_plan: [{ id: 'd1', updated_at: now }] }, notReady: false, pathDef: paths.get('brick_mortar'), needsSetup: true, msg: null },
    'workspace/doc_list.ejs': { def: ws.WORKSHEETS.idea_refiner, kind: 'idea_refiner', docs: [{ id: 'd1', title: 'Meal prep', data: idea, updated_at: now }], notReady: false, progress: ws.progress, ideaScore: ws.ideaScore, msg: null },
    'workspace/doc.ejs': { def: ws.WORKSHEETS.lean_canvas, kind: 'lean_canvas', doc: { id: 'd1', title: 'Night-shift meals', updated_at: now }, data: d, progress: ws.progress(lean, d), score: null, pitch: null, saved: true },
    'workspace/goals.ejs': { goals: [{ id: 'g1', title: 'Three clients', status: 'active', target: '2027-02-01', measure: '3 invoices paid' }], notReady: false, GOAL_STATUS: { active: 'Active', done: 'Done', dropped: 'Dropped' }, msg: null },
    'workspace/milestones.ejs': { milestones: [{ id: 'm1', title: 'First sale', emoji: '💵', achieved: true, date_achieved: '2026-10-30' }], msg: null },
    'choose_path_setup.ejs': { def: paths.get('consultant'), subpaths: paths.subpathsOf('consultant'), questions: dash.setupQuestions('consultant'), subpath: '', answers: {} }
  };
  for (const [f, data] of Object.entries(pages)) {
    let html = '';
    try { html = render(f, data); } catch (e) { ok(`${f} renders`, false, e.message.split('\n').pop()); continue; }
    ok(`${f} renders`, html.length > 500);
  }
  const pitchDoc = render('workspace/doc.ejs', { def: ws.WORKSHEETS.elevator_pitch, kind: 'elevator_pitch', doc: { id: 'p1', title: 'Lenders', updated_at: now },
    data: { pitch: 'Short pitch.', versions: [{ text: 'Older pitch.', saved_at: now }] }, progress: { done: 1, total: 7 }, score: null, pitch: ws.pitchStats('Short pitch.'), saved: false });
  ok('a pitch shows its timing and earlier versions', /about \d+ seconds out loud/.test(pitchDoc) && pitchDoc.includes('Older pitch.'));
  const setup = render('choose_path_setup.ejs', pages['choose_path_setup.ejs']);
  ok('setup asks the subpath and the path\'s own questions, and can be skipped',
     setup.includes('name="subpath"') && setup.includes('name="ticket_comfort"') && setup.includes('name="skip"'));

  // -------------------------------------------------------------------------
  console.log('\nThe migration (written for review):');
  {
    const sql = read('migrations/2026-11-01_workspace_foundations.sql');
    ok('it is marked NOT APPLIED', /^-- NOT APPLIED, written for review\./.test(sql));
    ok('every new table is owner-only and closed to anon',
       ['workspace_docs', 'pipeline_items', 'metric_entries', 'checklist_progress'].every(t =>
         new RegExp(`create policy ${t}_own on public\\.${t} for all to authenticated\\s+using \\(user_id = auth\\.uid\\(\\)\\) with check \\(user_id = auth\\.uid\\(\\)\\)`).test(sql)) && /revoke all on public\.workspace_docs, public\.pipeline_items, public\.metric_entries, public\.checklist_progress from anon;/.test(sql));
    ok('surveys stop being readable by everyone', /create policy surveys_select on public\.surveys for select to authenticated\s+using \(creator_id = auth\.uid\(\) or public\.is_admin\(\)\)/.test(sql));
    ok('responses only arrive through survey_submit()', /revoke insert, update, delete on public\.survey_responses from anon, authenticated;/.test(sql));
  }

  console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
  process.exit(fail ? 1 : 0);
})();
