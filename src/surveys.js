// The survey maker's rules, with no Express and no database in sight, so the
// builder, the public form, the results page and the CSV all agree on one
// shape — and the tests can check it without a server.
//
// A survey's questions are a JSON array stored on the survey row. The database
// (survey_submit in migrations/2026-11-01_workspace_foundations.sql) checks
// every answer against exactly this shape, so the type names here and the ones
// in that SQL must stay the same. test/surveys.js compares them.
//
//   { id: 'q1a2b', type: 'single_choice', label: 'How did you find us?',
//     help: 'Pick the closest', required: true, options: ['Search', 'A friend'] }
//
// Answers are an object keyed by question id: text and single choice are
// strings ('yes' / 'no' for yes_no), multi choice is an array of strings, and a
// rating is a whole number from 1 to 5.
const crypto = require('crypto');

const TYPES = {
  short_text: 'Short answer',
  long_text: 'Long answer',
  single_choice: 'Multiple choice (pick one)',
  multi_choice: 'Checkboxes (pick any)',
  rating: 'Rating (1–5)',
  yes_no: 'Yes / No'
};
const TYPE_KEYS = Object.keys(TYPES);
const CHOICE_TYPES = ['single_choice', 'multi_choice'];

const LIMITS = {
  questions: 40,
  label: 300,
  help: 300,
  options: { min: 2, max: 12, length: 120 },
  title: 160,
  description: 2000,
  maxResponses: { min: 1, max: 10000, default: 1000 },
  // What survey_submit keeps of a written answer; we cut to the same length so
  // what the form re-shows is what would be stored.
  answer: { short_text: 300, long_text: 3000 }
};

// A starting label that tells the member what to type over.
const STARTERS = {
  short_text: 'What is one word you would use to describe us?',
  long_text: 'What could we do better?',
  single_choice: 'How did you hear about us?',
  multi_choice: 'Which of these would you use?',
  rating: 'How likely are you to recommend us?',
  yes_no: 'Would you buy this again?'
};
const STARTER_OPTIONS = ['Option 1', 'Option 2'];

const isChoice = t => CHOICE_TYPES.includes(t);
const typeLabel = t => TYPES[t] || t;

const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// "q" and four random characters, e.g. q1a2b: short enough to read in a CSV
// header or a form field name, and unique within the survey.
function questionId(taken) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  for (;;) {
    let id = 'q';
    for (let i = 0; i < 4; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    if (!used.has(id)) return id;
  }
}

function newQuestion(type, taken) {
  const t = TYPES[type] ? type : 'short_text';
  const q = { id: questionId(taken), type: t, label: STARTERS[t], required: false };
  if (isChoice(t)) q.options = STARTER_OPTIONS.slice();
  return q;
}

const text = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, max);
const truthy = v => v === true || v === 'on' || v === 'true' || v === '1' || v === 1 || v === 'yes';

// Options arrive as an array (stored JSON, or option rows) or as one textarea,
// one per line. Blank lines and repeats go; a repeat that differs only in case
// would be two bars on the chart that mean the same thing, so it goes too.
function cleanOptions(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : [];
  const seen = new Set();
  const out = [];
  for (const o of raw) {
    const v = text(o, LIMITS.options.length);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length === LIMITS.options.max) break;
  }
  return out;
}

// One question, cleaned. Returns { question } or { error } with a sentence a
// member can act on.
function cleanQuestion(input) {
  if (!input || typeof input !== 'object') return { error: 'That question was empty.' };
  const type = String(input.type || '');
  if (!TYPES[type]) return { error: 'Pick a question type.' };
  const label = text(input.label, LIMITS.label);
  if (!label) return { error: 'Every question needs some text.' };
  const q = { id: ID_RE.test(String(input.id || '')) ? String(input.id) : '', type, label, required: truthy(input.required) };
  const help = text(input.help, LIMITS.help);
  if (help) q.help = help;
  if (isChoice(type)) {
    q.options = cleanOptions(input.options);
    if (q.options.length < LIMITS.options.min) return { error: `“${label.slice(0, 60)}” needs at least two different options.` };
  }
  return { question: q };
}

// A whole question list, cleaned: invalid questions are dropped, ids are kept
// when they are well formed and unique and made up otherwise, and the list
// stops at the limit.
function normalizeQuestions(input) {
  const list = Array.isArray(input) ? input : input && typeof input === 'object' ? Object.values(input) : [];
  const out = [];
  const used = new Set();
  for (const item of list) {
    if (out.length === LIMITS.questions) break;
    const { question } = cleanQuestion(item);
    if (!question) continue;
    if (!question.id || used.has(question.id)) question.id = questionId(used);
    used.add(question.id);
    out.push(question);
  }
  return out;
}

// 12 random bytes is 16 url-safe characters: unguessable, and inside the
// database's ^[A-Za-z0-9_-]{10,40}$.
const shareCode = () => crypto.randomBytes(12).toString('base64url');
const SHARE_CODE_RE = /^[A-Za-z0-9_-]{10,40}$/;

