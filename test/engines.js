// The building blocks behind the path dashboards: boards (pipelines), metric
// logs and checklists, plus the generic pages that show them.
//
// A path config only *declares* "a client pipeline with these stages" or
// "followers, monthly"; everything else is here. So a bad declaration has to
// fail when it is made, a card has to come back typed the way its board says,
// a logged number has to land in the right period, and every page has to hold
// up — including before the migration that creates the tables is applied.
//
// The definitions below are fixtures for this test only; the real ones belong
// to the path configs.
//
//   node test/engines.js

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
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re ? re.test(e.message) : true; } };

const { FLAGS } = require('../src/features');
const registry = require('../src/engines/registry');
const pipeline = require('../src/engines/pipeline');
const metrics = require('../src/engines/metrics');
const checklists = require('../src/engines/checklists');
const fmt = require('../src/engines/format');

// A tiny stand-in for the Express request/response, enough to drive a route.
function run(router, method, url, { body = {}, query = {}, sb } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, body, query, params: {}, sb, user: { id: 'me' }, profile: { id: 'me', username: 'me', display_name: 'Me', onboarding_completed: true } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      redirect(to) { resolve({ redirect: to }); },
      render(view, data) { resolve({ view, data, status: this.statusCode }); },
      json(d) { resolve({ json: d }); }
    };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}

// A recorder that answers every query with what `answers` says for the table.
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
  return { from: q, rpc: (fn, args) => { writes.push({ rpc: fn, args }); return Promise.resolve({ data: null, error: null }); }, writes };
}

// A small in-memory PostgREST: enough of select/insert/update/upsert/delete
// and the filters the engines use to check what they actually store. Every
// query records whether it named the member (user_id), which the engines must
// always do on top of the row policies.
function memSb() {
  const db = {}, queries = [];
  let seq = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
  const KEYS = { metric_entries: ['user_id', 'metric', 'period'], checklist_progress: ['user_id', 'checklist', 'item'] };
  function from(table) {
    const s = { op: 'select', filters: [], eqs: {}, order: [], limit: null, one: null, ret: false };
    const rows = () => (db[table] = db[table] || []);
    const b = {
      select() { if (s.op !== 'select') s.ret = true; return b; },
      eq(c, v) { s.eqs[c] = v; s.filters.push(r => String(r[c]) === String(v)); return b; },
      in(c, a) { s.filters.push(r => a.includes(r[c])); return b; },
      gte(c, v) { s.filters.push(r => r[c] !== null && r[c] >= v); return b; },
      gt(c, v) { s.filters.push(r => r[c] !== null && r[c] > v); return b; },
      lte(c, v) { s.filters.push(r => r[c] !== null && r[c] <= v); return b; },
      lt(c, v) { s.filters.push(r => r[c] !== null && r[c] < v); return b; },
      order(c, o) { s.order.push([c, !o || o.ascending !== false]); return b; },
      limit(n) { s.limit = n; return b; },
      single() { s.one = 'single'; return b; },
      maybeSingle() { s.one = 'maybe'; return b; },
      insert(p) { s.op = 'insert'; s.payload = p; return b; },
      update(p) { s.op = 'update'; s.payload = p; return b; },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.opts = o || {}; return b; },
      delete() { s.op = 'delete'; return b; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); }
    };
    function exec() {
      queries.push({ table, op: s.op, scoped: s.op === 'insert' || s.op === 'upsert' ? !!s.payload.user_id : 'user_id' in s.eqs });
      const now = new Date().toISOString();
      let out;
      if (s.op === 'insert') {
        const r = Object.assign({ id: uuid(), created_at: now, updated_at: now }, s.payload);
        rows().push(r); out = [r];
      } else if (s.op === 'upsert') {
        const keys = (s.opts.onConflict || '').split(',').filter(Boolean);
        if (keys.join() !== (KEYS[table] || []).join()) return { data: null, error: { message: 'no unique constraint matching ' + keys.join() } };
        let r = rows().find(x => keys.every(k => x[k] === s.payload[k]));
        if (r) Object.assign(r, s.payload);
        else { r = Object.assign({ id: uuid(), created_at: now, done_at: null, due_on: null, note: null }, s.payload); rows().push(r); }
        out = [r];
      } else {
        out = rows().filter(r => s.filters.every(f => f(r)));
        if (s.op === 'update') out.forEach(r => Object.assign(r, s.payload, { updated_at: now }));
        if (s.op === 'delete') db[table] = rows().filter(r => !out.includes(r));
        out = out.slice().sort((a, b) => {
          for (const [c, asc] of s.order) { if (a[c] < b[c]) return asc ? -1 : 1; if (a[c] > b[c]) return asc ? 1 : -1; }
          return 0;
        });
        if (s.limit) out = out.slice(0, s.limit);
      }
      if (s.op !== 'select' && !s.ret) return { data: null, error: null };
      const copy = out.map(r => JSON.parse(JSON.stringify(r)));
      if (s.one === 'single') return copy.length === 1 ? { data: copy[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not one row' } };
      if (s.one === 'maybe') return { data: copy[0] || null, error: null };
      return { data: copy, error: null };
    }
    return b;
  }
  return { from, db, queries };
}

