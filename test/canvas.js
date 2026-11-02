// The canvas editor: formatted text, the read-only view and PDF, and sharing.
//
//  - formatted text is cleaned on save and again on display: no scripts,
//    links, images, event handlers or layout-breaking styles survive;
//  - older canvases (lists, plain text) still show, as bullets and paragraphs;
//  - the editor is two columns, one on phones; the view is the classic poster;
//  - sharing goes through the database functions only, degrades to "being set
//    up" before the migration, and the emailed link works signed out.
//
// The database rules are tested against a real Postgres in
// test/db/workspace_shares.sql (npm run test:db).
//
//   node test/canvas.js

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

const rt = require('../src/workspace/richtext');
const ws = require('../src/workspace/worksheets');
const { FLAGS } = require('../src/features');

const ME = '00000000-0000-0000-0000-0000000000aa';
const DOC = '30000000-0000-0000-0000-000000000001';
const SID = '40000000-0000-0000-0000-000000000001';
const TOKEN = 'ab'.repeat(32);

function fakeSb(tables = {}, rpcs = {}) {
  const calls = [];
  const from = table => {
    const state = { table, op: 'select', payload: null, filters: [] };
    calls.push(state);
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = tables[table];
          let out = typeof a === 'function' ? a(state) : (a || { data: [], error: null });
          if (state.single && Array.isArray(out.data)) out = { data: out.data[0] || null, error: out.error };
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) return p => { state.op = k; state.payload = p; return chain; };
        if (k === 'maybeSingle' || k === 'single') return () => { state.single = true; return chain; };
        return (...args) => { state.filters.push([k].concat(args)); return chain; };
      }
    });
    return chain;
  };
  const rpc = (name, args) => {
    calls.push({ rpc: name, args });
    const a = rpcs[name];
    const out = typeof a === 'function' ? a(args) : (a || { data: null, error: null });
    const p = Promise.resolve(out);
    return p;
  };
  return { from, rpc, calls };
}

function run(router, method, url, { body = {}, sb, headers = {}, user = { id: ME } } = {}) {
  return new Promise(resolve => {
    const q = {};
    new URL('http://x' + url).searchParams.forEach((v, k) => { q[k] = v; });
    const req = {
      method, url, body, query: q, params: {}, sb, user, headers,
      get: h => headers[h] || headers[h.toLowerCase()],
      profile: { id: ME, username: 'bea', display_name: 'Bea' }
    };
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end() { resolve({ status: this.statusCode, ended: true }); },
      redirect(a, b) { resolve({ redirect: b || a, status: b ? a : 302 }); },
      render(view, data) { resolve({ view, data, status: this.statusCode, headers: this.headers }); },
      send(b) { resolve({ body: b, status: this.statusCode }); }
    };
    router.handle(req, res, e => resolve({ error: e || 'next' }));
  });
}

const NO_FN = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.share_candidates' } };
const CANVAS = { id: DOC, user_id: ME, kind: 'business_model_canvas', title: 'EnRoute Jobs', updated_at: '2026-11-02T10:00:00Z',
  data: { value: '<p><strong>Jobs</strong> on the way home</p>', segments: ['Drivers', 'Shift workers'], partners: 'Truck stops\nUnions' } };

