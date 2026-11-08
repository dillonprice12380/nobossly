// One place where boards, metrics and checklists are defined and looked up.
//
// Path configs (src/path_dashboards/<path>.js) only *declare* things — "a
// client pipeline with these stages", "followers, logged monthly" — and the
// engines and pages do the rest. So a mistake in a declaration has to fail
// loudly when the config loads, not as a broken page for one member weeks
// later: every definition is checked here, at definition time, and frozen.
//
// Keys follow the database's own pattern (^[a-z][a-z0-9_]{1,39}$), because
// they are stored in pipeline_items.board/stage, metric_entries.metric and
// checklist_progress.checklist/item.

const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const FIELD_TYPES = ['text', 'longtext', 'number', 'money', 'date', 'url', 'select'];
const VALUE_KINDS = ['money', 'number'];
const UNITS = ['count', 'money', 'percent'];
const PERIODS = ['month', 'week'];
// Board fields live in `data`, but share a form with the columns.
const RESERVED_FIELDS = ['title', 'value', 'due_on', 'stage', 'position', 'id'];

const store = { board: new Map(), metric: new Map(), checklist: new Map() };

function bad(kind, key, why) {
  throw new Error(`Invalid ${kind} definition${key ? ` "${key}"` : ''}: ${why}`);
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v, max) => v === undefined || text(v, max);

function checkKey(kind, key) {
  if (typeof key !== 'string' || !KEY.test(key)) bad(kind, key, 'key must match ^[a-z][a-z0-9_]{1,39}$');
}

// A list of { key, … } with unique, well-formed keys.
function checkKeys(kind, owner, list, what) {
  const seen = new Set();
  list.forEach((x, i) => {
    if (!isObj(x)) bad(kind, owner, `${what}[${i}] must be an object`);
    if (typeof x.key !== 'string' || !KEY.test(x.key)) bad(kind, owner, `${what}[${i}] key "${x.key}" must match ^[a-z][a-z0-9_]{1,39}$`);
    if (seen.has(x.key)) bad(kind, owner, `duplicate ${what} key "${x.key}"`);
    if (!text(x.label, 120)) bad(kind, owner, `${what} "${x.key}" needs a label`);
    seen.add(x.key);
  });
}

// Links on checklist items: our own pages, or the open web — nothing else.
const safeLink = v => typeof v === 'string' && (/^\/(?!\/)/.test(v) || /^https?:\/\/[^\s]+$/i.test(v));

