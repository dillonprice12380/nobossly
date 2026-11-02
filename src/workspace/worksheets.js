// The shared planning worksheets. Each is a list of sections; one engine saves
// any of them to workspace_docs (kind = the worksheet's key) and renders any
// of them. A path config can add its own worksheets the same way (an offer
// builder, an MVP scope) without new storage.
//
// Field types: text, longtext, list (one item per line), rich (formatted
// text: bold, lists, colour — cleaned by ./richtext), score (1–5), money,
// number, date, select.

const matrix = require('./matrix');
const richtext = require('./richtext');

const WORKSHEETS = {
  lean_canvas: {
    label: 'Lean Canvas', emoji: '🧭', layout: 'canvas', multiple: true,
    // The printed poster: the classic Lean Canvas grid (view and PDF).
    poster: {
      columns: 10,
      areas: [
        'problem problem solution solution uvp uvp advantage advantage segments segments',
        'problem problem metrics metrics uvp uvp channels channels segments segments',
        'alternatives alternatives metrics metrics uvp uvp channels channels early_adopters early_adopters',
        'costs costs costs costs costs revenue revenue revenue revenue revenue'
      ]
    },
    blurb: 'Your idea on one page. Best for something new and untested — fill it fast, then test the riskiest box first.',
    sections: [
      { key: 'problem',        label: 'Problem',                 type: 'rich',     help: 'The top three problems your customer has.' },
      { key: 'alternatives',   label: 'Existing alternatives',   type: 'rich',     help: 'How they solve it today — including "a spreadsheet" or "nothing".' },
      { key: 'segments',       label: 'Customer segments',       type: 'rich',     help: 'Who has the problem.' },
      { key: 'early_adopters', label: 'Early adopters',          type: 'rich', help: 'The people who feel it most and would try you first.' },
      { key: 'uvp',            label: 'Unique value proposition', type: 'rich', help: 'One clear sentence: why you, and why it matters to them.' },
      { key: 'solution',       label: 'Solution',                type: 'rich',     help: 'The simplest thing that solves each problem.' },
      { key: 'channels',       label: 'Channels',                type: 'rich',     help: 'How you reach them.' },
      { key: 'revenue',        label: 'Revenue streams',         type: 'rich',     help: 'How you get paid, and roughly how much.' },
      { key: 'costs',          label: 'Cost structure',          type: 'rich',     help: 'What it costs to run.' },
      { key: 'metrics',        label: 'Key metrics',             type: 'rich',     help: 'The few numbers that tell you it is working.' },
      { key: 'advantage',      label: 'Unfair advantage',        type: 'rich', help: 'What cannot easily be copied. "Nothing yet" is an honest answer.' }
    ]
  },

  business_model_canvas: {
    label: 'Business Model Canvas', emoji: '🗺️', layout: 'canvas', multiple: true,
    // The printed poster: the classic nine-block grid (view and PDF).
    poster: {
      columns: 10,
      areas: [
        'partners partners activities activities value value relationships relationships segments segments',
        'partners partners resources resources value value channels channels segments segments',
        'costs costs costs costs costs revenue revenue revenue revenue revenue'
      ]
    },
    blurb: 'The classic nine blocks. Best once you know what you sell and want to see how the whole business fits together.',
    sections: [
      { key: 'partners',      label: 'Key partners',           type: 'rich', help: 'Suppliers, collaborators, people you depend on.' },
      { key: 'activities',    label: 'Key activities',         type: 'rich', help: 'What you must do well, every week.' },
      { key: 'resources',     label: 'Key resources',          type: 'rich', help: 'What you need to have: skills, equipment, money, premises.' },
      { key: 'value',         label: 'Value propositions',     type: 'rich', help: 'What you deliver, and why customers choose it.' },
      { key: 'relationships', label: 'Customer relationships', type: 'rich', help: 'How you win and keep customers.' },
      { key: 'channels',      label: 'Channels',               type: 'rich', help: 'How customers find you, buy, and receive what you sell.' },
      { key: 'segments',      label: 'Customer segments',      type: 'rich', help: 'Who you serve.' },
      { key: 'costs',         label: 'Cost structure',         type: 'rich', help: 'Your biggest costs, fixed and variable.' },
      { key: 'revenue',       label: 'Revenue streams',        type: 'rich', help: 'Every way money comes in, and the price.' }
    ]
  },

  persona: {
    label: 'Customer persona', emoji: '👤', layout: 'form', multiple: true,
    blurb: 'One real-feeling person you are building for. Have more than one? Make one each.',
    titleLabel: 'Give them a name', titlePlaceholder: 'e.g. Busy Bella, the night-shift nurse',
    sections: [
      { key: 'who',        label: 'Who they are',                    type: 'longtext', help: 'Age range, job, situation, where they live.' },
      { key: 'goals',      label: 'What they want',                  type: 'list' },
      { key: 'pains',      label: 'What frustrates them',            type: 'list' },
      { key: 'today',      label: 'What they use or do today',       type: 'longtext' },
      { key: 'hangouts',   label: 'Where you can find them',         type: 'list',     help: 'Online and offline.' },
      { key: 'triggers',   label: 'What would make them buy or switch', type: 'longtext' },
      { key: 'objections', label: 'What would stop them',            type: 'list' },
      { key: 'budget',     label: 'What they would pay',             type: 'text' },
      { key: 'quote',      label: 'In their words',                  type: 'longtext', help: 'Something a real one actually said. Interviews and surveys are the best source.' }
    ]
  },

  business_plan: {
    label: 'Business plan', emoji: '📄', layout: 'form', multiple: true,
    blurb: 'A plan someone can read in ten minutes — a lender, a partner, or you in six months.',
    titleLabel: 'Business name', titlePlaceholder: 'Working name is fine',
    sections: [
      { key: 'summary',      label: 'Summary',                type: 'longtext', help: 'What the business is, who it serves, and why now. Write it last.' },
      { key: 'problem',      label: 'The problem',            type: 'longtext' },
      { key: 'offer',        label: 'What you sell',          type: 'longtext', help: 'Products or services, and prices.' },
      { key: 'market',       label: 'Who buys it',            type: 'longtext', help: 'Your customers and how many of them there are near you or online.' },
      { key: 'competition',  label: 'Competition',            type: 'longtext', help: 'Who else they could buy from, and why they would pick you.' },
      { key: 'marketing',    label: 'Marketing and sales',    type: 'longtext', help: 'How customers find you and decide to buy.' },
      { key: 'operations',   label: 'How it runs',            type: 'longtext', help: 'Delivery, suppliers, premises, hours, tools.' },
      { key: 'team',         label: 'Who is involved',        type: 'longtext' },
      { key: 'milestones',   label: 'Milestones',             type: 'list',     help: 'The next five things that must happen, with rough dates.' },
      { key: 'startup',      label: 'Start-up costs',         type: 'money',    help: 'One-off costs before you can sell.' },
      { key: 'monthly',      label: 'Monthly running costs',  type: 'money' },
      { key: 'revenue_m12',  label: 'Monthly revenue by month 12', type: 'money', help: 'An honest guess.' },
      { key: 'funding',      label: 'Funding needed',         type: 'money' },
      { key: 'funding_use',  label: 'What the funding is for', type: 'longtext' }
    ]
  },

  idea_refiner: {
    label: 'Idea refiner', emoji: '🔬', layout: 'form', multiple: true,
    blurb: 'Pressure-test an idea before you spend months on it. Score it honestly; the weakest score is your next test.',
    titleLabel: 'The idea in one line', titlePlaceholder: 'e.g. Meal-prep plans for night-shift nurses',
    sections: [
      { key: 'who',        label: 'Who has the problem',            type: 'longtext' },
      { key: 'problem',    label: 'The problem, in their words',    type: 'longtext' },
      { key: 'today',      label: 'What they do about it today',    type: 'longtext' },
      { key: 'why_you',    label: 'Why you',                        type: 'longtext', help: 'Skills, access, experience, or plain obsession.' },
      { key: 's_pain',     label: 'How painful is it?',             type: 'score', help: '1 = mild annoyance, 5 = they would pay today to make it stop.' },
      { key: 's_reach',    label: 'Can you reach these people?',    type: 'score', help: '1 = no idea where they are, 5 = you already know dozens.' },
      { key: 's_deliver',  label: 'Can you deliver it?',            type: 'score', help: '1 = you would need skills or money you do not have, 5 = you could start this week.' },
      { key: 's_pay',      label: 'Will they pay?',                 type: 'score', help: '1 = they expect it free, 5 = someone has already paid for something like it.' },
      { key: 's_fit',      label: 'Does it fit your life?',         type: 'score', help: '1 = needs full days you do not have, 5 = works in your evenings and weekends.' },
      { key: 'evidence',   label: 'Evidence so far',                type: 'list',     help: 'Conversations, pre-orders, sign-ups — facts, not hopes.' },
      { key: 'test',       label: 'Smallest test',                  type: 'longtext', help: 'The cheapest thing you could do in two weeks to check the weakest score.' },
      { key: 'verdict',    label: 'Verdict',                        type: 'select', options: ['Keep going', 'Change it', 'Park it'] }
    ]
  },

  elevator_pitch: {
    label: 'Elevator pitch', emoji: '🎤', layout: 'pitch', multiple: true,
    blurb: 'What you do, for whom, and why it matters — in about 30 seconds. Every saved version is kept.',
    titleLabel: 'Who is this version for?', titlePlaceholder: 'e.g. Networking events, a lender, a brand',
    sections: [
      { key: 'audience', label: 'Who you are talking to', type: 'text' },
      { key: 'hook',     label: 'Hook',                   type: 'longtext', help: 'One line that makes them want the next one.' },
      { key: 'problem',  label: 'Problem',                type: 'longtext' },
      { key: 'solution', label: 'What you do about it',   type: 'longtext' },
      { key: 'proof',    label: 'Proof',                  type: 'longtext', help: 'A number, a result, a customer.' },
      { key: 'ask',      label: 'The ask',                type: 'longtext', help: 'What you want them to do next.' },
      { key: 'pitch',    label: 'Your pitch, start to finish', type: 'longtext', help: 'Say it out loud while you write it. About 75 words is 30 seconds.' }
    ]
  }
};

