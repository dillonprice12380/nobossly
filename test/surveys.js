// The survey maker.
//
// A member builds a survey, shares a link that anyone can answer without an
// account, and reads the results: a count, a chart per question, every written
// answer, and a CSV. This checks the question shape against the SQL that
// enforces it, the arithmetic behind the charts, that a CSV cannot smuggle a
// formula onto the creator's machine, the builder and public routes against a
// fake database, and that every view renders.
//
//   node test/surveys.js

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const S = require('../src/surveys');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

const { FLAGS } = require('../src/features');
const MIGRATION = 'migrations/2026-11-01_workspace_foundations.sql';

// A tiny stand-in for the Express request/response, enough to drive a route.
function run(router, method, url, { body = {}, query = {}, sb, cookies = {}, headers = {}, user = { id: 'me' } } = {}) {
  return new Promise((resolve) => {
    const out = { cookies: [], headers: {} };
    const req = {
      method, url, body, query, params: {}, sb, cookies, headers, user, protocol: 'http',
      profile: user ? { id: user.id, username: 'me', display_name: 'Me', onboarding_completed: true } : null
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      redirect(to) { resolve(Object.assign(out, { redirect: to })); },
      render(view, data) { resolve(Object.assign(out, { view, data, status: this.statusCode })); },
      set(k, v) { out.headers[k.toLowerCase()] = v; return this; },
      cookie(name, value, opts) { out.cookies.push({ name, value, opts }); return this; },
      send(b) { resolve(Object.assign(out, { body: b, status: this.statusCode })); },
      json(d) { resolve(Object.assign(out, { json: d })); }
    };
    router.handle(req, res, (e) => resolve({ error: e || 'next' }));
  });
}

// A recorder: every query and write is kept, with its filters, and answered by
// `tables[table](state)` or `rpc[fn](args)`.
function fakeSb({ tables = {}, rpc = {} } = {}) {
  const writes = [];
  const calls = [];
  const from = (table) => {
    const st = { table, op: 'select', payload: null, filters: [] };
    calls.push(st);
    const chain = new Proxy({}, {
      get(_, k) {
        if (k === 'then') {
          const a = tables[table];
          const res = typeof a === 'function' ? a(st) : (a || { data: [], error: null });
          return (ok2, rej) => Promise.resolve(res).then(ok2, rej);
        }
        if (['insert', 'update', 'delete', 'upsert'].includes(k)) {
          return (p) => { st.op = k; st.payload = p; writes.push(st); return chain; };
        }
        if (k === 'eq' || k === 'neq') return (c, v) => { st.filters.push([k, c, v]); return chain; };
        return () => chain;
      }
    });
    return chain;
  };
  return {
    from, writes, calls,
    rpc: (fn, args) => {
      calls.push({ rpc: fn, args });
      const a = rpc[fn];
      return Promise.resolve(typeof a === 'function' ? a(args) : (a || { data: null, error: null }));
    }
  };
}