// The same browser gets the same key for a survey, so it can answer once; a
// different survey gets a different key, so keys cannot be matched across
// surveys to follow someone around.
const visitorKey = (cookieValue, surveyId) => crypto.createHash('sha256').update(`${cookieValue}:${surveyId}`).digest('hex');

// The public form, read into the answers object survey_submit expects. Only
// the survey's own questions are read; anything blank is left out (the
// database decides whether that is allowed).
function collectAnswers(questions, body) {
  const a = body && typeof body.a === 'object' && body.a ? body.a : {};
  const out = {};
  for (const q of questions || []) {
    if (!Object.prototype.hasOwnProperty.call(a, q.id)) continue;
    const v = a[q.id];
    if (q.type === 'short_text' || q.type === 'long_text') {
      if (typeof v !== 'string') continue;
      // Written answers keep their line breaks; only the ends are trimmed.
      const s = v.replace(/\r\n/g, '\n').trim().slice(0, LIMITS.answer[q.type]);
      if (s) out[q.id] = s;
    } else if (q.type === 'single_choice' || q.type === 'yes_no') {
      if (typeof v === 'string' && v) out[q.id] = v;
    } else if (q.type === 'multi_choice') {
      const picked = (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' && (q.options || []).includes(x));
      if (picked.length) out[q.id] = [...new Set(picked)];
    } else if (q.type === 'rating') {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 5) out[q.id] = n;
    }
  }
  return out;
}

// Which required questions have no answer, so the form can point at them.
function missingRequired(questions, answers) {
  return (questions || []).filter(q => q.required && (answers[q.id] === undefined || (Array.isArray(answers[q.id]) && !answers[q.id].length))).map(q => q.id);
}

const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
const when = r => new Date(r && r.created_at ? r.created_at : 0).getTime() || 0;

// Is this stored answer one the question, as it is now, can count?
function valid(q, v) {
  if (v === undefined || v === null) return false;
  switch (q.type) {
    case 'short_text': case 'long_text': return typeof v === 'string' && v.trim() !== '';
    case 'single_choice': return typeof v === 'string' && (q.options || []).includes(v);
    case 'yes_no': return v === 'yes' || v === 'no';
    case 'multi_choice': return Array.isArray(v) && v.some(x => (q.options || []).includes(x));
    case 'rating': return Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5;
    default: return false;
  }
}

// One summary per question, for the results page.
//   choice / yes_no: options [{ label, value, count, pct }] — pct is of the
//     people who answered that question (so checkboxes can add up past 100%)
//   rating: average (one decimal, or null) and distribution 1..5
//   text: texts [{ text, at }], newest first
function aggregate(questions, responses) {
  const rs = (responses || []).slice().sort((x, y) => when(y) - when(x));
  return (questions || []).map(q => {
    const given = rs.filter(r => valid(q, ((r && r.answers) || {})[q.id]));
    const answered = given.length;
    const s = { id: q.id, type: q.type, label: q.label, required: !!q.required, answered, skipped: rs.length - answered };
    const value = r => r.answers[q.id];
    if (q.type === 'short_text' || q.type === 'long_text') {
      s.kind = 'text';
      s.texts = given.map(r => ({ text: value(r), at: r.created_at || null }));
    } else if (q.type === 'rating') {
      s.kind = 'rating';
      const nums = given.map(r => Number(value(r)));
      s.average = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
      s.distribution = [1, 2, 3, 4, 5].map(v => {
        const count = nums.filter(n => n === v).length;
        return { value: v, label: String(v), count, pct: pct(count, answered) };
      });
    } else {
      s.kind = 'choice';
      const opts = q.type === 'yes_no' ? [['yes', 'Yes'], ['no', 'No']] : (q.options || []).map(o => [o, o]);
      s.options = opts.map(([v, label]) => {
        const count = given.filter(r => (Array.isArray(value(r)) ? value(r).includes(v) : value(r) === v)).length;
        return { value: v, label, count, pct: pct(count, answered) };
      });
    }
    return s;
  });
}

// A spreadsheet opens a cell that starts with = + - or @ as a formula, which
// is how a stranger's answer could run something on the creator's machine.
// A leading quote makes it plain text. Tab and carriage return are on the same
// list in the usual guidance, so they are covered too.
function csvCell(v) {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// One row per response, oldest first, one column per question and then the
// time it came in. RFC 4180: comma separated, CRLF line ends, quotes doubled.
function toCsv(questions, responses) {
  const qs = questions || [];
  const rows = [qs.map(q => q.label).concat('submitted_at')];
  const rs = (responses || []).slice().sort((x, y) => when(x) - when(y));
  for (const r of rs) {
    const a = (r && r.answers) || {};
    rows.push(qs.map(q => a[q.id]).concat(r.created_at ? new Date(r.created_at).toISOString() : ''));
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// "My Customer Survey!" -> "my-customer-survey"
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'survey';

module.exports = {
  TYPES, TYPE_KEYS, CHOICE_TYPES, LIMITS, isChoice, typeLabel,
  newQuestion, questionId, cleanOptions, cleanQuestion, normalizeQuestions,
  shareCode, SHARE_CODE_RE, visitorKey, collectAnswers, missingRequired,
  aggregate, csvCell, toCsv, slug
};