// A path config adds its own worksheet (an offer builder, an MVP scope) here.
// Checked when the config loads, so a typo fails at boot, not on one page.
const KIND = /^[a-z][a-z0-9_]{1,39}$/;
const TYPES = ['text', 'longtext', 'list', 'rich', 'score', 'money', 'number', 'date', 'select'];
function defineWorksheet(key, def) {
  const bad = why => { throw new Error('Invalid worksheet "' + key + '": ' + why); };
  if (!KIND.test(String(key))) bad('key must match ' + KIND);
  if (WORKSHEETS[key]) bad('that key is already defined');
  if (!def || typeof def.label !== 'string' || !def.label.trim()) bad('needs a label');
  if (!['form', 'canvas', 'pitch', 'matrix'].includes(def.layout || 'form')) bad('layout must be form, canvas, pitch or matrix');
  if (def.layout === 'matrix') def = Object.assign({ sections: [] }, def);
  else if (!Array.isArray(def.sections) || !def.sections.length) bad('needs sections');
  const seen = new Set();
  def.sections.forEach(s => {
    if (!s || !KIND.test(String(s.key))) bad('section key "' + (s && s.key) + '" is not valid');
    if (seen.has(s.key)) bad('duplicate section "' + s.key + '"');
    seen.add(s.key);
    if (!s.label) bad('section "' + s.key + '" needs a label');
    if (!TYPES.includes(s.type)) bad('section "' + s.key + '" type must be one of ' + TYPES.join(', '));
    if (s.type === 'select' && !(Array.isArray(s.options) && s.options.length)) bad('select "' + s.key + '" needs options');
  });
  // Optional: data → [{ label, value, tone? }] worked out from what is filled in
  // (a quote total, a margin). Arithmetic only; shown above the form.
  if (def.summary !== undefined && typeof def.summary !== 'function') bad('summary must be a function');
  WORKSHEETS[key] = Object.freeze(Object.assign({ layout: 'form', multiple: true, emoji: '📝', blurb: '' }, def));
  return WORKSHEETS[key];
}