(async () => {
  console.log('Formatted text is cleaned:');
  {
    const c = rt.clean;
    ok('bold, italic, underline, strike and lists are kept', c('<p><b>B</b> <i>I</i> <u>U</u> <strike>S</strike></p><ul><li>a</li></ul><ol><li>1</li></ol>') === '<p><strong>B</strong> <em>I</em> <u>U</u> <s>S</s></p><ul><li>a</li></ul><ol><li>1</li></ol>');
    ok('text colour and highlight are kept', c('<p><span style="color:#dc2626">red</span> <span style="background-color: rgb(254, 240, 138)">hl</span></p>').includes('color:#dc2626') && c('<span style="background-color: rgb(254, 240, 138)">hl</span>').includes('background-color:rgb(254, 240, 138)'));
    ok('older browsers\' <font color> becomes a coloured span', c('<font color="#2563eb">blue</font>') === '<span style="color:#2563eb">blue</span>');
    ok('scripts are dropped with their contents', !/script|alert/.test(c('<p>hi</p><script>alert(1)</script>')));
    ok('event handlers are dropped', !/onerror|onclick/i.test(c('<p onclick="x()">a</p><img src=x onerror=alert(1)>')));
    ok('links and images are dropped, words kept', c('<a href="javascript:alert(1)">click</a><img src="x">') === 'click');
    ok('layout styles are dropped, colour kept', c('<span style="position:fixed;top:0;color:#0f9f6e;background:url(x)">x</span>') === '<span style="color:#0f9f6e">x</span>');
    ok('a colour value cannot smuggle CSS', !/expression|url/i.test(c('<span style="color: expression(alert(1))">x</span><span style="color:url(x)">y</span>')));
    ok('classes and ids are dropped', !/class=|id=/.test(c('<p class="a" id="b">x</p>')));
    ok('empty boxes save as nothing', c('<p><br></p>') === '' && c('   ') === '' && c('<ul><li></li></ul>') === '');
    ok('a box too long keeps its words, not half a tag', /^<p>x{3000}<\/p>$/.test(c('<p><strong>' + 'x'.repeat(4000) + '</strong></p>')));
    ok('older list boxes show as bullets', c(['Drivers', '<b>Shift</b>']) === '<ul><li>Drivers</li><li>&lt;b&gt;Shift&lt;/b&gt;</li></ul>');
    ok('older plain text shows as paragraphs, escaped', c('One\n2 < 3 & 4') === '<p>One</p><p>2 &lt; 3 &amp; 4</p>', c('One\n2 < 3 & 4'));
    const saved = ws.clean(ws.WORKSHEETS.business_model_canvas, { value: '<p onclick="x">Hi <b>there</b></p><script>bad()</script>', segments: '' });
    ok('saving a canvas cleans every box', saved.value === '<p>Hi <strong>there</strong></p>' && saved.segments === undefined, JSON.stringify(saved));
  }

  console.log('\nThe canvases:');
  {
    const bmc = ws.WORKSHEETS.business_model_canvas, lean = ws.WORKSHEETS.lean_canvas;
    ok('every canvas box is formatted text', [bmc, lean].every(d => d.sections.every(s => s.type === 'rich')));
    for (const d of [bmc, lean]) {
      const keys = new Set(d.sections.map(s => s.key));
      const cells = d.poster.areas.map(r => r.trim().split(/\s+/));
      const named = new Set(cells.flat());
      ok(`${d.label}: the poster places every box, and only real boxes`, cells.every(r => r.length === d.poster.columns) && [...keys].every(k => named.has(k)) && [...named].every(k => keys.has(k)));
    }
    const css = read('views/workspace/doc.ejs');
    ok('the editor is two columns', /\.ws-canvas\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(css));
    ok('...and one column on phones', /@media \(max-width:\s*760px\)\s*\{[^}]*\.ws-canvas\s*\{[^}]*grid-template-columns:\s*1fr/.test(css));
    const js = read('public/js/richtext.js');
    ok('the toolbar has bold, lists, colour and highlight', ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList', 'foreColor', 'hiliteColor', 'indent', 'undo'].every(k => js.includes("'" + k + "'")));
    ok('pasting brings in plain text only', /paste[\s\S]{0,200}text\/plain/.test(js));
    ok('it works with Turbo page changes', js.includes("'turbo:load'"));
  }

  console.log('\nThe routes:');
  const router = require('../src/routes/workspace');
  const docRow = { workspace_docs: s => ({ data: s.op === 'select' ? [CANVAS] : null, error: null }) };
  {
    const sb = fakeSb(docRow, { can_share_docs: { data: true, error: null } });
    const r = await run(router, 'GET', `/docs/business_model_canvas/${DOC}`, { sb });
    ok('the editor knows whether sharing is open', r.view === 'workspace/doc' && r.data.canShare === true);
    const v = await run(router, 'GET', `/docs/business_model_canvas/${DOC}/view?pdf=1`, { sb });
    ok('the view renders the owner\'s canvas, ready to export', v.view === 'workspace/view' && v.data.mode === 'owner' && v.data.autoPdf === true);
    ok('...only the owner\'s own document is looked up', sb.calls.filter(c => c.table === 'workspace_docs').every(c => c.filters.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] === ME)));
    const a = await run(router, 'POST', `/docs/business_model_canvas/${DOC}`, { sb, body: { value: '<b>x</b>' }, headers: { 'X-Autosave': '1' } });
    ok('autosave answers 204 instead of redirecting', a.status === 204 && a.ended);
    const upd = sb.calls.find(c => c.op === 'update');
    ok('...and stores the cleaned HTML', upd && upd.payload.data.value === '<strong>x</strong>', upd && JSON.stringify(upd.payload.data));
    const before = await run(router, 'GET', `/docs/business_model_canvas/${DOC}`, { sb: fakeSb(docRow, { can_share_docs: NO_FN }) });
    ok('before the migration, Share simply does not show', before.data.canShare === false);
  }
  {
    const sb = fakeSb(Object.assign({}, docRow, { workspace_shares: { data: [], error: null }, profiles: { data: [], error: null } }), {
      share_candidates: { data: [{ user_id: 'u2', username: 'cal', display_name: 'Cal', cohort: 'Spring' }], error: null },
      can_share_docs: { data: true, error: null }
    });
    const r = await run(router, 'GET', `/docs/business_model_canvas/${DOC}/share`, { sb });
    ok('the share page lists cohort-mates by name', r.view === 'workspace/share' && r.data.allowed && r.data.candidates[0].display_name === 'Cal');
    const nr = await run(router, 'GET', `/docs/business_model_canvas/${DOC}/share`, { sb: fakeSb(Object.assign({}, docRow, { workspace_shares: { data: null, error: { code: '42P01', message: 'relation does not exist' } } }), { share_candidates: NO_FN }) });
    ok('...and says "being set up" before the migration', nr.view === 'workspace/share' && nr.data.notReady === true);

    const m = fakeSb({}, { doc_share_member: { data: SID, error: null } });
    const mr = await run(router, 'POST', `/docs/business_model_canvas/${DOC}/share/member`, { sb: m, body: { recipient: 'u2', note: 'Look' } });
    ok('sharing with a member goes through doc_share_member()', m.calls[0].rpc === 'doc_share_member' && m.calls[0].args.p_doc === DOC && m.calls[0].args.p_recipient === 'u2' && /msg=/.test(mr.redirect));
    const denied = await run(router, 'POST', `/docs/business_model_canvas/${DOC}/share/member`, { sb: fakeSb({}, { doc_share_member: { data: null, error: null } }), body: { recipient: 'x' } });
    ok('...and a refusal says so', /err=/.test(denied.redirect));
    ok('no route writes workspace_shares directly', !/from\('workspace_shares'\)\.(insert|update|upsert|delete)/.test(read('src/routes/workspace.js')));

    const bad = fakeSb({}, {});
    const br = await run(router, 'POST', `/docs/business_model_canvas/${DOC}/share/email`, { sb: bad, body: { email: 'not-an-email' } });
    ok('a bad address is refused before anything is called', /err=/.test(br.redirect) && bad.calls.length === 0);
    delete process.env.RESEND_API_KEY;
    const e = fakeSb({ workspace_docs: { data: [{ title: 'EnRoute Jobs' }], error: null } }, { doc_share_email: { data: TOKEN, error: null } });
    const er = await run(router, 'POST', `/docs/business_model_canvas/${DOC}/share/email`, { sb: e, body: { email: 'Mentor@Example.com' } });
    ok('an email share returns the link, even when email is off', /link=.*%2Fshared%2F/.test(er.redirect) && decodeURIComponent(er.redirect).includes('/shared/' + TOKEN), er.redirect);
    ok('...with the address lower-cased', e.calls[0].args.p_email === 'mentor@example.com');
    const rv = fakeSb({}, { doc_share_revoke: { data: true, error: null } });
    await run(router, 'POST', `/docs/business_model_canvas/${DOC}/share/${SID}/revoke`, { sb: rv });
    ok('turning a share off goes through doc_share_revoke()', rv.calls[0].rpc === 'doc_share_revoke' && rv.calls[0].args.p_share === SID);
  }
  {
    const shared = { share_id: SID, kind: 'business_model_canvas', title: 'EnRoute Jobs', data: CANVAS.data, updated_at: CANVAS.updated_at, owner: 'Bea', note: 'Thoughts?' };
    const sb = fakeSb({}, { shared_with_me: { data: [{ share_id: SID, kind: 'business_model_canvas', title: 'EnRoute Jobs', owner: 'Bea', shared_at: CANVAS.updated_at, updated_at: CANVAS.updated_at }], error: null }, shared_doc: { data: shared, error: null } });
    const l = await run(router, 'GET', '/shared', { sb });
    ok('"Shared with you" lists what was shared', l.view === 'workspace/shared' && l.data.items.length === 1);
    const o = await run(router, 'GET', '/shared/' + SID, { sb });
    ok('a shared canvas opens read-only, as a member', o.view === 'workspace/view' && o.data.mode === 'member' && o.data.ownerName === 'Bea');
    const g = await run(router, 'GET', '/shared/' + SID, { sb: fakeSb({}, { shared_doc: { data: null, error: null } }) });
    ok('...and a revoked one is gone', g.status === 404);

    const link = require('../src/routes/shared_link');
    const ls = fakeSb({}, { shared_doc_by_token: { data: shared, error: null } });
    const lr = await run(link, 'GET', '/' + TOKEN, { sb: ls, user: null });
    ok('the emailed link opens signed out', lr.view === 'workspace/view' && lr.data.mode === 'link' && ls.calls[0].args.p_token === TOKEN);
    ok('...is not indexed, and does not leak in referrers', lr.headers['x-robots-tag'] === 'noindex, nofollow' && lr.headers['referrer-policy'] === 'no-referrer');
    const junk = fakeSb({}, {});
    const jr = await run(link, 'GET', '/not-a-token', { sb: junk, user: null });
    ok('a malformed token never reaches the database', jr.status === 404 && junk.calls.length === 0);
    ok('the link route is mounted without sign-in', /app\.use\('\/shared', require\('\.\/src\/routes\/shared_link'\)\)/.test(read('server.js')));
  }

  console.log('\nThe pages render:');
  {
    const V = f => path.join(ROOT, 'views', f);
    const base = {
      title: 'T', user: { id: ME }, profile: { id: ME, username: 'bea' }, plan: 'paid', currentPath: '/workspace', canonicalUrl: 'x',
      unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
      isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [], msg: null, richHtml: rt.clean,
      affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
    };
    const render = (f, data) => { try { return ejs.render(read('views/' + f), Object.assign({}, base, data), { filename: V(f) }); } catch (e) { return 'ERR ' + e.message; } };
    const def = ws.WORKSHEETS.business_model_canvas;
    const evil = Object.assign({}, CANVAS.data, { channels: '<p>ok</p><img src=x onerror=alert(1)><script>alert(2)</script>' });
    const doc = render('workspace/doc.ejs', { def, kind: 'business_model_canvas', doc: CANVAS, data: evil, progress: ws.progress(def, evil), score: null, pitch: null, matrix: null, summary: null, saved: false, canShare: true });
    ok('the editor renders with a formatting area per box', !doc.startsWith('ERR') && (doc.match(/data-rt>/g) || []).length === 9);
    ok('...with View, PDF and Share', doc.includes(`/workspace/docs/business_model_canvas/${DOC}/view`) && doc.includes('view?pdf=1') && doc.includes('/share"'));
    ok('...and stored HTML is escaped inside the editor\'s textarea', !/<img src=x|<script>alert|onerror=alert/.test(doc.split('<textarea').slice(1).join('')));
    const noShare = render('workspace/doc.ejs', { def, kind: 'business_model_canvas', doc: CANVAS, data: {}, progress: ws.progress(def, {}), score: null, pitch: null, matrix: null, summary: null, saved: false, canShare: false });
    ok('...and no Share button outside a cohort', !noShare.includes('/share"'));
    const view = render('workspace/view.ejs', { def, kind: 'business_model_canvas', doc: CANVAS, data: evil, mode: 'owner', ownerName: 'Bea', canShare: true });
    ok('the view renders as a poster', !view.startsWith('ERR') && view.includes('wv-poster') && view.includes('grid-template-areas: "partners partners activities activities value value'));
    ok('...formatted text shows formatted', view.includes('<strong>Jobs</strong> on the way home'));
    ok('...older list boxes show as bullets', view.includes('<li>Drivers</li>'));
    ok('...and nothing dangerous gets through', !/<img src=x|<script>alert|onerror/.test(view));
    ok('...prints landscape', /size: A4 landscape/.test(view));
    const link = render('workspace/view.ejs', { def, kind: 'business_model_canvas', doc: CANVAS, data: CANVAS.data, mode: 'link', ownerName: 'Bea', note: 'Thoughts?', canShare: false });
    ok('the emailed view shows who shared it and their note, and no edit links', link.includes('Shared with you by Bea') && link.includes('Thoughts?') && !link.includes('/workspace/docs/'));
    const plan = ws.WORKSHEETS.business_plan;
    const pv = render('workspace/view.ejs', { def: plan, kind: 'business_plan', doc: { id: 'p', title: 'Plan', updated_at: CANVAS.updated_at }, data: { summary: 'A <b>plan</b>', startup: 1200 }, mode: 'owner', ownerName: 'Bea', canShare: false });
    ok('other worksheets view as a document, escaped', !pv.startsWith('ERR') && pv.includes('wv-doc') && pv.includes('A &lt;b&gt;plan&lt;/b&gt;') && /size: A4 portrait/.test(pv));
    const share = render('workspace/share.ejs', { def, kind: 'business_model_canvas', doc: CANVAS, notReady: false, allowed: true, nameOf: p => p ? p.display_name || p.username : 'A member',
      candidates: [{ user_id: 'u2', username: 'cal', display_name: 'Cal', cohort: 'Spring' }],
      shares: [{ id: SID, recipient_id: null, email: 'mentor@example.com', created_at: CANVAS.updated_at, expires_at: '2026-12-02T00:00:00Z', last_viewed_at: null }], link: 'https://nobossly.com/shared/' + TOKEN });
    ok('the share page offers a name picker and email', !share.startsWith('ERR') && share.includes('name="recipient"') && share.includes('Cal (@cal)') && share.includes('name="email"'));
    ok('...lists who has it, with a way to turn it off', share.includes('mentor@example.com') && share.includes('/revoke"'));
    const shut = render('workspace/share.ejs', { def, kind: 'business_model_canvas', doc: CANVAS, notReady: false, allowed: false, candidates: [], shares: [], link: null, nameOf: () => '' });
    ok('...and outside a cohort, explains instead', shut.includes('Sharing is for members of an accelerator'));
    const sh = render('workspace/shared.ejs', { notReady: false, items: [{ share_id: SID, kind: 'business_model_canvas', title: 'EnRoute Jobs', owner: 'Bea', updated_at: CANVAS.updated_at, def }] });
    ok('"Shared with you" renders', !sh.startsWith('ERR') && sh.includes('/workspace/shared/' + SID));
    ok('the workspace hub links to it', read('views/workspace/index.ejs').includes('/workspace/shared'));
    ok('a cohort submission shows formatted canvas text', read('views/groups/submission.ejs').includes("sec.type === 'rich'") && /app\.locals\.richHtml/.test(read('server.js')));
  }

  console.log('\nThe email:');
  {
    process.env.RESEND_API_KEY = 'test';
    let sent = null;
    const realFetch = global.fetch;
    global.fetch = async (url, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ id: 'r1' }) }; };
    const mailer = require('../src/mailer');
    await mailer.send('doc_share', 'mentor@example.com', null, { sb: { from: () => ({ insert: async () => ({}) }) }, template: { from: 'Bea <b>', title: 'EnRoute', label: 'business model canvas', note: '<script>x</script>', link: 'https://nobossly.com/shared/' + TOKEN } });
    global.fetch = realFetch; delete process.env.RESEND_API_KEY;
    ok('the share email carries the link', sent && sent.html.includes('/shared/' + TOKEN) && /Bea <b> shared "EnRoute"/.test(sent.subject), sent && sent.subject);
    ok('...escapes what the member typed', sent && !sent.html.includes('<script>x') && sent.html.includes('Bea &lt;b&gt;'));
    ok('...and says why it arrived, not "you started an account"', sent && !sent.html.includes('you started a NoBossly account'));
    const m = read('src/mailer.js');
    ok('the other emails no longer mention quests, rungs or streaks', !/\bquests?\b|\brungs?\b|\bstreaks?\b/i.test(m.slice(m.indexOf('const TEMPLATES'), m.indexOf('doc_share:'))));
    ok('notifications for a share link to it', require('fs').readFileSync(path.join(ROOT, 'src/routes/notifications.js'), 'utf8').includes("workspace_shares: id => '/workspace/shared/' + id"));
  }

  console.log('\nThe migration (written for review):');
  {
    const sql = read('migrations/2026-11-02_workspace_shares.sql');
    ok('it is written for review', /^-- NOT APPLIED/.test(sql));
    const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
    const open = fns.filter(f => !new RegExp(`revoke all on function public\\.${f}\\([^)]*\\)\\s+from public`).test(sql));
    ok('every function has its default access revoked', open.length === 0, open.join(', ') || fns.length + ' functions');
    ok('only the link lookup is open to anon', /grant execute on function public\.shared_doc_by_token\(text\)\s+to anon, authenticated/.test(sql) && (sql.match(/to anon/g) || []).length === 1);
    ok('shares are only written through the functions', /revoke insert, update, delete on public\.workspace_shares from authenticated/.test(sql) && /revoke all on public\.workspace_shares from anon/.test(sql));
    ok('email shares expire and are capped per day', /interval '30 days'/.test(sql) && /n >= 20/.test(sql));
    ok('the database tests cover outsiders and anon', /outsider cannot open the share by id/.test(read('test/db/workspace_shares.sql')) && /workspace_shares/.test(read('test/db/run.sh')));
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