const SID = '11111111-2222-4333-8444-555555555555';
const mkSurvey = (over = {}) => Object.assign({
  id: SID, title: 'Menu feedback', description: 'Two minutes, promise.', status: 'draft', deadline: null,
  response_count: 0, max_responses: 1000, share_code: null, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z',
  questions: [
    { id: 'qaaaa', type: 'short_text', label: 'Your name?', required: false },
    { id: 'qbbbb', type: 'single_choice', label: 'Favourite dish?', required: true, options: ['Soup', 'Salad', 'Pie'] },
    { id: 'qcccc', type: 'rating', label: 'Rate us', required: false }
  ]
}, over);
// The surveys table: a select by id answers with `survey`; an update or delete
// succeeds unless `writeError` says otherwise.
const surveysTable = (survey, writeError = null) => st => (st.op === 'select' ? { data: survey, error: null } : { data: null, error: writeError });
const lastUpdate = sb => sb.writes.filter(w => w.table === 'surveys' && w.op === 'update').pop();
const LEGACY = ['idea_id', 'xp_reward', 'target_count'];

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nThe question shape matches the SQL that checks answers:');
  {
    const sql = read(MIGRATION);
    const fn = sql.slice(sql.indexOf('create or replace function public.survey_submit'), sql.indexOf('$function$;', sql.indexOf('create or replace function public.survey_submit')));
    const sqlTypes = new Set();
    for (const m of fn.matchAll(/qtype\s*(?:in\s*\(([^)]*)\)|=\s*'([a-z_]+)')/g)) {
      if (m[1]) for (const t of m[1].matchAll(/'([a-z_]+)'/g)) sqlTypes.add(t[1]);
      if (m[2]) sqlTypes.add(m[2]);
    }
    const mine = new Set(S.TYPE_KEYS);
    ok('survey_submit accepts exactly the question types src/surveys.js defines',
       sqlTypes.size === mine.size && [...mine].every(t => sqlTypes.has(t)), [...sqlTypes].sort().join(', '));
    ok('the SQL reads id, type, required and options — the keys questions are stored with',
       /q->>'id'/.test(fn) && /q->>'type'/.test(fn) && /q->>'required'/.test(fn) && /q->'options'/.test(fn));
    const share = (sql.match(/share_code ~ '([^']+)'/) || [])[1];
    const codes = Array.from({ length: 50 }, S.shareCode);
    ok('every share code passes the table\'s share_code check', !!share && codes.every(c => new RegExp(share).test(c)), share);
    ok('share codes are 16 url-safe characters and do not repeat', codes.every(c => c.length === 16 && S.SHARE_CODE_RE.test(c)) && new Set(codes).size === codes.length);
    const vis = (sql.match(/p_visitor !~ '([^']+)'/) || [])[1];
    ok('a visitor key passes survey_submit\'s visitor check', !!vis && new RegExp(vis).test(S.visitorKey('c'.repeat(64), SID)), vis);
    ok('the SQL limits match the module (40 questions, title 160, description 2000, 1–10000 responses)',
       /jsonb_array_length\(questions\) <= 40/.test(sql) && /char_length\(title\) between 1 and 160/.test(sql) &&
       /char_length\(description\) <= 2000/.test(sql) && /max_responses between 1 and 10000/.test(sql) &&
       S.LIMITS.questions === 40 && S.LIMITS.title === 160 && S.LIMITS.description === 2000 && S.LIMITS.maxResponses.max === 10000);
    ok('written answers are cut to the lengths the SQL keeps (300 / 3000)',
       /then 300 else 3000/.test(fn) && S.LIMITS.answer.short_text === 300 && S.LIMITS.answer.long_text === 3000);
  }

  // -------------------------------------------------------------------------
  console.log('\nnormalizeQuestions cleans what the builder sends:');
  {
    const out = S.normalizeQuestions([
      { id: 'qkeep', type: 'short_text', label: '  What   is your\nemail?  ', help: '   ', required: 'on', options: ['x', 'y'] },
      { id: 'qkeep', type: 'yes_no', label: 'Again?', required: false },
      { type: 'nonsense', label: 'Dropped' },
      { type: 'long_text', label: '   ' },
      { id: 'bad id!', type: 'single_choice', label: 'Pick', options: 'Soup\n\n soup \nSalad\r\nPie' },
      { type: 'multi_choice', label: 'Only one', options: ['A', 'a'] },
      { type: 'rating', label: 'x'.repeat(400), help: 'h'.repeat(400), required: 'true' }
    ]);
    ok('unknown types, blank labels and choices with under two options are dropped', out.length === 4, out.map(q => q.type).join(','));
    ok('labels are trimmed and whitespace collapsed', out[0].label === 'What is your email?', JSON.stringify(out[0].label));
    ok('a blank hint is left out', !('help' in out[0]));
    ok('required is read from a checkbox', out[0].required === true && out[1].required === false && out[3].required === true);
    ok('options are dropped from a type that has none', !('options' in out[0]) && !('options' in out[1]));
    ok('a good id is kept', out[0].id === 'qkeep');
    ok('a repeated or malformed id is replaced by a fresh one', out[1].id !== 'qkeep' && /^q[a-z0-9]{4}$/.test(out[1].id) && /^q[a-z0-9]{4}$/.test(out[2].id));
    ok('options come from a textarea, blank lines and case-repeats removed', JSON.stringify(out[2].options) === '["Soup","Salad","Pie"]', JSON.stringify(out[2].options));
    ok('labels and hints stop at 300 characters', out[3].label.length === 300 && out[3].help.length === 300);
    const many = S.normalizeQuestions(Array.from({ length: 50 }, (_, i) => ({ type: 'short_text', label: 'Q' + i })));
    ok('a survey stops at 40 questions', many.length === 40);
    ok('generated ids are unique', new Set(many.map(q => q.id)).size === 40);
    const opts = S.normalizeQuestions([{ type: 'multi_choice', label: 'Lots', options: Array.from({ length: 20 }, (_, i) => 'Option ' + i + ' ' + 'z'.repeat(200)) }])[0];
    ok('a choice keeps at most 12 options of 120 characters', opts.options.length === 12 && opts.options.every(o => o.length <= 120));
    ok('a non-array input is an empty list, not a crash', S.normalizeQuestions(null).length === 0 && S.normalizeQuestions('x').length === 0);
    ok('the stored shape round-trips unchanged', JSON.stringify(S.normalizeQuestions(mkSurvey().questions)) === JSON.stringify(mkSurvey().questions));
    const fresh = S.TYPE_KEYS.map(t => S.newQuestion(t));
    ok('a new question of every type is already valid', fresh.every(q => S.cleanQuestion(q).question) && fresh.every((q, i) => q.type === S.TYPE_KEYS[i]));
    ok('a new choice question starts with two options, others with none', S.newQuestion('single_choice').options.length === 2 && !('options' in S.newQuestion('rating')));
    ok('an unknown type becomes a short answer', S.newQuestion('bogus').type === 'short_text');
    ok('a new question avoids ids already taken', (() => { const taken = []; for (let i = 0; i < 200; i++) taken.push(S.newQuestion('rating', taken).id); return new Set(taken).size === 200; })());
  }

  // -------------------------------------------------------------------------
  console.log('\nThe public form becomes the answers object survey_submit expects:');
  {
    const qs = [
      { id: 'q1', type: 'short_text', label: 'a', required: false },
      { id: 'q2', type: 'long_text', label: 'b', required: false },
      { id: 'q3', type: 'single_choice', label: 'c', required: true, options: ['A', 'B'] },
      { id: 'q4', type: 'multi_choice', label: 'd', required: false, options: ['X', 'Y', 'Z'] },
      { id: 'q5', type: 'rating', label: 'e', required: true },
      { id: 'q6', type: 'yes_no', label: 'f', required: false }
    ];
    const a = S.collectAnswers(qs, { a: { q1: '  hi  ', q2: 'line one\r\nline two', q3: 'A', q4: 'Y', q5: '4', q6: 'yes', qX: 'ignored' } });
    ok('text is trimmed and keeps its line breaks', a.q1 === 'hi' && a.q2 === 'line one\nline two');
    ok('one ticked checkbox is still a list', JSON.stringify(a.q4) === '["Y"]');
    ok('a rating is a number', a.q5 === 4);
    ok('answers to questions the survey does not ask are dropped', !('qX' in a));
    const b = S.collectAnswers(qs, { a: { q1: '   ', q4: ['X', 'Nope', 'X', 'Z'], q5: '9', q3: ['A'] } });
    ok('blank text, an out-of-range rating and a malformed choice are left out', !('q1' in b) && !('q5' in b) && !('q3' in b));
    ok('checkboxes keep only real options, once each', JSON.stringify(b.q4) === '["X","Z"]');
    ok('the required questions without an answer are named', JSON.stringify(S.missingRequired(qs, b)) === '["q3","q5"]');
    ok('a long answer is cut to what the database keeps', S.collectAnswers(qs, { a: { q1: 'x'.repeat(500) } }).q1.length === 300);
    ok('a body without answers is an empty object', JSON.stringify(S.collectAnswers(qs, {})) === '{}' && JSON.stringify(S.collectAnswers(qs, { a: 'x' })) === '{}');
  }

  // -------------------------------------------------------------------------
  console.log('\nThe results add up:');
  {
    const qs = [
      { id: 'q1', type: 'single_choice', label: 'Dish', options: ['Soup', 'Salad', 'Pie'] },
      { id: 'q2', type: 'multi_choice', label: 'Extras', options: ['Bread', 'Cheese'] },
      { id: 'q3', type: 'rating', label: 'Rate' },
      { id: 'q4', type: 'yes_no', label: 'Again?' },
      { id: 'q5', type: 'long_text', label: 'Notes' }
    ];
    const rs = [
      { created_at: '2026-11-01T09:00:00Z', answers: { q1: 'Soup', q2: ['Bread', 'Cheese'], q3: 5, q4: 'yes', q5: 'oldest' } },
      { created_at: '2026-11-01T11:00:00Z', answers: { q1: 'Soup', q2: ['Bread'], q3: 4, q4: 'no', q5: 'newest' } },
      { created_at: '2026-11-01T10:00:00Z', answers: { q1: 'Pie', q3: 4, q4: 'yes', q5: 'middle' } },
      { created_at: '2026-11-01T08:00:00Z', answers: { q1: 'Gone option', q3: 7, q5: '   ' } }
    ];
    const [dish, extras, rate, again, notes] = S.aggregate(qs, rs);
    ok('single choice: counts per option', dish.options.map(o => o.count).join() === '2,0,1', dish.options.map(o => o.count).join());
    ok('...percentages of those who answered it', dish.options.map(o => o.pct).join() === '67,0,33' && dish.answered === 3 && dish.skipped === 1);
    ok('an answer to an option that no longer exists is not counted', dish.answered === 3);
    ok('multi choice: each pick counts, so it can pass 100%', extras.options.map(o => o.count).join() === '2,1' && extras.options.map(o => o.pct).join() === '100,50' && extras.answered === 2);
    ok('rating: average to one decimal', rate.average === 4.3, String(rate.average));
    ok('rating: distribution 1..5, out-of-range ignored', rate.distribution.map(d => d.count).join() === '0,0,0,2,1' && rate.answered === 3);
    ok('yes/no: counts and labels', again.options.map(o => o.label + o.count).join() === 'Yes2,No1' && again.options[0].pct === 67);
    ok('written answers, newest first, blanks skipped', notes.texts.map(t => t.text).join() === 'newest,middle,oldest' && notes.kind === 'text');
    const empty = S.aggregate(qs, []);
    ok('no responses: zeros, no average, no division by zero', empty[0].options.every(o => o.count === 0 && o.pct === 0) && empty[2].average === null && empty[4].texts.length === 0);
  }

  // -------------------------------------------------------------------------
  console.log('\nThe CSV is safe to open in a spreadsheet:');
  {
    const qs = [
      { id: 'q1', type: 'short_text', label: 'Name, please' },
      { id: 'q2', type: 'multi_choice', label: 'Extras', options: ['Bread', 'Cheese'] },
      { id: 'q3', type: 'rating', label: 'Rate' }
    ];
    const csv = S.toCsv(qs, [
      { created_at: '2026-11-02T10:00:00Z', answers: { q1: '=HYPERLINK("http://evil","x")', q2: ['Bread', 'Cheese'], q3: 5 } },
      { created_at: '2026-11-01T10:00:00Z', answers: { q1: 'Ann "the cook"\nSmith' } }
    ]);
    const lines = csv.split('\r\n');
    ok('a header of question labels and submitted_at', lines[0] === '"Name, please",Extras,Rate,submitted_at', lines[0]);
    ok('rows are oldest first and lines end CRLF', lines[1].startsWith('"Ann') && csv.endsWith('\r\n'));
    ok('quotes are doubled and a newline stays inside its quoted cell', csv.includes('"Ann ""the cook""\nSmith",,,2026-11-01T10:00:00.000Z'));
    ok('a formula is neutralised with a leading quote', csv.includes('"\'=HYPERLINK(""http://evil"",""x"")"'));
    ok('checkbox answers share one cell', csv.includes(',Bread; Cheese,5,'));
    ok('+ - @ are neutralised too', S.csvCell('+1') === "'+1" && S.csvCell('-2') === "'-2" && S.csvCell('@SUM(A1)') === "'@SUM(A1)" && S.csvCell('\tx') === "'\tx");
    ok('ordinary values are left alone', S.csvCell('Soup') === 'Soup' && S.csvCell(4) === '4' && S.csvCell(null) === '' && S.csvCell('a=b') === 'a=b');
    ok('a formula label in the header is neutralised as well', S.toCsv([{ id: 'q', type: 'short_text', label: '=1+1' }], []).startsWith("'=1+1,submitted_at"));
    ok('the file is named after the survey', S.slug('My Café: Survey #1!') === 'my-cafe-survey-1' && S.slug('***') === 'survey');
  }

  // -------------------------------------------------------------------------
  console.log('\nA visitor key is stable per browser and per survey:');
  {
    const c = 'ab'.repeat(32);
    const k = S.visitorKey(c, SID);
    ok('the same cookie and survey give the same key', k === S.visitorKey(c, SID));
    ok('it is sha256 of cookie:surveyId, as hex', k === require('crypto').createHash('sha256').update(c + ':' + SID).digest('hex') && /^[a-f0-9]{64}$/.test(k));
    ok('another survey gives another key', k !== S.visitorKey(c, '99999999-2222-4333-8444-555555555555'));
  }

  // -------------------------------------------------------------------------
  console.log('\nThe builder:');
  const { router, publicRouter, _test } = require('../src/routes/surveys');
  {
    const sb = fakeSb({ tables: { surveys: { data: null, error: { code: '42703', message: 'column surveys.share_code does not exist' } } } });
    const r = await run(router, 'GET', '/', { sb });
    ok('before the migration, the list says surveys are being set up', r.view === 'surveys/index' && r.data.notReady === true);
    ok('...and so does a missing function or table', _test.notReady({ code: 'PGRST202' }) && _test.notReady({ code: '42P01' }) && _test.notReady({ message: 'Could not find the function public.survey_public' }) && !_test.notReady({ code: '23505' }) && !_test.notReady(null));
  }
  {
    const sb = fakeSb({ tables: { surveys: { data: [mkSurvey()], error: null } } });
    const r = await run(router, 'GET', '/', { sb });
    const q = sb.calls.find(c => c.table === 'surveys');
    ok('the list shows my surveys, archived hidden by default', r.view === 'surveys/index' && r.data.surveys.length === 1 &&
       q.filters.some(f => f[1] === 'creator_id' && f[2] === 'me') && q.filters.some(f => f[0] === 'neq' && f[2] === 'archived'));
    const r2 = await run(router, 'GET', '/', { sb, query: { show: 'archived' } });
    ok('...and the Archived filter shows them', r2.data.show === 'archived');
  }
  {
    const sb = fakeSb();
    const r = await run(router, 'POST', '/', { body: { title: '   ' }, sb });
    ok('a survey without a title is refused', /^\/surveys\/new\?err=/.test(r.redirect || '') && !sb.writes.length);
  }
  {
    const sb = fakeSb({ tables: { surveys: { data: { id: SID }, error: null } } });
    const r = await run(router, 'POST', '/', { body: { title: 'Menu feedback', description: 'Why we ask', creator_id: 'someone-else', status: 'active', xp_reward: 9 }, sb });
    const w = sb.writes.find(x => x.table === 'surveys');
    ok('a new survey is a draft, owned by the member, with a first question', !!w && w.op === 'insert' && w.payload.creator_id === 'me' && w.payload.status === 'draft' && w.payload.questions.length === 1);
    ok('...never writing the legacy columns', LEGACY.every(c => !(c in w.payload)));
    ok('...and the member lands in the builder', r.redirect === `/surveys/${SID}/edit`);
  }
  {
    const sb = fakeSb({ tables: { surveys: { data: null, error: { code: '23514', message: 'new row for relation "surveys" violates check constraint "surveys_status_check"' } } } });
    const r = await run(router, 'POST', '/', { body: { title: 'Early bird' }, sb });
    ok('creating before the migration goes to the being-set-up page, not an error', r.redirect === '/surveys');
  }
  {
    const sb = fakeSb();
    const r = await run(router, 'GET', '/not-a-uuid/edit', { sb });
    ok('a malformed id is a 404 without asking the database', r.view === 'error' && r.status === 404 && !sb.calls.length);
    const sb2 = fakeSb({ tables: { surveys: { data: null, error: null } } });
    const r2 = await run(router, 'GET', `/${SID}/edit`, { sb: sb2 });
    ok('someone else\'s survey is a 404 (looked up with my id as creator)', r2.view === 'error' && r2.status === 404 && sb2.calls[0].filters.some(f => f[1] === 'creator_id' && f[2] === 'me'));
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r = await run(router, 'GET', `/${SID}/edit`, { sb });
    ok('the builder renders with the survey', r.view === 'surveys/edit' && r.data.survey.id === SID && r.data.locked === false);
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r = await run(router, 'POST', `/${SID}/questions`, { body: { type: 'yes_no', title: 'Menu feedback v2', q: { qaaaa: { label: 'Your first name?', type: 'short_text' } } }, sb });
    const w = lastUpdate(sb);
    ok('adding a question appends one of that type', !!w && w.payload.questions.length === 4 && w.payload.questions[3].type === 'yes_no');
    ok('...keeps what was typed elsewhere on the page', w.payload.title === 'Menu feedback v2' && w.payload.questions[0].label === 'Your first name?');
    ok('...unticked Required boxes read as not required', w.payload.questions[0].required === false);
    ok('...is saved as my survey only', w.filters.some(f => f[1] === 'creator_id' && f[2] === 'me') && w.filters.some(f => f[1] === 'id' && f[2] === SID));
    ok('...and jumps to the new question', new RegExp(`^/surveys/${SID}/edit\\?msg=.*#q-q[a-z0-9]{4}$`).test(r.redirect), r.redirect);
    ok('builder writes never touch the legacy columns or the status', LEGACY.concat('status', 'creator_id').every(c => !(c in w.payload)));
  }
  {
    const full = mkSurvey({ questions: Array.from({ length: 40 }, (_, i) => ({ id: 'q' + String(i).padStart(4, '0'), type: 'short_text', label: 'Q' + i, required: false })) });
    const sb = fakeSb({ tables: { surveys: surveysTable(full) } });
    const r = await run(router, 'POST', `/${SID}/questions`, { body: { type: 'rating' }, sb });
    ok('a 41st question is refused', /err=/.test(r.redirect) && lastUpdate(sb).payload.questions.length === 40);
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r = await run(router, 'POST', `/${SID}/questions/qbbbb`, { body: { q: { qbbbb: { label: 'Best dish?', type: 'multi_choice', options: 'Soup\nStew', required: 'on', help: 'Pick any' } } }, sb });
    const q = lastUpdate(sb).payload.questions[1];
    ok('a question is updated: text, hint, type, options, required', q.label === 'Best dish?' && q.help === 'Pick any' && q.type === 'multi_choice' && q.options.join() === 'Soup,Stew' && q.required === true);
    ok('...and the page comes back to it', /#q-qbbbb$/.test(r.redirect) && /msg=/.test(r.redirect));
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    await run(router, 'POST', `/${SID}/save`, { body: { q: { qaaaa: { label: 'Pick one', type: 'single_choice' } } }, sb });
    const q = lastUpdate(sb).payload.questions[0];
    ok('switching a text question to a choice starts it with two options', q.type === 'single_choice' && q.options.length === 2);
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r = await run(router, 'POST', `/${SID}/save`, { body: { title: 'Renamed', q: { qbbbb: { label: 'Dish', type: 'single_choice', options: 'Only one' }, qcccc: { label: 'Rate the service' } } }, sb });
    const w = lastUpdate(sb).payload;
    ok('a choice with one option keeps its stored version and says why', /err=/.test(r.redirect) && w.questions[1].options.length === 3 && w.questions[1].label === 'Favourite dish?');
    ok('...while everything else is saved', w.title === 'Renamed' && w.questions[2].label === 'Rate the service');
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey({ response_count: 3, status: 'active', share_code: 'abcdefghij12' })) } });
    await run(router, 'POST', `/${SID}/save`, { body: { q: { qbbbb: { label: 'Favourite dish now?', type: 'yes_no', options: 'A\nB' } } }, sb });
    const q = lastUpdate(sb).payload.questions[1];
    ok('once answers are in, type and options are locked but the wording can change', q.type === 'single_choice' && q.options.join() === 'Soup,Salad,Pie' && q.label === 'Favourite dish now?');
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    await run(router, 'POST', `/${SID}/save`, { body: { max_responses: '50000', deadline: '2026-12-31', description: '' }, sb });
    const w = lastUpdate(sb).payload;
    ok('the cap is kept within 1–10000, the deadline saved, an empty intro cleared', w.max_responses === 10000 && w.deadline === '2026-12-31' && w.description === null);
    const sb2 = fakeSb({ tables: { surveys: surveysTable(mkSurvey({ deadline: '2026-12-01' })) } });
    const r2 = await run(router, 'POST', `/${SID}/save`, { body: { max_responses: '0', deadline: 'soon' }, sb: sb2 });
    const w2 = lastUpdate(sb2).payload;
    ok('a cap of 0 becomes 1; a bad deadline is refused and the old one kept', w2.max_responses === 1 && !('deadline' in w2) && /err=/.test(r2.redirect));
    const sb3 = fakeSb({ tables: { surveys: surveysTable(mkSurvey({ deadline: '2026-12-01' })) } });
    await run(router, 'POST', `/${SID}/save`, { body: { deadline: '' }, sb: sb3 });
    ok('clearing the deadline removes it', lastUpdate(sb3).payload.deadline === null);
  }
  {
    const order = async (qid, dir) => {
      const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
      await run(router, 'POST', `/${SID}/questions/${qid}/move`, { body: { dir }, sb });
      return lastUpdate(sb).payload.questions.map(q => q.id).join();
    };
    ok('move up', await order('qbbbb', 'up') === 'qbbbb,qaaaa,qcccc');
    ok('move down', await order('qbbbb', 'down') === 'qaaaa,qcccc,qbbbb');
    ok('the first cannot go up, the last cannot go down', await order('qaaaa', 'up') === 'qaaaa,qbbbb,qcccc' && await order('qcccc', 'down') === 'qaaaa,qbbbb,qcccc');
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r = await run(router, 'POST', `/${SID}/questions/qbbbb/delete`, { sb });
    ok('a question is deleted', lastUpdate(sb).payload.questions.map(q => q.id).join() === 'qaaaa,qcccc' && /msg=/.test(r.redirect));
    const sb2 = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r2 = await run(router, 'POST', `/${SID}/questions/qzzzz/delete`, { sb: sb2 });
    ok('deleting a question that is gone says so', /err=/.test(r2.redirect) && lastUpdate(sb2).payload.questions.length === 3);
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey({ questions: [] })) } });
    const r = await run(router, 'POST', `/${SID}/publish`, { sb });
    ok('a survey with no questions cannot be published', /err=/.test(r.redirect) && !('status' in lastUpdate(sb).payload));
  }
  {
    const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r = await run(router, 'POST', `/${SID}/publish`, { sb });
    const w = lastUpdate(sb).payload;
    ok('publishing opens the survey and gives it a share code', w.status === 'active' && S.SHARE_CODE_RE.test(w.share_code) && w.share_code.length === 16);
    ok('...and goes to the results page with the link', new RegExp(`^/surveys/${SID}\\?msg=`).test(r.redirect));
    const sb2 = fakeSb({ tables: { surveys: surveysTable(mkSurvey({ status: 'closed', share_code: 'keepThisCode1' })) } });
    await run(router, 'POST', `/${SID}/publish`, { sb: sb2 });
    ok('...keeping a share code it already has, so old links still work', lastUpdate(sb2).payload.share_code === 'keepThisCode1');
    const sb3 = fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } });
    const r3 = await run(router, 'POST', `/${SID}/publish`, { body: { q: { qbbbb: { label: 'Dish', options: 'One' } } }, sb: sb3 });
    ok('a survey with a broken question is not published until it is fixed', /err=/.test(r3.redirect) && !('status' in lastUpdate(sb3).payload));
  }
  {
    let n = 0;
    const sb = fakeSb({ tables: { surveys: st => (st.op === 'select' ? { data: mkSurvey(), error: null } : (++n === 1 ? { error: { code: '23505', message: 'duplicate key value violates unique constraint "surveys_share_code"' } } : { error: null })) } });
    const r = await run(router, 'POST', `/${SID}/publish`, { sb });
    const ups = sb.writes.filter(w => w.op === 'update');
    ok('a share code that collides is replaced and the publish retried', ups.length === 2 && ups[0].payload.share_code !== ups[1].payload.share_code && /msg=/.test(r.redirect));
  }
  {
    const status = async (from, action, extra = {}) => {
      const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey(Object.assign({ status: from }, extra))) } });
      const r = await run(router, 'POST', `/${SID}/${action}`, { sb });
      const w = lastUpdate(sb);
      return { r, status: w ? w.payload.status : null };
    };
    ok('close an open survey', (await status('active', 'close')).status === 'closed');
    ok('a draft cannot be closed', (await status('draft', 'close')).status === null);
    ok('reopen a closed survey', (await status('closed', 'reopen', { share_code: 'abcdefghij12' })).status === 'active');
    ok('reopening an archived draft makes it a draft again', (await status('archived', 'reopen')).status === 'draft');
    ok('an open survey is not "reopened"', (await status('active', 'reopen')).status === null);
    ok('archive', (await status('active', 'archive')).status === 'archived');
  }
  {
    const del = async (over, body = {}) => {
      const sb = fakeSb({ tables: { surveys: surveysTable(mkSurvey(over)) } });
      const r = await run(router, 'POST', `/${SID}/delete`, { sb, body });
      return { r, deleted: sb.writes.find(w => w.op === 'delete') };
    };
    const a = await del({ status: 'draft' });
    ok('a draft with no answers is deleted straight away', !!a.deleted && /^\/surveys\?msg=/.test(a.r.redirect) && a.deleted.filters.some(f => f[1] === 'creator_id'));
    const b = await del({ status: 'active', response_count: 4 });
    ok('a published survey needs the confirm box', !b.deleted && /err=/.test(b.r.redirect));
    const c = await del({ status: 'closed', response_count: 4 }, { confirm: 'yes' });
    ok('...and is deleted with it', !!c.deleted);
  }
  {
    process.env.SITE_URL = 'https://staging.example/';
    const survey = mkSurvey({ status: 'active', share_code: 'abcdefghij12', response_count: 2 });
    const rows = [
      { id: 'r1', created_at: '2026-11-01T11:00:00Z', answers: { qaaaa: 'ana@example.com', qbbbb: 'Soup', qcccc: 5 } },
      { id: 'r2', created_at: '2026-11-01T12:00:00Z', answers: { qbbbb: 'Pie', qcccc: 3 } }
    ];
    const sb = fakeSb({ tables: { surveys: surveysTable(survey), survey_responses: { data: rows, error: null } } });
    const r = await run(router, 'GET', `/${SID}`, { sb });
    ok('the results page has the full share link from SITE_URL', r.view === 'surveys/results' && r.data.shareUrl === 'https://staging.example/s/abcdefghij12', r.data.shareUrl);
    ok('...the count and a summary per question', r.data.total === 2 && r.data.summary.length === 3 && r.data.summary[2].average === 4);
    ok('...and an email a customer left is shown to the creator as written', r.data.summary[0].texts[0].text === 'ana@example.com');
    delete process.env.SITE_URL;
    const r2 = await run(router, 'GET', `/${SID}`, { sb });
    ok('without SITE_URL the link is on nobossly.com', r2.data.shareUrl === 'https://nobossly.com/s/abcdefghij12');
    const rq = sb.calls.find(c => c.table === 'survey_responses');
    ok('responses are read for this survey only', rq.filters.some(f => f[1] === 'survey_id' && f[2] === SID));

    const csv = await run(router, 'GET', `/${SID}/export.csv`, { sb });
    ok('the export is a CSV download named after the survey', /^text\/csv/.test(csv.headers['content-type']) && csv.headers['content-disposition'] === 'attachment; filename="menu-feedback-responses.csv"', csv.headers['content-disposition']);
    ok('...with a header and one row per response', csv.body.replace('﻿', '').split('\r\n').filter(Boolean).length === 3 && csv.body.includes('ana@example.com'));
  }
  {
    // A survey with more than a page of answers is read a page at a time.
    let pages = 0;
    const sb = fakeSb({ tables: { survey_responses: () => ({ data: Array.from({ length: pages++ < 2 ? 1000 : 10 }, (_, i) => ({ id: 'r' + i, answers: {}, created_at: '2026-11-01T10:00:00Z' })), error: null }) } });
    const { responses } = await _test.allResponses(sb, SID, 10000);
    ok('responses past the first thousand are fetched too', responses.length === 2010 && pages === 3, String(responses.length));
  }

  // -------------------------------------------------------------------------
  console.log('\nThe public link (no account needed):');
  const supa = require('../src/supabase');
  const CODE = 'abcdefghij12';
  const pub = (over = {}) => Object.assign({ id: SID, title: 'Menu feedback', description: 'Two minutes.', status: 'active', by: 'Ana', questions: mkSurvey().questions }, over);
  {
    const sb = fakeSb();
    const r = await run(publicRouter, 'GET', '/not%20a%20code', { sb, user: null });
    ok('a malformed code is "not open" without asking the database', r.view === 'surveys/public' && r.status === 404 && r.data.survey === null && !sb.calls.length);
    const sb2 = fakeSb({ rpc: { survey_public: { data: null, error: null } } });
    const r2 = await run(publicRouter, 'GET', '/' + CODE, { sb: sb2, user: null });
    ok('a draft, archived or unknown survey is "not open"', r2.status === 404 && r2.data.survey === null);
    const sb3 = fakeSb({ rpc: { survey_public: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.survey_public(p_code) in the schema cache' } } } });
    const r3 = await run(publicRouter, 'GET', '/' + CODE, { sb: sb3, user: null });
    ok('before the migration it says surveys are being set up', r3.data.notReady === true && r3.status === 200);
  }
  {
    // Signed out there is no req.sb: the anonymous client is used.
    const anon = fakeSb({ rpc: { survey_public: { data: pub(), error: null } } });
    const real = supa.anonClient;
    supa.anonClient = () => anon;
    try {
      const r = await run(publicRouter, 'GET', '/' + CODE, { sb: undefined, user: null });
      ok('signed out, the survey renders through the anonymous client', r.view === 'surveys/public' && r.data.survey.title === 'Menu feedback' && anon.calls.some(c => c.rpc === 'survey_public' && c.args.p_code === CODE));
    } finally { supa.anonClient = real; }
  }
  const submit = async (result, { body, cookies = {}, headers = {}, survey = pub() } = {}) => {
    const sb = fakeSb({ rpc: { survey_public: { data: survey, error: null }, survey_submit: typeof result === 'object' ? result : { data: result, error: null } } });
    const r = await run(publicRouter, 'POST', '/' + CODE, { sb, user: null, cookies, headers, body: body || { a: { qaaaa: 'Ana', qbbbb: 'Soup', qcccc: '5' } } });
    return { r, sb, call: sb.calls.find(c => c.rpc === 'survey_submit') };
  };
  {
    const { r, call } = await submit('ok');
    ok('ok: on to the thank-you page', r.redirect === `/s/${CODE}/done`);
    ok('...answers sent shaped for the database (rating as a number)', call && call.args.p_code === CODE && call.args.p_answers.qcccc === 5 && call.args.p_answers.qbbbb === 'Soup');
    const set = r.cookies.find(c => c.name === 'nb_visitor');
    ok('a first-time visitor gets a random year-long cookie', !!set && /^[a-f0-9]{64}$/.test(set.value) && set.opts.httpOnly === true && set.opts.sameSite === 'lax' && set.opts.maxAge === 365 * 24 * 3600 * 1000);
    ok('...over plain http it is not marked secure', set.opts.secure === false);
    ok('...and the database gets a per-survey hash of it, not the cookie', call.args.p_visitor === S.visitorKey(set.value, SID) && call.args.p_visitor !== set.value);
  }
  {
    const have = 'cd'.repeat(32);
    const { r, call } = await submit('ok', { cookies: { nb_visitor: have } });
    ok('a returning visitor keeps their cookie', !r.cookies.length && call.args.p_visitor === S.visitorKey(have, SID));
    const { r: r2 } = await submit('ok', { cookies: { nb_visitor: 'tampered' } });
    ok('a malformed cookie is replaced', r2.cookies.length === 1);
    const { r: r3 } = await submit('ok', { headers: { 'x-forwarded-proto': 'https' } });
    ok('behind https the cookie is secure', r3.cookies[0].opts.secure === true);
  }
  {
    const { call } = await submit('ok', { body: { a: { qbbbb: 'Soup', qaaaa: '' } }, survey: pub({ questions: mkSurvey().questions.concat({ id: 'qdddd', type: 'multi_choice', label: 'x', required: false, options: ['A', 'B'] }) }) });
    ok('checkboxes are sent as a list even when the form sent none', call && !('qdddd' in call.args.p_answers) && !('qaaaa' in call.args.p_answers));
    const { call: c2 } = await submit('ok', { body: { a: { qbbbb: 'Soup', qdddd: ['A', 'B'] } }, survey: pub({ questions: mkSurvey().questions.concat({ id: 'qdddd', type: 'multi_choice', label: 'x', required: false, options: ['A', 'B'] }) }) });
    ok('...and as a list when ticked', JSON.stringify(c2.args.p_answers.qdddd) === '["A","B"]');
  }
  for (const res of ['duplicate', 'closed', 'full']) {
    const { r } = await submit(res);
    ok(`${res}: the done page says so`, r.redirect === `/s/${CODE}/done?r=${res}`);
  }
  {
    const { r } = await submit('missing', { body: { a: { qaaaa: 'Ana' } } });
    ok('missing: the form again (422), with what they typed and the unanswered question marked',
       r.view === 'surveys/public' && r.status === 422 && r.data.values.qaaaa === 'Ana' && r.data.missingIds.join() === 'qbbbb' && /required/.test(r.data.problem));
    const { r: r2 } = await submit('invalid');
    ok('invalid: the form again (422) with a message', r2.status === 422 && /check them/.test(r2.data.problem) && r2.data.values.qbbbb === 'Soup');
    const { r: r3 } = await submit('surprise');
    ok('anything else: the form again with a try-again message, never a crash', r3.view === 'surveys/public' && r3.status === 503 && /try again/.test(r3.data.problem));
    const { r: r4 } = await submit({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.survey_submit' } });
    ok('before the migration, sending says surveys are being set up', r4.data.notReady === true);
  }
  {
    const { r, call } = await submit('ok', { survey: pub({ status: 'closed' }) });
    ok('a closed survey does not try to submit', r.redirect === `/s/${CODE}/done?r=closed` && !call);
  }
  {
    const sb = fakeSb({ rpc: { survey_public: { data: pub(), error: null } } });
    const r = await run(publicRouter, 'GET', `/${CODE}/done`, { sb, user: null, query: { r: 'duplicate' } });
    ok('the done page renders the right message', r.view === 'surveys/thanks' && r.data.result === 'duplicate' && r.data.surveyTitle === 'Menu feedback');
    const r2 = await run(publicRouter, 'GET', `/${CODE}/done`, { sb, user: null, query: { r: '<script>' } });
    ok('...and an unknown result is a plain thank-you', r2.data.result === 'ok');
  }

  // -------------------------------------------------------------------------
  console.log('\nEvery view renders:');
  {
    const V = f => path.join(ROOT, 'views', 'surveys', f);
    const files = fs.readdirSync(path.join(ROOT, 'views', 'surveys')).filter(f => f.endsWith('.ejs'));
    ok('six survey views', ['index', 'new', 'edit', 'results', 'public', 'thanks'].every(n => files.includes(n + '.ejs')), files.join(', '));
    for (const f of files) {
      let compiled = true, err;
      try { ejs.compile(fs.readFileSync(V(f), 'utf8'), { filename: V(f) }); } catch (e) { compiled = false; err = e.message.split('\n')[0]; }
      ok(`${f} compiles`, compiled, err);
    }
    const base = {
      title: 'T', user: { id: 'me' }, profile: { id: 'me', username: 'me' }, plan: 'paid', currentPath: '/surveys', canonicalUrl: 'x',
      unreadCount: 0, unreadMsgs: 0, metaDescription: '', bodyTheme: '', settings: {}, pendingDeletion: null, reactivated: false,
      isPremium: true, flags: FLAGS, flashErr: null, premiumTools: [],
      affiliates: { forTitle: () => [], forPath: () => [], forText: () => [], any: () => false }
    };
    const signedOut = Object.assign({}, base, { user: null, profile: null, plan: 'free' });
    const render = (f, data, who = base) => { try { return ejs.render(fs.readFileSync(V(f), 'utf8'), Object.assign({}, who, data), { filename: V(f) }); } catch (e) { return 'RENDER ERROR ' + e.message; } };
    const text = h => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');

    // Drive the real routes and render what they hand the view, so a local a
    // route forgets to pass shows up here.
    const via = async (router2, method, url, opts, who) => { const r = await run(router2, method, url, opts); return { r, html: render(r.view.replace('surveys/', '') + '.ejs', r.data, who) }; };

    const surveyRow = mkSurvey({ status: 'active', share_code: CODE, response_count: 3, deadline: '2026-12-31' });
    let h = (await via(router, 'GET', '/', { sb: fakeSb({ tables: { surveys: { data: [surveyRow, mkSurvey({ id: 'x2', status: 'draft' })], error: null } } }), query: { msg: 'Survey deleted.' } })).html;
    ok('index: lists surveys with status, counts and links', h.includes('Menu feedback') && h.includes('3 / 1000 responses') && h.includes(`/surveys/${SID}/edit`) && h.includes('Survey deleted.') && h.includes('/s/' + CODE));
    h = (await via(router, 'GET', '/', { sb: fakeSb({ tables: { surveys: { data: [], error: null } } }) })).html;
    ok('index: an empty list invites a first survey', h.includes('No surveys yet'));
    h = (await via(router, 'GET', '/', { sb: fakeSb({ tables: { surveys: { data: null, error: { code: '42P01', message: 'x' } } } }) })).html;
    ok('index: being set up', text(h).includes('Surveys are being set up') && text(h).includes('Check back shortly'));
    h = (await via(router, 'GET', '/new', {})).html;
    ok('new: a title and intro form', h.includes('action="/surveys"') && h.includes('name="title"') && h.includes('name="description"'));

    h = (await via(router, 'GET', `/${SID}/edit`, { sb: fakeSb({ tables: { surveys: surveysTable(mkSurvey()) } }) })).html;
    ok('edit: every question with its fields', h.includes('name="q[qbbbb][label]"') && h.includes('name="q[qbbbb][options]"') && h.includes('Soup\nSalad\nPie') && h.includes('name="q[qcccc][required]"'));
    ok('edit: move, delete and add work as plain form buttons', h.includes(`formaction="/surveys/${SID}/questions/qbbbb/move"`) && h.includes(`formaction="/surveys/${SID}/questions/qbbbb/delete"`) && h.includes(`formaction="/surveys/${SID}/questions" name="type" value="rating"`));
    ok('edit: a draft can be published', h.includes(`formaction="/surveys/${SID}/publish"`));
    ok('edit: the first question cannot move up', /value="up" disabled/.test(h));
    h = (await via(router, 'GET', `/${SID}/edit`, { sb: fakeSb({ tables: { surveys: surveysTable(surveyRow) } }) })).html;
    ok('edit: once answered, type and options are locked', /name="q\[qbbbb\]\[options\]"[^>]*disabled/.test(h) && /name="q\[qbbbb\]\[type\]" disabled/.test(h) && !h.includes('/publish"'));

    const rows = [
      { id: 'r1', created_at: '2026-11-01T11:00:00Z', answers: { qaaaa: 'Ana <b>bold</b>', qbbbb: 'Soup', qcccc: 5 } },
      { id: 'r2', created_at: '2026-11-01T12:00:00Z', answers: { qbbbb: 'Pie', qcccc: 3 } }
    ];
    h = (await via(router, 'GET', `/${SID}`, { sb: fakeSb({ tables: { surveys: surveysTable(surveyRow), survey_responses: { data: rows, error: null } } }) })).html;
    ok('results: the share link with a copy button', h.includes('https://nobossly.com/s/' + CODE) && h.includes('data-copy="#sv-link"'));
    ok('results: response count against the cap, and the export', text(h).includes('2') && text(h).includes('of 1000') && h.includes(`/surveys/${SID}/export.csv`));
    ok('results: a bar per option and the average rating', h.includes('style="width:50%"') && text(h).includes('Average') && text(h).includes('4'));
    ok('results: written answers are shown, escaped', h.includes('Ana &lt;b&gt;bold&lt;/b&gt;'));
    ok('results: close, archive and delete with confirm', h.includes(`/surveys/${SID}/close`) && h.includes(`/surveys/${SID}/archive`) && h.includes('name="confirm" value="yes"'));
    const many = Array.from({ length: 205 }, (_, i) => ({ id: 'r' + i, created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), answers: { qaaaa: 'answer ' + i } }));
    h = (await via(router, 'GET', `/${SID}`, { sb: fakeSb({ tables: { surveys: surveysTable(surveyRow), survey_responses: { data: many, error: null } } }) })).html;
    ok('results: written answers stop at 200 with a note pointing to the CSV', (h.match(/class="sv-text"/g) || []).length === 200 && text(h).includes('Showing the newest 200 of 205'));
    h = (await via(router, 'GET', `/${SID}`, { sb: fakeSb({ tables: { surveys: surveysTable(mkSurvey()), survey_responses: { data: [], error: null } } }) })).html;
    ok('results: a draft says to publish to get a link', text(h).includes('Publish the survey to get a link') && text(h).includes('No answers yet'));

    const pubSb = fakeSb({ rpc: { survey_public: { data: pub({ questions: mkSurvey().questions.concat(
      { id: 'qdddd', type: 'multi_choice', label: 'Extras', required: false, options: ['Bread', 'Cheese'] },
      { id: 'qeeee', type: 'yes_no', label: 'Again?', required: false, help: 'Be honest' },
      { id: 'qffff', type: 'long_text', label: 'Anything else?', required: false }) }), error: null } } });
    h = (await via(publicRouter, 'GET', '/' + CODE, { sb: pubSb, user: null }, signedOut)).html;
    ok('public: renders signed out, with every kind of input', !h.startsWith('RENDER ERROR') && h.includes('name="a[qaaaa]"') && h.includes('type="radio" name="a[qbbbb]" value="Soup"') &&
       h.includes('name="a[qdddd][]" value="Bread"') && h.includes('name="a[qcccc]" value="5"') && h.includes('name="a[qeeee]" value="yes"') && h.includes('<textarea name="a[qffff]"'));
    ok('public: posts back to its own link, shows the intro, the hint and who it is from', h.includes(`action="/s/${CODE}"`) && text(h).includes('Two minutes.') && text(h).includes('Be honest') && text(h).includes('From Ana'));
    ok('public: no member menu for a signed-out visitor', !h.includes('id="avatar-menu"'));
    const missingRun = await run(publicRouter, 'POST', '/' + CODE, { sb: fakeSb({ rpc: { survey_public: { data: pub(), error: null }, survey_submit: { data: 'missing', error: null } } }), user: null, body: { a: { qaaaa: 'Ana "quoted"', qcccc: '4' } } });
    h = render('public.ejs', missingRun.data, signedOut);
    ok('public: a re-shown form keeps what they typed and marks the missing answer', h.includes('value="Ana &#34;quoted&#34;"') && /value="4" checked/.test(h) && h.includes('Please answer this one.') && text(h).includes('Please answer the questions marked required.'));
    h = (await via(publicRouter, 'GET', '/' + CODE, { sb: fakeSb({ rpc: { survey_public: { data: null, error: null } } }), user: null }, signedOut)).html;
    ok('public: "This survey isn\'t open"', text(h).includes('This survey isn\'t open'));
    h = (await via(publicRouter, 'GET', '/' + CODE, { sb: fakeSb({ rpc: { survey_public: { data: pub({ status: 'closed' }), error: null } } }), user: null }, signedOut)).html;
    ok('public: a closed survey says so, with no form', text(h).includes('has closed') && !h.includes('Send answers'));
    for (const r of Object.keys(_test.DONE)) {
      h = (await via(publicRouter, 'GET', `/${CODE}/done`, { sb: fakeSb({ rpc: { survey_public: { data: pub(), error: null } } }), user: null, query: { r } }, signedOut)).html;
      ok(`thanks (${r}) renders signed out`, text(h).includes(_test.DONE[r].head));
    }
  }

  // -------------------------------------------------------------------------
  console.log('\nHygiene:');
  {
    const src = read('src/routes/surveys.js') + read('src/surveys.js');
    ok('no AI anywhere in the survey maker', !/anthropic|openai|\bai\b|claude/i.test(src));
    ok('answers are not run through the contact-detail filter (they are private to the creator)', !/personal_info_filter/.test(src));
    ok('no legacy column is ever written', !/idea_id|xp_reward|target_count/.test(read('src/routes/surveys.js')));
  }

  console.log(fail ? `\n${fail} failed\n` : '\nall passed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