const LIMITS = { text: 200, longtext: 3000, listItem: 300, listItems: 20 };
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

// A submitted form, cleaned to exactly what the worksheet allows.
function clean(def, body) {
  if (def.layout === 'matrix') return matrix.clean(def, body);
  const data = {};
  for (const s of def.sections) {
    const v = body[s.key];
    if (s.type === 'rich') {
      const html = richtext.clean(v);
      if (html) data[s.key] = html;
    } else if (s.type === 'list') {
      const items = String(v || '').split('\n').map(x => x.trim().slice(0, LIMITS.listItem)).filter(Boolean).slice(0, LIMITS.listItems);
      if (items.length) data[s.key] = items;
    } else if (s.type === 'score') {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= 5) data[s.key] = n;
    } else if (s.type === 'money' || s.type === 'number') {
      const n = num(v);
      if (n !== null && Math.abs(n) <= 1e9) data[s.key] = Math.round(n * 100) / 100;
    } else if (s.type === 'date') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) data[s.key] = String(v);
    } else if (s.type === 'select') {
      if ((s.options || []).includes(String(v))) data[s.key] = String(v);
    } else {
      const t = String(v || '').trim().slice(0, s.type === 'longtext' ? LIMITS.longtext : LIMITS.text);
      if (t) data[s.key] = t;
    }
  }
  return data;
}

// How full a worksheet is, for the "3 of 11 done" line.
function progress(def, data) {
  if (def.layout === 'matrix') return matrix.progress(def, data);
  const done = def.sections.filter(s => data && data[s.key] !== undefined && data[s.key] !== '').length;
  return { done, total: def.sections.length };
}

// The idea refiner's score: total of five 1–5 scores, and the weakest one.
function ideaScore(data) {
  const keys = ['s_pain', 's_reach', 's_deliver', 's_pay', 's_fit'];
  const scored = keys.filter(k => Number.isInteger(data && data[k]));
  if (!scored.length) return null;
  const total = scored.reduce((n, k) => n + data[k], 0);
  const weakest = scored.reduce((a, k) => (data[k] < data[a] ? k : a), scored[0]);
  const def = WORKSHEETS.idea_refiner.sections.find(s => s.key === weakest);
  return { total, of: scored.length * 5, complete: scored.length === keys.length, weakest: def ? def.label : weakest };
}

// About 150 spoken words a minute.
function pitchStats(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return { words, seconds: Math.round(words / 150 * 60) };
}

// The summary lines a worksheet works out, never throwing on half-filled data.
function summaryOf(def, data) {
  if (!def || typeof def.summary !== 'function') return [];
  try { return (def.summary(data || {}) || []).filter(x => x && x.label && x.value !== undefined && x.value !== null); } catch (_) { return []; }
}

module.exports = { WORKSHEETS, defineWorksheet, summaryOf, clean, progress, ideaScore, pitchStats };