function deepFreeze(o) {
  Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

function register(kind, def) {
  if (store[kind].has(def.key)) bad(kind, def.key, 'that key is already defined');
  store[kind].set(def.key, deepFreeze(def));
  return store[kind].get(def.key);
}

function defineBoard(d) {
  if (!isObj(d)) bad('board', null, 'must be an object');
  checkKey('board', d.key);
  if (!text(d.label, 80)) bad('board', d.key, 'needs a label');
  if (!text(d.itemLabel, 40)) bad('board', d.key, "needs an itemLabel (e.g. 'client', 'job', 'video')");
  if (!Array.isArray(d.stages) || d.stages.length < 2) bad('board', d.key, 'needs at least two stages');
  checkKeys('board', d.key, d.stages, 'stage');
  d.stages.forEach(s => { if (s.done !== undefined && s.done !== true) bad('board', d.key, `stage "${s.key}" done must be true or left out`); });
  if (d.valueKind !== undefined && !VALUE_KINDS.includes(d.valueKind)) bad('board', d.key, `valueKind must be one of ${VALUE_KINDS.join(', ')}`);
  if (!optText(d.valueLabel, 40) || !optText(d.dueLabel, 40) || !optText(d.emoji, 8) || !optText(d.help, 600)) {
    bad('board', d.key, 'valueLabel, dueLabel, emoji and help must be short strings when given');
  }
  const fields = d.fields === undefined ? [] : d.fields;
  if (!Array.isArray(fields)) bad('board', d.key, 'fields must be an array');
  checkKeys('board', d.key, fields, 'field');
  fields.forEach(f => {
    if (RESERVED_FIELDS.includes(f.key)) bad('board', d.key, `field key "${f.key}" is reserved`);
    if (!FIELD_TYPES.includes(f.type)) bad('board', d.key, `field "${f.key}" type must be one of ${FIELD_TYPES.join(', ')}`);
    if (f.type === 'select') {
      if (!Array.isArray(f.options) || !f.options.length || !f.options.every(o => text(o, 80))) bad('board', d.key, `select field "${f.key}" needs options (non-empty strings)`);
      if (new Set(f.options).size !== f.options.length) bad('board', d.key, `select field "${f.key}" has duplicate options`);
    } else if (f.options !== undefined) bad('board', d.key, `field "${f.key}" has options but is not a select`);
    if (!optText(f.placeholder, 120)) bad('board', d.key, `field "${f.key}" placeholder must be a short string`);
  });
  return register('board', {
    key: d.key, label: d.label, emoji: d.emoji || '', itemLabel: d.itemLabel,
    stages: d.stages.map(s => ({ key: s.key, label: s.label, done: s.done === true })),
    // No valueLabel → this board does not track a value (a content pipeline).
    valueLabel: d.valueLabel || null, valueKind: d.valueKind || 'money',
    dueLabel: d.dueLabel || 'Due date',
    fields: fields.map(f => ({ key: f.key, label: f.label, type: f.type, options: f.options ? f.options.slice() : null, placeholder: f.placeholder || '' })),
    help: d.help || ''
  });
}

function defineMetric(d) {
  if (!isObj(d)) bad('metric', null, 'must be an object');
  checkKey('metric', d.key);
  if (!text(d.label, 80)) bad('metric', d.key, 'needs a label');
  if (!UNITS.includes(d.unit)) bad('metric', d.key, `unit must be one of ${UNITS.join(', ')}`);
  if (!PERIODS.includes(d.period)) bad('metric', d.key, `period must be one of ${PERIODS.join(', ')}`);
  if (d.higherIsBetter !== undefined && typeof d.higherIsBetter !== 'boolean') bad('metric', d.key, 'higherIsBetter must be true or false');
  if (!optText(d.help, 600)) bad('metric', d.key, 'help must be a short string');
  // fromIncome: a money number the income log can fill in. 'all' sums every
  // payment in the month, 'recurring' only those ticked Recurring.
  if (d.fromIncome !== undefined && !(['all', 'recurring'].includes(d.fromIncome) && d.unit === 'money' && d.period === 'month')) bad('metric', d.key, "fromIncome must be 'all' or 'recurring', on a monthly money number");
  return register('metric', {
    key: d.key, label: d.label, unit: d.unit, period: d.period,
    higherIsBetter: d.higherIsBetter !== false, help: d.help || '', fromIncome: d.fromIncome || null
  });
}

function defineChecklist(d) {
  if (!isObj(d)) bad('checklist', null, 'must be an object');
  checkKey('checklist', d.key);
  if (!text(d.label, 80)) bad('checklist', d.key, 'needs a label');
  if (!optText(d.help, 600)) bad('checklist', d.key, 'help must be a short string');
  if (!Array.isArray(d.items) || !d.items.length) bad('checklist', d.key, 'needs at least one item');
  checkKeys('checklist', d.key, d.items, 'item');
  d.items.forEach(it => {
    if (!optText(it.help, 600)) bad('checklist', d.key, `item "${it.key}" help must be a short string`);
    if (it.link !== undefined && !safeLink(it.link)) bad('checklist', d.key, `item "${it.key}" link must start with / or http(s)://`);
    if (it.expires !== undefined && it.expires !== true) bad('checklist', d.key, `item "${it.key}" expires must be true or left out`);
  });
  return register('checklist', {
    key: d.key, label: d.label, help: d.help || '',
    items: d.items.map(it => ({ key: it.key, label: it.label, help: it.help || '', link: it.link || null, expires: it.expires === true }))
  });
}

const board = key => store.board.get(key) || null;
const metric = key => store.metric.get(key) || null;
const checklist = key => store.checklist.get(key) || null;
const all = () => ({ boards: [...store.board.values()], metrics: [...store.metric.values()], checklists: [...store.checklist.values()] });

module.exports = { KEY, FIELD_TYPES, UNITS, PERIODS, defineBoard, defineMetric, defineChecklist, board, metric, checklist, all };