const NOW = new Date('2026-11-15T12:00:00Z');

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nDefinitions are checked when they are made:');
  const clients = registry.defineBoard({
    key: 'clients', label: 'Client pipeline', emoji: '🤝', itemLabel: 'client',
    stages: [{ key: 'lead', label: 'Lead' }, { key: 'proposal', label: 'Proposal' }, { key: 'won', label: 'Won' }, { key: 'paid', label: 'Paid', done: true }],
    valueLabel: 'Value ($)', valueKind: 'money',
    fields: [
      { key: 'source', label: 'Source', type: 'select', options: ['Referral', 'Cold email', 'Upwork'] },
      { key: 'rate', label: 'Hourly rate', type: 'money' },
      { key: 'hours', label: 'Hours', type: 'number' },
      { key: 'site', label: 'Website', type: 'url' },
      { key: 'kickoff', label: 'Kick-off', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'longtext' },
      { key: 'contact', label: 'Contact', type: 'text', placeholder: 'Name, email' }
    ]
  });
  registry.defineBoard({
    key: 'videos', label: 'Content pipeline', itemLabel: 'video', dueLabel: 'Publish date',
    stages: [{ key: 'idea', label: 'Idea' }, { key: 'scripted', label: 'Scripted' }, { key: 'published', label: 'Published', done: true }]
  });
  const followers = registry.defineMetric({ key: 'followers', label: 'Followers', unit: 'count', period: 'month' });
  const jobsWeek = registry.defineMetric({ key: 'jobs_booked', label: 'Jobs booked', unit: 'count', period: 'week' });
  const income = registry.defineMetric({ key: 'billable', label: 'Billable income', unit: 'money', period: 'month' });
  const costs = registry.defineMetric({ key: 'ad_spend', label: 'Ad spend', unit: 'money', period: 'month', higherIsBetter: false });
  const licences = registry.defineChecklist({
    key: 'licences', label: 'Licences & insurance', help: 'What a plumber needs before the first paid job.',
    items: [
      { key: 'register', label: 'Register the business', link: '/tools/structure' },
      { key: 'licence', label: 'Trade licence', expires: true, link: 'https://example.gov/licence' },
      { key: 'insurance', label: 'Public liability insurance', expires: true, help: 'Most clients ask for it.' },
      { key: 'bank', label: 'Separate bank account' }
    ]
  });

  ok('a board is looked up by key, with defaults filled in', registry.board('clients') === clients && registry.board('videos').valueLabel === null && registry.board('videos').dueLabel === 'Publish date' && clients.dueLabel === 'Due date');
  ok('a metric defaults to higher-is-better', followers.higherIsBetter === true && costs.higherIsBetter === false);
  ok('unknown keys look up as null', registry.board('nope') === null && registry.metric('nope') === null && registry.checklist('nope') === null);
  ok('all() lists every definition', registry.all().boards.length === 2 && registry.all().metrics.length === 4 && registry.all().checklists.length === 1);
  ok('definitions are frozen, so a page cannot change them for everyone', Object.isFrozen(clients) && Object.isFrozen(clients.stages[0]) && throws(() => { 'use strict'; clients.stages.push({}); }));

  const stages2 = [{ key: 'a1', label: 'A' }, { key: 'b1', label: 'B' }];
  ok('a key with capitals is refused', throws(() => registry.defineBoard({ key: 'Clients', label: 'x', itemLabel: 'x', stages: stages2 }), /key/));
  ok('a one-letter key is refused (the database wants 2–40)', throws(() => registry.defineMetric({ key: 'f', label: 'F', unit: 'count', period: 'month' }), /key/));
  ok('a duplicate key is refused', throws(() => registry.defineBoard({ key: 'clients', label: 'Again', itemLabel: 'x', stages: stages2 }), /already defined/));
  ok('...for metrics and checklists too', throws(() => registry.defineMetric({ key: 'followers', label: 'F', unit: 'count', period: 'month' }), /already/) &&
     throws(() => registry.defineChecklist({ key: 'licences', label: 'L', items: [{ key: 'ab', label: 'A' }] }), /already/));
  ok('a board needs at least two stages', throws(() => registry.defineBoard({ key: 'one_stage', label: 'x', itemLabel: 'x', stages: [{ key: 'only', label: 'Only' }] }), /two stages/) &&
     throws(() => registry.defineBoard({ key: 'no_stage', label: 'x', itemLabel: 'x' }), /two stages/));
  ok('stage keys must be unique and well formed', throws(() => registry.defineBoard({ key: 'dupe_stage', label: 'x', itemLabel: 'x', stages: [{ key: 'aa', label: 'A' }, { key: 'aa', label: 'B' }] }), /duplicate stage/) &&
     throws(() => registry.defineBoard({ key: 'bad_stage', label: 'x', itemLabel: 'x', stages: [{ key: 'In Progress', label: 'A' }, { key: 'bb', label: 'B' }] }), /stage/));
  ok('a board needs an itemLabel', throws(() => registry.defineBoard({ key: 'no_item', label: 'x', stages: stages2 }), /itemLabel/));
  ok('a field type must be one we can render', throws(() => registry.defineBoard({ key: 'bad_field', label: 'x', itemLabel: 'x', stages: stages2, fields: [{ key: 'colour', label: 'C', type: 'color' }] }), /type/));
  ok('a select needs options', throws(() => registry.defineBoard({ key: 'bad_select', label: 'x', itemLabel: 'x', stages: stages2, fields: [{ key: 'kind', label: 'K', type: 'select' }] }), /options/));
  ok('a field cannot take a column name', throws(() => registry.defineBoard({ key: 'reserved', label: 'x', itemLabel: 'x', stages: stages2, fields: [{ key: 'title', label: 'T', type: 'text' }] }), /reserved/));
  ok('a metric unit and period must be known', throws(() => registry.defineMetric({ key: 'bad_unit', label: 'B', unit: 'kg', period: 'month' }), /unit/) &&
     throws(() => registry.defineMetric({ key: 'bad_period', label: 'B', unit: 'count', period: 'day' }), /period/));
  ok('a checklist needs items, and links must be ours or http(s)', throws(() => registry.defineChecklist({ key: 'empty_list', label: 'E', items: [] }), /item/) &&
     throws(() => registry.defineChecklist({ key: 'bad_link', label: 'E', items: [{ key: 'xx', label: 'X', link: 'javascript:alert(1)' }] }), /link/));
  ok('a refused definition is not half-registered', registry.board('one_stage') === null && registry.metric('bad_unit') === null);

  // -------------------------------------------------------------------------
  console.log('\nCards come back typed the way their board says:');
  {
    const sb = memSb();
    const a = await pipeline.create(sb, 'u1', 'clients', {
      title: '  Acme   Bakery ', value: '$1,250.50', due_on: '2026-11-20', source: 'Referral', rate: '$85', hours: '12',
      site: 'acme.example', notes: 'Wants a new menu site', contact: '', sneaky: 'not a field', user_id: 'someone-else'
    });
    ok('the title is trimmed and squeezed', a.title === 'Acme Bakery', a.title);
    ok('money is parsed from "$1,250.50"', a.value === 1250.5, String(a.value));
    ok('a new card starts in the first stage', a.stage === 'lead');
    ok('declared fields are typed: select, money, number, url, longtext',
       a.data.source === 'Referral' && a.data.rate === 85 && a.data.hours === 12 && a.data.site === 'https://acme.example' && a.data.notes === 'Wants a new menu site', JSON.stringify(a.data));
    ok('empty fields are left out, unknown ones dropped', !('contact' in a.data) && !('sneaky' in a.data));
    ok('the row belongs to the member, whatever the form says', sb.db.pipeline_items[0].user_id === 'u1');
    ok('a second card in the same stage goes below the first', (await pipeline.create(sb, 'u1', 'clients', { title: 'Bo' })).position === a.position + 1);

    ok('no title is refused', await rejects(pipeline.create(sb, 'u1', 'clients', { title: '   ' }), /name/));
    ok('a value that is not a number is refused', await rejects(pipeline.create(sb, 'u1', 'clients', { title: 'X', value: 'lots' }), /must be a number/));
    ok('a date that does not exist is refused', await rejects(pipeline.create(sb, 'u1', 'clients', { title: 'X', due_on: '2026-02-30' }), /date/));
    ok('a select option the board does not offer is refused', await rejects(pipeline.create(sb, 'u1', 'clients', { title: 'X', source: 'Instagram' }), /one of/));
    ok('a javascript: link is refused', await rejects(pipeline.create(sb, 'u1', 'clients', { title: 'X', site: 'javascript:alert(1)' }), /web address/));
    ok('a stage the board does not have is refused', await rejects(pipeline.create(sb, 'u1', 'clients', { title: 'X', stage: 'invoiced' }), /stage/));
    ok('an unknown board is a not-found', await rejects(pipeline.create(sb, 'u1', 'nope', { title: 'X' }), /no board/));

    // Updates touch only what they name, and keep data a config no longer declares.
    sb.db.pipeline_items[0].data.legacy = 'kept';
    const u = await pipeline.update(sb, 'u1', 'clients', a.id, { title: 'Acme Bakery Ltd', hours: '' });
    ok('an update changes only the fields it names', u.title === 'Acme Bakery Ltd' && u.value === 1250.5 && u.due_on === '2026-11-20' && u.data.rate === 85, JSON.stringify(u));
    ok('...clears a field sent empty', !('hours' in u.data));
    ok('...and keeps data the board no longer declares', u.data.legacy === 'kept');
    ok('an update cannot blank the title', await rejects(pipeline.update(sb, 'u1', 'clients', a.id, { title: '' }), /name/));
    ok('an update to another member\'s card finds nothing', await rejects(pipeline.update(sb, 'u2', 'clients', a.id, { title: 'Mine now' }), /gone/));
    const u2 = await pipeline.update(sb, 'u1', 'clients', a.id, { value: '', stage: 'won' });
    ok('a value can be cleared, and an edit can change the stage', u2.value === null && u2.stage === 'won');

    const m = await pipeline.move(sb, 'u1', 'clients', a.id, 'paid');
    ok('move puts the card in the new stage', m.stage === 'paid');
    ok('move refuses a stage the board does not have', await rejects(pipeline.move(sb, 'u1', 'clients', a.id, 'invoiced'), /stage/));

    await pipeline.create(sb, 'u1', 'clients', { title: 'Cleo', value: '400', stage: 'proposal' });
    await pipeline.create(sb, 'u2', 'clients', { title: 'Not mine', value: '9999' });
    sb.db.pipeline_items.push({ id: 'stray', user_id: 'u1', board: 'clients', stage: 'retired_stage', title: 'Old', value: 50, data: {}, position: 0, created_at: 'x' });
    sb.db.pipeline_items.find(r => r.title === 'Acme Bakery Ltd').value = 1000;
    const b = await pipeline.list(sb, 'u1', 'clients');
    ok('columns come in stage order', b.columns.map(c => c.stage.key).join() === 'lead,proposal,won,paid');
    ok('only the member\'s own cards are listed', b.totals.count === 4 && !b.columns.some(c => c.items.some(i => i.title === 'Not mine')));
    ok('a card on a stage the config dropped shows in the first column', b.columns[0].items.some(i => i.id === 'stray'));
    ok('totals count and sum per stage', b.totals.byStage.proposal.count === 1 && b.totals.byStage.proposal.value === 400 && b.totals.byStage.paid.value === 1000);
    ok('the open value leaves out done stages', b.totals.value === 1450 && b.totals.openValue === 450, `${b.totals.value} / ${b.totals.openValue}`);
    ok('totals come formatted for the partial', b.totals.display.value === '$1,450' && b.totals.display.byStage.paid === '$1,000');
    const sum = await pipeline.summary(sb, 'u1', 'clients');
    ok('summary() gives the same numbers without the cards', sum.totals.count === 4 && sum.totals.openValue === 450);

    await pipeline.remove(sb, 'u2', 'clients', a.id);
    ok('another member cannot delete the card', sb.db.pipeline_items.some(r => r.id === a.id));
    await pipeline.remove(sb, 'u1', 'clients', a.id);
    ok('the owner can', !sb.db.pipeline_items.some(r => r.id === a.id));
    ok('every query named the member, not just the row policy', sb.queries.every(q => q.scoped), sb.queries.filter(q => !q.scoped).map(q => q.table + ':' + q.op).join(', ') || 'all scoped');
  }

  // -------------------------------------------------------------------------
  console.log('\nThe calendar lays dated cards on a month:');
  {
    const g = pipeline.monthGrid('2026-11', NOW);
    ok('November 2026 is six Monday-first weeks', g.length === 6 && g.every(w => w.length === 7) && g[0][0].date === '2026-10-26' && g[5][6].date === '2026-12-06', g[0][0].date + ' … ' + g[5][6].date);
    ok('days outside the month are marked, and today is', !g[0][0].inMonth && g[0][6].date === '2026-11-01' && g[0][6].inMonth && g.flat().filter(c => c.today).map(c => c.date).join() === '2026-11-15');
    ok('February 2027 fits in exactly four weeks', pipeline.monthGrid('2027-02').length === 4);
    ok('a bad month is refused', throws(() => pipeline.monthGrid('2026-13')));

    const sb = memSb();
    await pipeline.create(sb, 'u1', 'clients', { title: 'Call Acme', due_on: '2026-11-03' });
    await pipeline.create(sb, 'u1', 'videos', { title: 'Shoot vlog', due_on: '2026-11-03' });
    await pipeline.create(sb, 'u1', 'videos', { title: 'Edit vlog', due_on: '2026-11-30' });
    await pipeline.create(sb, 'u1', 'videos', { title: 'December one', due_on: '2026-12-01' });
    await pipeline.create(sb, 'u1', 'videos', { title: 'Undated' });
    await pipeline.create(sb, 'u2', 'videos', { title: 'Theirs', due_on: '2026-11-03' });
    const cal = await pipeline.calendar(sb, 'u1', ['clients', 'videos', 'ghost'], '2026-11', NOW);
    ok('cards are grouped by date, across boards', cal.byDate['2026-11-03'].map(i => i.title).sort().join() === 'Call Acme,Shoot vlog', JSON.stringify(Object.keys(cal.byDate)));
    ok('only that month, only dated, only the member\'s', cal.count === 3 && !cal.byDate['2026-12-01']);
    ok('the grid cells carry their cards', cal.weeks[5][0].date === '2026-11-30' && cal.weeks[5][0].items[0].title === 'Edit vlog');
    ok('unknown boards are skipped, and prev/next months given', !cal.boards.ghost && cal.prev === '2026-10' && cal.next === '2026-12');
    ok('no known boards at all is a not-found', await rejects(pipeline.calendar(sb, 'u1', ['ghost'], '2026-11'), /None of those boards/));
    const jan = await pipeline.calendar(sb, 'u1', ['videos'], '2026-12', NOW);
    ok('December picks up its own card', jan.count === 1 && jan.next === '2027-01');
  }

  // -------------------------------------------------------------------------
  console.log('\nMetric periods, logs and trends:');
  {
    ok('a monthly metric logs to the 1st of the month', metrics.periodOf(followers, '2026-11-17') === '2026-11-01' && metrics.periodOf(followers, '2026-11') === '2026-11-01');
    ok('blank means this period', metrics.periodOf(followers, '', NOW) === '2026-11-01' && metrics.periodOf(jobsWeek, '', NOW) === '2026-11-09');
    ok('a weekly metric logs to the Monday', metrics.periodOf(jobsWeek, '2026-11-05') === '2026-11-02' && metrics.periodOf(jobsWeek, '2026-11-08') === '2026-11-02' && metrics.periodOf(jobsWeek, '2026-11-09') === '2026-11-09');
    ok('an ISO week from <input type="week"> works', metrics.periodOf(jobsWeek, '2026-W45') === '2026-11-02' && metrics.periodOf(jobsWeek, '2026-W01') === '2025-12-29');
    ok('a week across New Year starts in December', metrics.periodOf(jobsWeek, '2027-01-01') === '2026-12-28');
    ok('week 53 exists only in long years', metrics.periodOf(jobsWeek, '2020-W53') === '2020-12-28' && throws(() => metrics.periodOf(jobsWeek, '2021-W53'), /period/));
    ok('nonsense is refused', throws(() => metrics.periodOf(followers, 'last tuesday'), /period/));
    ok('period labels read naturally', metrics.periodLabel(followers, '2026-11-01') === 'November 2026' && metrics.periodLabel(jobsWeek, '2026-11-02') === 'Week of 2 Nov 2026');

    const sb = memSb();
    await metrics.log(sb, 'u1', 'billable', '2026-11-03', '$1,200', '  first   month  ', NOW);
    await metrics.log(sb, 'u1', 'billable', '2026-11-28', '1500', '', NOW);
    ok('logging the same month twice replaces the number', sb.db.metric_entries.length === 1 && sb.db.metric_entries[0].value === 1500 && sb.db.metric_entries[0].period === '2026-11-01');
    ok('the note is cleared when sent empty, and the row is the member\'s', sb.db.metric_entries[0].note === null && sb.db.metric_entries[0].user_id === 'u1');
    await metrics.log(sb, 'u1', 'billable', '2026-09', '800', 'x'.repeat(300), NOW);
    ok('notes are cut to 200 characters', sb.db.metric_entries.find(r => r.period === '2026-09-01').note.length === 200);
    ok('a blank or non-number value is refused', await rejects(metrics.log(sb, 'u1', 'billable', '', '', '', NOW), /Enter a number/) && await rejects(metrics.log(sb, 'u1', 'billable', '', 'ten', '', NOW), /must be a number/));
    ok('an unknown metric is a not-found', await rejects(metrics.log(sb, 'u1', 'nope', '', '1'), /no metric/));
    await metrics.log(sb, 'u2', 'billable', '2026-10', '99999', '', NOW);

    const s = await metrics.series(sb, 'u1', 'billable', 4, NOW);
    ok('a series is the last n periods, oldest first', s.map(p => p.period).join() === '2026-08-01,2026-09-01,2026-10-01,2026-11-01', s.map(p => p.period).join());
    ok('a period with nothing logged is null, not zero — and other members never show', s.map(p => p.value).join() === ',800,,1500', JSON.stringify(s.map(p => p.value)));
    await metrics.log(sb, 'u1', 'jobs_booked', '2026-11-04', '3', '', NOW);
    await metrics.log(sb, 'u1', 'jobs_booked', '2026-W46', '5', '', NOW);
    const w = await metrics.series(sb, 'u1', 'jobs_booked', 3, NOW);
    ok('a weekly series steps a week at a time', w.map(p => p.period).join() === '2026-10-26,2026-11-02,2026-11-09' && w.map(p => p.value).join() === ',3,5');

    const sum = metrics.summary(s, income);
    ok('summary: latest, previous, change and change %', sum.latest.value === 1500 && sum.previous.value === 800 && sum.change === 700 && sum.changePct === 87.5, JSON.stringify(sum));
    ok('summary: best period, direction and whether that is good', sum.best.value === 1500 && sum.direction === 'up' && sum.good === true);
    const spend = metrics.summary([{ period: 'a', value: 300 }, { period: 'b', value: 200 }, { period: 'c', value: 250 }], costs);
    ok('for a lower-is-better metric, best is the lowest and a rise is not good', spend.best.value === 200 && spend.change === 50 && spend.good === false);
    const fromZero = metrics.summary([{ period: 'a', value: 0 }, { period: 'b', value: 40 }]);
    ok('change % from zero is left out rather than infinite', fromZero.change === 40 && fromZero.changePct === null);
    const none = metrics.summary([{ period: 'a', value: null }]);
    ok('an empty series has no headline numbers', none.latest === null && none.change === null && none.best === null);
    const card = metrics.present(income, s);
    ok('the card is formatted by unit', card.display.latest === '$1,500' && card.display.change === '+$700' && card.display.changePct === '+87.5%', JSON.stringify(card.display));
    ok('sparkline bars scale to the biggest value; gaps stay empty', card.bars[3].pct === 100 && card.bars[1].pct === 53 && card.bars[0].pct === 0);

    const id = sb.db.metric_entries.find(r => r.period === '2026-09-01' && r.metric === 'billable').id;
    await metrics.remove(sb, 'u2', 'billable', id);
    ok('another member cannot delete an entry', sb.db.metric_entries.some(r => r.id === id));
    await metrics.remove(sb, 'u1', 'billable', id);
    ok('the owner can', !sb.db.metric_entries.some(r => r.id === id));
    ok('every metric query named the member', sb.queries.every(q => q.scoped));
  }

  // -------------------------------------------------------------------------
  console.log('\nChecklists merge the template with the member\'s ticks:');
  {
    const p = checklists.merge(licences, [
      { item: 'register', done_at: '2026-10-01T00:00:00Z' },
      { item: 'insurance', due_on: '2026-12-01', note: 'Policy 123' },
      { item: 'licence', done_at: '2026-10-02T00:00:00Z', due_on: '2026-11-10' },
      { item: 'bank', due_on: '2026-11-20' },               // not an expiring item: ignored
      { item: 'retired_item', done_at: '2026-01-01' }       // no longer on the template
    ], NOW);
    ok('ticks and notes are merged in template order', p.items.map(i => i.key).join() === 'register,licence,insurance,bank' && p.items[0].done && p.items[2].note === 'Policy 123');
    ok('done count and percent ignore retired items', p.done === 2 && p.total === 4 && p.pct === 50);
    ok('the next 3 open items are listed', p.open.map(i => i.key).join() === 'insurance,bank');
    ok('the next expiry is the soonest, overdue first', p.nextExpiry.key === 'licence' && p.nextExpiry.overdue === true && p.nextExpiry.dueLabel === '10 Nov 2026');
    ok('a date within 30 days is "soon"', p.items[2].dueSoon === true && p.items[2].overdue === false);
    ok('only expiring items carry a renew-by date', p.items[3].due_on === null);

    const sb = memSb();
    ok('toggle with nothing stored ticks it', await checklists.toggle(sb, 'u1', 'licences', 'insurance', undefined, NOW) === true && sb.db.checklist_progress[0].done_at === NOW.toISOString());
    await checklists.setDue(sb, 'u1', 'licences', 'insurance', '2027-01-31');
    await checklists.setNote(sb, 'u1', 'licences', 'insurance', '  call   Bob ');
    ok('toggle again unticks it, keeping the date and note', await checklists.toggle(sb, 'u1', 'licences', 'insurance') === false &&
       sb.db.checklist_progress.length === 1 && sb.db.checklist_progress[0].done_at === null && sb.db.checklist_progress[0].due_on === '2027-01-31' && sb.db.checklist_progress[0].note === 'call Bob');
    ok('an explicit done=true is idempotent', await checklists.toggle(sb, 'u1', 'licences', 'bank', true) && await checklists.toggle(sb, 'u1', 'licences', 'bank', true) && sb.db.checklist_progress.find(r => r.item === 'bank').done_at);
    ok('a renew-by date only goes on expiring items', await rejects(checklists.setDue(sb, 'u1', 'licences', 'bank', '2027-01-01'), /renewal/));
    ok('a bad date is refused; blank clears it', await rejects(checklists.setDue(sb, 'u1', 'licences', 'licence', '2027-02-30'), /date/) &&
       (await checklists.setDue(sb, 'u1', 'licences', 'insurance', '')) === null && sb.db.checklist_progress[0].due_on === null);
    ok('an item not on the checklist is a not-found', await rejects(checklists.toggle(sb, 'u1', 'licences', 'nope'), /not on this checklist/));
    const live = await checklists.progress(sb, 'u1', 'licences', NOW);
    ok('progress() reads the member\'s rows back', live.done === 1 && live.items.find(i => i.key === 'bank').done && live.items.find(i => i.key === 'insurance').note === 'call Bob');
    ok('every checklist query named the member', sb.queries.every(q => q.scoped));
  }

  // -------------------------------------------------------------------------
  console.log('\nNumbers read the way members expect:');
  ok('money: $1,234, cents only when there are some', fmt.money(1234) === '$1,234' && fmt.money(12.5) === '$12.50' && fmt.money(-40) === '−$40');
  ok('percent and counts', fmt.percent(12.5) === '12.5%' && fmt.number(10000) === '10,000' && fmt.byUnit('count', 3) === '3');
  ok('signed changes', fmt.change('money', 200) === '+$200' && fmt.change('count', -3) === '−3' && fmt.change('percent', 1.5) === '+1.5%');

  // -------------------------------------------------------------------------
  console.log('\nThe routes:');
  const router = require('../src/routes/boards');
  const ID = '00000000-0000-4000-8000-000000000001';
  const card = { id: ID, board: 'clients', stage: 'lead', title: 'Acme', value: 900, due_on: '2026-11-20', data: { source: 'Referral' }, position: 1, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' };
  const MISSING = { data: null, error: { code: '42P01', message: 'relation "public.pipeline_items" does not exist' } };
  const NO_TABLE = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.metric_entries' in the schema cache" } };
  {
    const sb = fakeSb({ pipeline_items: s => (s.op === 'select' ? { data: [card], error: null } : { data: card, error: null }) });
    const r = await run(router, 'GET', '/boards/clients', { sb });
    ok('GET a board renders its columns', r.view === 'workspace/board' && r.data.columns.length === 4 && r.data.columns[0].items[0].title === 'Acme' && r.data.title === 'Client pipeline');
    const r404 = await run(router, 'GET', '/boards/nope', { sb });
    ok('an unknown board is a 404', r404.view === 'error' && r404.status === 404);
    ok('an unknown metric and checklist are 404s too', (await run(router, 'GET', '/metrics/nope', { sb })).status === 404 && (await run(router, 'GET', '/checklists/nope', { sb })).status === 404);
    ok('a card id that is not a uuid is a 404, not a database error', (await run(router, 'GET', '/boards/clients/not-a-uuid', { sb })).status === 404);
    // fakeSb cannot tell maybeSingle() from a list, so the card page gets its own answer.
    const item = await run(router, 'GET', '/boards/clients/' + ID, { sb: fakeSb({ pipeline_items: { data: card, error: null } }) });
    ok('GET a card renders its edit page', item.view === 'workspace/board_item' && item.data.item.title === 'Acme');
  }
  {
    const sb = fakeSb({ pipeline_items: s => (s.op === 'insert' ? { data: Object.assign({}, card, s.payload, { id: ID }), error: null } : { data: [], error: null }) });
    const r = await run(router, 'POST', '/boards/clients', { sb, body: { title: 'Acme', value: '900', stage: 'won', user_id: 'evil' } });
    const ins = sb.writes.find(w => w.op === 'insert');
    ok('POST creates the card as the member and goes back to the board', /^\/workspace\/boards\/clients\?msg=/.test(r.redirect) && ins.payload.user_id === 'me' && ins.payload.stage === 'won' && ins.payload.value === 900, r.redirect);
    const bad = await run(router, 'POST', '/boards/clients', { sb, body: { title: '' } });
    ok('a card with no name goes back with the reason', /\?err=Give%20the%20client%20a%20name/.test(bad.redirect), bad.redirect);
  }
  {
    const sb = fakeSb({ pipeline_items: s => (s.op === 'update' ? { data: Object.assign({}, card, s.payload), error: null } : { data: [card], error: null }) });
    const mv = await run(router, 'POST', '/boards/clients/' + ID + '/move', { sb, body: { stage: 'proposal' } });
    ok('move goes back to the card on the board', mv.redirect === '/workspace/boards/clients#item-' + ID && sb.writes.some(w => w.op === 'update' && w.payload.stage === 'proposal'));
    const bad = await run(router, 'POST', '/boards/clients/' + ID + '/move', { sb, body: { stage: 'invoiced' } });
    ok('move to a stage the board lacks is refused', /err=That%20stage/.test(bad.redirect));
    const del = await run(router, 'POST', '/boards/clients/' + ID + '/delete', { sb });
    ok('delete goes back with a note', /msg=Deleted/.test(del.redirect) && sb.writes.some(w => w.op === 'delete'));
    const cal = await run(router, 'GET', '/calendar', { sb, query: { boards: 'clients,videos', month: '2026-11' } });
    ok('the calendar renders the month asked for', cal.view === 'workspace/calendar' && cal.data.cal.month === '2026-11' && cal.data.cal.byDate['2026-11-20'][0].title === 'Acme');
    ok('the calendar 404s when no asked-for board exists', (await run(router, 'GET', '/calendar', { sb, query: { boards: 'ghost' } })).status === 404);
  }
  {
    const sb = fakeSb({ metric_entries: s => (s.op === 'upsert' ? { data: Object.assign({ id: ID }, s.payload), error: null } : { data: [], error: null }) });
    const g = await run(router, 'GET', '/metrics/followers', { sb });
    ok('GET a metric renders its log', g.view === 'workspace/metric' && g.data.card.bars.length === 12 && g.data.periodValue.length === 7);
    const p = await run(router, 'POST', '/metrics/followers', { sb, body: { period: '2026-10', value: '1,200', note: 'launch' } });
    const up = sb.writes.find(w => w.op === 'upsert');
    ok('POST logs the number for the member and the period', up.payload.user_id === 'me' && up.payload.period === '2026-10-01' && up.payload.value === 1200 && /msg=Logged%201%2C200%20for%20October%202026/.test(p.redirect), p.redirect);
    const bad = await run(router, 'POST', '/metrics/followers', { sb, body: { value: '' } });
    ok('a blank number goes back with the reason', /err=Enter%20a%20number/.test(bad.redirect));
    const d = await run(router, 'POST', '/metrics/followers/' + ID + '/delete', { sb });
    ok('an entry can be deleted', /msg=Entry%20deleted/.test(d.redirect) && sb.writes.some(w => w.table === 'metric_entries' && w.op === 'delete'));
  }
  {
    const sb = fakeSb({ checklist_progress: { data: [], error: null } });
    const g = await run(router, 'GET', '/checklists/licences', { sb });
    ok('GET a checklist renders it', g.view === 'workspace/checklist' && g.data.progress.total === 4);
    const t = await run(router, 'POST', '/checklists/licences/bank/toggle', { sb, body: { done: '1' } });
    const up = sb.writes.find(w => w.op === 'upsert');
    ok('toggle ticks it for the member', t.redirect === '/workspace/checklists/licences#item-bank' && up.payload.user_id === 'me' && up.payload.done_at);
    const due = await run(router, 'POST', '/checklists/licences/licence/due', { sb, body: { due_on: '2027-03-01' } });
    ok('a renew-by date is saved', /msg=Renew-by%20date%20set/.test(due.redirect) && sb.writes.some(w => w.op === 'upsert' && w.payload.due_on === '2027-03-01'));
    const nope = await run(router, 'POST', '/checklists/licences/ghost/toggle', { sb });
    ok('an item not on the list is a 404', nope.status === 404);
  }

  // -------------------------------------------------------------------------
  console.log('\nBefore the migration, every page says "being set up" instead of failing:');
  {
    const sb = fakeSb({ pipeline_items: MISSING, metric_entries: NO_TABLE, checklist_progress: { data: null, error: { message: 'relation "public.checklist_progress" does not exist' } } });
    const b = await run(router, 'GET', '/boards/clients', { sb });
    ok('the board', b.view === 'workspace/board' && b.data.notReady === true && b.data.columns.length === 4);
    const c = await run(router, 'GET', '/calendar', { sb, query: { boards: 'videos' } });
    ok('the calendar', c.view === 'workspace/calendar' && c.data.notReady === true);
    const m = await run(router, 'GET', '/metrics/billable', { sb });
    ok('the metric (PGRST205)', m.view === 'workspace/metric' && m.data.notReady === true && m.data.card.bars.length === 12);
    const k = await run(router, 'GET', '/checklists/licences', { sb });
    ok('the checklist (matched on the message alone)', k.view === 'workspace/checklist' && k.data.notReady === true);
    const i = await run(router, 'GET', '/boards/clients/' + ID, { sb });
    ok('a card page goes back to the board', i.redirect === '/workspace/boards/clients');
    const p = await run(router, 'POST', '/boards/clients', { sb, body: { title: 'Acme' } });
    ok('a write goes back to the page, without an error on top', p.redirect === '/workspace/boards/clients');
    const pm = await run(router, 'POST', '/metrics/billable', { sb, body: { value: '5' } });
    ok('...for metrics too', pm.redirect === '/workspace/metrics/billable');
    const other = fakeSb({ pipeline_items: { data: null, error: { code: '42501', message: 'permission denied' } } });
    const o = await run(router, 'GET', '/boards/clients', { sb: other });
    ok('a different database error is not mistaken for "being set up"', o.error && o.error.code === '42501');
  }

  // -------------------------------------------------------------------------
  console.log('\nEvery page and partial renders:');
  {
    const V = f => path.join(ROOT, 'views', f);
    const base = {
      title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me' }, plan: 'paid', currentPath: '/workspace', canonicalUrl: 'x',
      unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
      isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [],
      affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
    };
    const render = (f, locals) => ejs.render(read('views/' + f), Object.assign({}, base, { root: '/workspace', fmt, msg: null, notReady: false }, locals), { filename: V(f) });

    const sb = memSb();
    const acme = await pipeline.create(sb, 'me', 'clients', { title: 'Acme <script>', value: '1250.5', due_on: '2026-11-03', source: 'Upwork', site: 'acme.example', notes: 'Menu site' });
    await pipeline.create(sb, 'me', 'clients', { title: 'Bo', value: '300', stage: 'paid' });
    await pipeline.create(sb, 'me', 'videos', { title: 'Shoot vlog', due_on: '2026-11-03' });
    await metrics.log(sb, 'me', 'billable', '2026-10', '800', 'first client', NOW);
    await metrics.log(sb, 'me', 'billable', '2026-11', '1200', '', NOW);
    await checklists.toggle(sb, 'me', 'licences', 'register', true, NOW);
    await checklists.setDue(sb, 'me', 'licences', 'insurance', '2026-12-01');

    const b = await pipeline.list(sb, 'me', 'clients');
    let h = render('workspace/board.ejs', { title: 'Client pipeline', def: clients, columns: b.columns, totals: b.totals, msg: 'Added "Bo".' });
    ok('board: stages, cards, values, select chips and the notice', ['Lead', 'Proposal', 'Won', 'Paid', 'Acme', '$1,250.50', 'Upwork', 'Added &#34;Bo&#34;.'].every(s => h.includes(s)) && /<p class="notice">/.test(h));
    ok('board: card titles are escaped', !h.includes('Acme <script>') && h.includes('Acme &lt;script&gt;'));
    ok('board: ← → and a stage select move cards without JS', h.includes('aria-label="Move to Proposal"') && /<form method="post" action="\/workspace\/boards\/clients\/[^"]+\/move">\s*<select name="stage"/.test(h) && h.includes('<noscript>'));
    ok('board: columns scroll sideways on a phone', /\.ws-board \{[^}]*overflow-x: auto/.test(h));
    ok('board: the add form carries every declared field', clients.fields.every(f => h.includes(`name="${f.key}"`)));
    h = render('workspace/board.ejs', { def: registry.board('videos'), columns: registry.board('videos').stages.map(s => ({ stage: s, items: [] })), totals: pipeline.totalsOf(registry.board('videos'), []), notReady: true });
    ok('board: the "being set up" state', h.includes('Being set up') && !h.includes('Add a video'));

    const one = (await pipeline.get(sb, 'me', 'clients', acme.id)).item;
    h = render('workspace/board_item.ejs', { def: clients, item: one });
    ok('card page: the edit form is filled in', h.includes('value="1250.5"') && h.includes('value="2026-11-03"') && h.includes('<option selected>Upwork</option>') && h.includes('Menu site') && h.includes('href="https://acme.example"'));

    const cal = await pipeline.calendar(sb, 'me', ['clients', 'videos'], '2026-11', NOW);
    h = render('workspace/calendar.ejs', { cal, boardsParam: 'clients,videos' });
    ok('calendar: the month, its cards, and prev/next links that keep the boards', h.includes('November 2026') && h.includes('Shoot vlog') && h.includes('/workspace/calendar?boards=clients%2Cvideos&amp;month=2026-10') && h.includes('month=2026-12'));
    ok('calendar: an agenda list for narrow screens', h.includes('class="ws-agenda"') && /max-width: 680px/.test(h));

    const s = await metrics.series(sb, 'me', 'billable', 12, NOW);
    const hist = await metrics.entries(sb, 'me', 'billable');
    h = render('workspace/metric.ejs', { def: income, card: metrics.present(income, s), history: hist, periodValue: '2026-11', periodLabel: 'November 2026' });
    ok('metric: latest, change, bars, history and delete', ['$1,200', '+$400', '(+50%)', 'first client', 'October 2026', 'class="fill"', '/delete'].every(x => h.includes(x)));
    ok('metric: the log form asks for a month', h.includes('type="month"') && h.includes('value="2026-11"'));
    h = render('workspace/metric.ejs', { def: jobsWeek, card: metrics.present(jobsWeek, await metrics.series(sb, 'me', 'jobs_booked', 12, NOW)), history: [], periodValue: '2026-W46', periodLabel: 'Week of 9 Nov 2026' });
    ok('metric: a weekly one asks for a week, and says when nothing is logged', h.includes('type="week"') && h.includes('Nothing logged yet'));

    const prog = await checklists.progress(sb, 'me', 'licences', NOW);
    h = render('workspace/checklist.ejs', { def: licences, progress: prog });
    ok('checklist: items, ticks, renewal, links', h.includes('1 of 4') && h.includes('Public liability insurance') && h.includes('Renew by 1 Dec 2026') && h.includes('href="/tools/structure"') && h.includes('name="due_on"'));

    const sum = await pipeline.summary(sb, 'me', 'clients');
    h = render('partials/board_summary.ejs', { summary: sum });
    ok('board_summary: counts per stage, total value and a link', h.includes('Lead <strong>1</strong>') && h.includes('$1,550.50 total') && h.includes('$1,250.50 open') && h.includes('href="/workspace/boards/clients"'));
    h = render('partials/board_summary.ejs', { summary: { def: registry.board('videos'), totals: pipeline.totalsOf(registry.board('videos'), []) } });
    ok('board_summary: empty, with no value line on a board that tracks none', h.includes('No videos yet') && !h.includes('total'));
    const mc = await metrics.card(sb, 'me', 'billable', 8, NOW);
    h = ejs.render(read('views/partials/metric_card.ejs'), { card: mc }, { filename: V('partials/metric_card.ejs') });
    ok('metric_card: renders with only its own local (root defaults)', h.includes('$1,200') && h.includes('+$400') && h.includes('href="/workspace/metrics/billable"') && (h.match(/title="/g) || []).length === 8);
    h = ejs.render(read('views/partials/checklist_card.ejs'), { progress: prog, root: '/ws' }, { filename: V('partials/checklist_card.ejs') });
    ok('checklist_card: done/total, next open items, next expiry, link', h.includes('1/4') && h.includes('Trade licence') && h.includes('Renew Public liability insurance — 1 Dec 2026') && h.includes('href="/ws/checklists/licences"'));
  }

  // -------------------------------------------------------------------------
  console.log('\nWrites match the pending migration:');
  {
    const sql = read('migrations/2026-11-01_workspace_foundations.sql');
    const cols = t => {
      const m = new RegExp(`create table if not exists public\\.${t} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
      return m ? m[1].split('\n').map(l => (l.trim().match(/^([a-z_]+)\s/) || [])[1]).filter(Boolean).filter(c => !['unique', 'primary'].includes(c)) : [];
    };
    const src = ['pipeline', 'metrics', 'checklists'].map(f => read(`src/engines/${f}.js`)).join('\n');
    const written = {};
    for (const m of src.matchAll(/\.from\('([a-z_]+)'\)\.(?:insert|upsert)\(\{([\s\S]*?)\}/g)) {
      // "key: value" and shorthand "key" alike.
      written[m[1]] = (written[m[1]] || []).concat(m[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(k => /^[a-z_]+$/.test(k)));
    }
    ['pipeline_items', 'metric_entries', 'checklist_progress'].forEach(t => {
      const bad = (written[t] || []).filter(c => !cols(t).includes(c));
      ok(`${t}: every column written exists in the migration`, written[t] && !bad.length, bad.join(', ') || [...new Set(written[t])].join(', '));
    });
  }

  console.log(fail ? `\n${fail} failing\n` : '\nAll good\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
