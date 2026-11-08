// The workspace hub (src/workspace_hub.js, views/workspace/index.ejs):
// blank notes, Jump back in, one search box, tiles that say what is in them,
// and pinning / hiding tools.
//
//   node test/workspace_hub.js        (HUB_OUT=dir also writes the pages as HTML)

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

const dash = require('../src/path_dashboards');
const ws = require('../src/workspace/worksheets');
const hub = require('../src/workspace_hub');
const paths = require('../src/paths');
const { FLAGS } = require('../src/features');

function run(router, method, url, { body = {}, query = {}, sb, profile } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user: { id: 'me' }, get: () => '',
      profile: Object.assign({ id: 'me', username: 'me', display_name: 'Me', onboarding_completed: true }, profile || {}) };
    const res = {
      statusCode: 200, locals: {},
      status(c) { this.statusCode = c; return this; },
      redirect(to) { resolve({ redirect: to, status: this.statusCode }); },
      render(view, data) { resolve({ view, data, status: this.statusCode }); }
    };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}

// A fake client: answers[table] is { data } or a function of the query state
// (which records ilike filters, so a search can be checked).
function fakeSb(answers = {}) {
  const writes = [];
  const q = (table) => {
    const state = { table, op: 'select', payload: null, ilike: null };
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = answers[table];
          const out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (k === 'maybeSingle') return () => chain;
        if (k === 'ilike') return (col, v) => { state.ilike = v; return chain; };
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
  const now = new Date('2026-11-08T15:00:00Z');
  const wr = require('../src/routes/workspace');

  console.log('Notes:');
  const notes = ws.WORKSHEETS.notes;
  ok('notes are a worksheet with one long formatted body, saved as you type', notes && notes.sections.length === 1 && notes.sections[0].type === 'rich' && notes.sections[0].long && notes.autosave);
  const long = '<p>' + 'word '.repeat(2000) + '</p>';
  const saved = ws.clean(notes, { body: long + '<script>x</script><p><strong>Bold</strong></p>' });
  ok('a note keeps up to 20,000 characters, formatting and all, and drops scripts', saved.body.includes('<strong>Bold</strong>') && !saved.body.includes('script') && saved.body.length > 10000);
  ok('...where a canvas box still stops at 3,000', ws.clean(ws.WORKSHEETS.lean_canvas, { problem: long }).problem.length < 3100);
  ok('every path offers Notes', paths.PATHS.every(p => { const w = dash.workspaceFor(p.slug); return w.featured.concat(w.available).some(t => t.key === 'notes'); }));
  {
    const sb = fakeSb({ workspace_docs: { data: { id: 'n1' }, error: null } });
    const r = await run(wr, 'POST', '/docs/notes', { sb, body: { title: '' } });
    const w = sb.writes.find(x => x.op === 'insert');
    ok('a new note with no title is "Untitled note"', !!w && w.payload.title === 'Untitled note' && r.redirect === '/workspace/docs/notes/n1');
  }
  const V = f => path.join(ROOT, 'views', f);
  const base = {
    title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me', display_name: 'Dana' }, plan: 'paid', currentPath: '/workspace', canonicalUrl: 'x',
    unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: 'theme-light', settings: {}, pendingDeletion: null, reactivated: false,
    isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null,
    affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
  };
  const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
  const nd = { body: '<p>Call with <strong>Bloom</strong>: they want the logo by Friday.</p>' };
  const noteHtml = render('workspace/doc.ejs', { def: notes, kind: 'notes', doc: { id: 'n1', title: 'Bloom call', updated_at: now.toISOString() }, data: nd, progress: ws.progress(notes, nd), score: null, pitch: null, saved: false, matrix: null, summary: [] });
  ok('the note page is a big editor that saves itself', !noteHtml.startsWith('ERR') && noteHtml.includes('data-autosave') && noteHtml.includes('rt-long') && noteHtml.includes('Saves automatically'), noteHtml.startsWith('ERR') ? noteHtml.slice(0, 200) : undefined);
  const listHtml = render('workspace/doc_list.ejs', { def: notes, kind: 'notes', docs: [{ id: 'n1', title: 'Bloom call', data: nd, updated_at: now.toISOString() }], notReady: false, progress: ws.progress, ideaScore: ws.ideaScore, textOf: require('../src/workspace/richtext').textOf });
  ok('the notes list shows the start of each note, not "1 of 1 filled in"', listHtml.includes('Call with Bloom: they want the logo') && !listHtml.includes('filled in'));

  console.log('\nTiles, pins and hiding:');
  const profile = { path: 'freelancer', subpath: 'design', path_answers: { stage: 'Some regular clients' } };
  const tiles = hub.tilesOf(dash.workspaceFor('freelancer'), dash.pathItemsFor(profile));
  ok('every tool, board, number log and checklist is a tile with a unique id', tiles.length > 10 && new Set(tiles.map(t => t.id)).size === tiles.length && ['tool:notes', 'board:fl_clients'].every(id => tiles.some(t => t.id === id)));
  let st = hub.apply(null, { action: 'pin', id: 'board:fl_clients' }, tiles);
  st = hub.apply(st, { action: 'pin', id: 'tool:notes' }, tiles);
  st = hub.apply(st, { action: 'left', id: 'tool:notes' }, tiles);
  st = hub.apply(st, { action: 'hide', id: 'tool:milestones' }, tiles);
  const A = hub.arrange(tiles, st);
  ok('pins come first, in the order set', A.pinned.map(t => t.id).join() === 'tool:notes,board:fl_clients');
  ok('a pinned tile is not shown twice', !Object.values(A.groups).flat().some(t => t.id === 'tool:notes' || t.id === 'board:fl_clients'));
  ok('hidden tiles go to the Hidden list', A.hidden.map(t => t.id).join() === 'tool:milestones' && !Object.values(A.groups).flat().some(t => t.id === 'tool:milestones'));
  ok('pinning a hidden tile brings it back', hub.clean(hub.apply(st, { action: 'pin', id: 'tool:milestones' }, tiles)).hidden.length === 0);
  ok('a tile this member does not have, or junk, is refused', hub.apply(st, { action: 'pin', id: 'board:sw_roadmap' }, tiles) === undefined && hub.apply(st, { action: 'pin', id: 'x' }, tiles) === undefined && hub.apply(st, { action: 'explode', id: 'tool:notes' }, tiles) === undefined);
  let many = null;
  tiles.slice(0, hub.MAX_PINS).forEach(t => { many = hub.apply(many, { action: 'pin', id: t.id }, tiles); });
  ok('up to ' + hub.MAX_PINS + ' pins', hub.apply(many, { action: 'pin', id: tiles[hub.MAX_PINS].id }, tiles) === undefined && hub.arrange(tiles, many).full);
  ok('pins of another path\'s tools are kept but not shown', hub.arrange(tiles, { pinned: ['board:sw_roadmap', 'tool:notes'] }).pinned.map(t => t.id).join() === 'tool:notes');

  console.log('\nWhat each tile says:');
  const docs = [
    { id: 'n1', kind: 'notes', title: 'Bloom call', updated_at: '2026-11-07T10:00:00Z' },
    { id: 'n2', kind: 'notes', title: 'Ideas', updated_at: '2026-11-01T10:00:00Z' },
    { id: 'p1', kind: 'fl_proposal', title: 'Bakery site', updated_at: '2026-11-06T10:00:00Z' }
  ];
  const sb = fakeSb({
    pipeline_items: s => ({ data: [{ id: 'c1', board: 'fl_clients', stage: 'lead', value: 500, title: 'Acme rebrand', updated_at: '2026-11-08T09:00:00Z' }, { id: 'c2', board: 'fl_clients', stage: 'paid', value: 1200, title: 'Jo', updated_at: '2026-10-01T09:00:00Z' }], error: null }),
    metric_entries: { data: [{ id: 'e2', metric: 'fl_hours', period: '2026-10-26', value: 28 }, { id: 'e1', metric: 'fl_hours', period: '2026-11-02', value: 32 }], error: null },
    revenue_entries: { data: [], error: null },
    workspace_docs: { data: docs, error: null }
  });
  const live = await hub.liveOf(sb, 'me', tiles, docs, now);
  ok('a doc tile counts what is saved', live['tool:notes'] && live['tool:notes'].text === '2 saved · Nov 7', JSON.stringify(live['tool:notes']));
  ok('a board tile counts open and done cards', live['board:fl_clients'] && /^1 open · 1 done/.test(live['board:fl_clients'].text), JSON.stringify(live['board:fl_clients']));
  const hrs = live['metric:fl_hours'];
  ok('a number tile shows the latest and the change', !!hrs && /^32 · /.test(hrs.text) && hrs.change === '▲ +4' && hrs.good === true, JSON.stringify(hrs));
  const recent = await hub.recent(sb, 'me', docs);
  ok('Jump back in mixes docs and cards, newest first', recent.map(r => r.title).slice(0, 3).join(' | ') === 'Acme rebrand | Bloom call | Bakery site', recent.map(r => r.title).join(' | '));
  ok('...each linked to where it lives', recent[0].href === '/workspace/boards/fl_clients/c1' && recent[1].href === '/workspace/docs/notes/n1');

  console.log('\nSearch:');
  const searchSb = fakeSb({
    workspace_docs: { data: [
      { id: 'n1', kind: 'notes', title: 'Bloom call', data: nd, updated_at: '2026-11-07T10:00:00Z' },
      { id: 'p1', kind: 'persona', title: 'Small bakeries', data: { goals: 'Wants a logo that works on a box', frustrations: ['Agencies too slow'] }, updated_at: '2026-11-06T10:00:00Z' },
      { id: 'x1', kind: 'lean_canvas', title: 'Other', data: { problem: '<p>Nothing to see</p>' }, updated_at: '2026-11-05T10:00:00Z' }
    ], error: null },
    pipeline_items: s => ({ data: s.ilike === '%logo%' ? [{ id: 'c9', board: 'fl_clients', title: 'Logo refresh for Jo', updated_at: '2026-11-02T00:00:00Z' }] : [], error: null }),
    tasks: s => ({ data: s.ilike === '%logo%' ? [{ id: 't1', title: 'Send logo drafts', status: 'todo', due_date: '2026-11-10' }] : [], error: null })
  });
  const found = await hub.search(searchSb, 'me', '  logo ');
  ok('finds the word inside notes and worksheets, cards and tasks', found.results.map(r => r.title).sort().join(' | ') === 'Bloom call | Logo refresh for Jo | Send logo drafts | Small bakeries', found.results.map(r => r.title).join(' | '));
  ok('...with the words around it', found.results.find(r => r.title === 'Bloom call').snippet.includes('want the logo by Friday'));
  ok('...and not the docs without it', !found.results.some(r => r.title === 'Other'));
  ok('% and _ are searched as letters, not wildcards', await (async () => { let seen = null; await hub.search(fakeSb({ pipeline_items: s => { seen = s.ilike; return { data: [] }; } }), 'me', '50%_off'); return seen === '%50\\%\\_off%'; })());
  ok('one letter is not a search', (await hub.search(searchSb, 'me', 'a')).tooShort);
  {
    const r = await run(wr, 'GET', '/search', { sb: searchSb, query: { q: 'logo' } });
    const html = render('workspace/search.ejs', r.data);
    ok('the search page lists them', r.view === 'workspace/search' && html.includes('Logo refresh for Jo') && html.includes('href="/workspace/docs/notes/n1"') && html.includes('4 results'), html.startsWith('ERR') ? html.slice(0, 200) : undefined);
  }

  console.log('\nThe hub, and saving pins:');
  {
    const r = await run(wr, 'GET', '/', { sb, profile: Object.assign({ workspace_layout: { pinned: ['tool:notes'], hidden: ['tool:milestones'] } }, profile) });
    ok('the hub gets tiles, what they say, and what you touched last', r.view === 'workspace/index' && r.data.hub.pinned[0].id === 'tool:notes' && r.data.canArrange && Array.isArray(r.data.recent));
    const html = render('workspace/index.ejs', Object.assign({ pathDef: paths.get('freelancer'), needsSetup: false }, r.data));
    ok('it renders: search, Jump back in, Pinned, Hidden', !html.startsWith('ERR') && ['action="/workspace/search"', 'Jump back in', '📌 Pinned', '<strong>Hidden</strong>', 'value="unpin"', 'value="show"'].every(x => html.includes(x)), html.startsWith('ERR') ? html.slice(0, 300) : ['Jump back in', '📌 Pinned', 'Hidden'].map(x => html.includes(x)).join());
    ok('tiles show what is in them instead of the blurb', html.includes('1 open · 1 done') && html.includes('2 saved · Nov 7'));
    if (process.env.HUB_OUT) fs.writeFileSync(path.join(process.env.HUB_OUT, 'hub.html'), html.replace(/href="\/css\/style\.css\?v=\d+"/, 'href="' + path.join(ROOT, 'public/css/style.css') + '"'));
    if (process.env.HUB_OUT) {
      const s2 = render('workspace/search.ejs', (await run(wr, 'GET', '/search', { sb: searchSb, query: { q: 'logo' } })).data);
      fs.writeFileSync(path.join(process.env.HUB_OUT, 'search.html'), s2.replace(/href="\/css\/style\.css\?v=\d+"/, 'href="' + path.join(ROOT, 'public/css/style.css') + '"'));
    }
  }
  {
    const r = await run(wr, 'GET', '/', { sb, profile });
    const html = render('workspace/index.ejs', Object.assign({ pathDef: paths.get('freelancer'), needsSetup: false }, r.data));
    ok('before the migration there are no pin buttons', !r.data.canArrange && !html.includes('value="pin"'));
    const p = await run(wr, 'POST', '/layout', { sb: fakeSb(), profile, body: { action: 'pin', id: 'tool:notes' } });
    ok('...and pinning says it is being switched on', /being%20switched%20on/.test(p.redirect));
  }
  {
    const sb2 = fakeSb({ profiles: { data: null, error: null } });
    const r = await run(wr, 'POST', '/layout', { sb: sb2, profile: Object.assign({ workspace_layout: null }, profile), body: { action: 'pin', id: 'tool:notes' } });
    const w = sb2.writes.find(x => x.table === 'profiles');
    ok('pinning saves to the profile and comes back to the tile', !!w && w.payload.workspace_layout.pinned[0] === 'tool:notes' && r.redirect === '/workspace#t-tool-notes');
    const sb3 = fakeSb();
    await run(wr, 'POST', '/layout', { sb: sb3, profile: Object.assign({ workspace_layout: null }, profile), body: { action: 'pin', id: 'board:nope' } });
    ok('nonsense saves nothing', !sb3.writes.length);
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
