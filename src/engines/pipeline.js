// Pipelines: a board of stages with cards on it — a freelancer's clients
// (lead → proposal → won → paid), a creator's videos, a plumber's jobs. The
// board itself is declared in code (registry.defineBoard); the cards are the
// member's rows in pipeline_items.
//
// Everything a card carries beyond title, value and due date lives in `data`,
// and only the fields its board declares get in — typed, trimmed and checked
// here, because the column will take any JSON object under 20KB.

const registry = require('./registry');
const dates = require('./dates');
const fmt = require('./format');
const { EngineError, NotFound, must } = require('./errors');

const COLS = 'id, board, stage, title, value, due_on, data, position, created_at, updated_at';
const VALUE_MAX = 100000000;            // pipeline_items.value check
const DATA_MAX = 18000;                 // under the 20KB column check, with room for jsonb overhead
const TEXT_MAX = { text: 300, longtext: 4000, url: 500 };

function boardOrThrow(key) {
  const def = registry.board(key);
  if (!def) throw new NotFound('There is no board called "' + key + '".');
  return def;
}

// "$1,250.50" → 1250.5; '' → null; anything else that is not a number → error.
function toNumber(v, label) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') { if (!isFinite(v)) throw new EngineError(label + ' must be a number.'); return v; }
  const s = String(v).replace(/[$,\s%]/g, '').replace(/^−/, '-');
  if (!s) return null;
  if (!/^-?\d*\.?\d+$/.test(s)) throw new EngineError(label + ' must be a number.');
  return Number(s);
}

function toDate(v, label) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const d = dates.parseDate(v);
  if (!d) throw new EngineError(label + ' must be a date.');
  return d;
}

function toUrl(v, label) {
  let s = String(v || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  if (!/^https?:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(s) || s.length > TEXT_MAX.url) throw new EngineError(label + ' must be a web address.');
  return s;
}

// One declared field, coerced to what it says it is. null means "clear it".
function coerceField(f, v) {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case 'number':
    case 'money': return toNumber(v, f.label);
    case 'date': return toDate(v, f.label);
    case 'url': return toUrl(v, f.label);
    case 'select': {
      const s = String(v).trim();
      if (!s) return null;
      if (!f.options.includes(s)) throw new EngineError(f.label + ' must be one of: ' + f.options.join(', ') + '.');
      return s;
    }
    default: {
      const s = String(v).trim().slice(0, TEXT_MAX[f.type] || 300);
      return s || null;
    }
  }
}

/**
 * The columns an input may set, coerced. Keys absent from `input` are left
 * alone (so a partial update touches only what it names); unknown keys are
 * dropped. `data` is merged over `existing` so fields a config no longer
 * declares are not destroyed by an edit.
 */
function clean(def, input, existing) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  if (has('title') || !existing) {
    const t = String(input.title || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!t) throw new EngineError('Give the ' + def.itemLabel + ' a name.');
    out.title = t;
  }
  if (has('value')) {
    const v = toNumber(input.value, def.valueLabel || 'Value');
    if (v !== null && Math.abs(v) > VALUE_MAX) throw new EngineError((def.valueLabel || 'Value') + ' is too large.');
    out.value = v === null ? null : Math.round(v * 100) / 100;
  }
  if (has('due_on')) out.due_on = toDate(input.due_on, def.dueLabel);
  if (has('stage')) {
    if (!def.stages.some(s => s.key === input.stage)) throw new EngineError('That stage is not on this board.');
    out.stage = input.stage;
  }
  // Fields may arrive flat (a form: { rate: '50' }) or as { data: { rate } }.
  const src = Object.assign({}, input.data && typeof input.data === 'object' ? input.data : {});
  def.fields.forEach(f => { if (has(f.key)) src[f.key] = input[f.key]; });
  const touched = def.fields.filter(f => Object.prototype.hasOwnProperty.call(src, f.key));
  if (touched.length || !existing) {
    const data = Object.assign({}, existing && existing.data && typeof existing.data === 'object' ? existing.data : {});
    touched.forEach(f => {
      const v = coerceField(f, src[f.key]);
      if (v === null) delete data[f.key]; else data[f.key] = v;
    });
    if (JSON.stringify(data).length > DATA_MAX) throw new EngineError('That is too much text for one ' + def.itemLabel + '. Shorten the notes a little.');
    out.data = data;
  }
  return out;
}

const shape = r => Object.assign({}, r, { value: r.value === null || r.value === undefined ? null : Number(r.value), data: r.data || {} });

// Where a card lands at the bottom of a stage.
async function nextPosition(sb, userId, board, stage) {
  const rows = must(await sb.from('pipeline_items').select('position')
    .eq('user_id', userId).eq('board', board).eq('stage', stage)
    .order('position', { ascending: false }).limit(1));
  const top = rows && rows[0] ? Number(rows[0].position) || 0 : 0;
  return Math.min(top + 1, 2147483647);
}

function totalsOf(def, items) {
  const done = new Set(def.stages.filter(s => s.done).map(s => s.key));
  const t = { count: 0, value: 0, openCount: 0, openValue: 0, byStage: {} };
  def.stages.forEach(s => { t.byStage[s.key] = { count: 0, value: 0 }; });
  items.forEach(i => {
    const v = Number(i.value) || 0;
    const b = t.byStage[i.stage] || t.byStage[def.stages[0].key];
    b.count++; b.value += v; t.count++; t.value += v;
    if (!done.has(i.stage)) { t.openCount++; t.openValue += v; }
  });
  const r2 = n => Math.round(n * 100) / 100;
  t.value = r2(t.value); t.openValue = r2(t.openValue);
  Object.values(t.byStage).forEach(b => { b.value = r2(b.value); });
  // Formatted once here, so a dashboard partial needs no helpers. Empty when
  // the board does not track a value.
  const show = v => (def.valueLabel ? fmt.byUnit(def.valueKind, v) : '');
  t.display = { value: show(t.value), openValue: show(t.openValue), byStage: {} };
  Object.keys(t.byStage).forEach(k => { t.display.byStage[k] = show(t.byStage[k].value); });
  return t;
}

/**
 * A board with its cards in columns, in stage order. A card whose stage the
 * config has since dropped shows in the first column rather than vanishing.
 */
async function list(sb, userId, boardKey) {
  const def = boardOrThrow(boardKey);
  const rows = (must(await sb.from('pipeline_items').select(COLS)
    .eq('user_id', userId).eq('board', def.key)
    .order('position', { ascending: true }).order('created_at', { ascending: true }).limit(500)) || []).map(shape);
  const byKey = {};
  def.stages.forEach(s => { byKey[s.key] = []; });
  rows.forEach(r => (byKey[r.stage] || byKey[def.stages[0].key]).push(r));
  return {
    def,
    columns: def.stages.map(s => ({ stage: s, items: byKey[s.key] })),
    totals: totalsOf(def, rows)
  };
}

// Just the numbers, for a dashboard's board_summary partial.
async function summary(sb, userId, boardKey) {
  const def = boardOrThrow(boardKey);
  const rows = must(await sb.from('pipeline_items').select('stage, value')
    .eq('user_id', userId).eq('board', def.key).limit(2000)) || [];
  return { def, totals: totalsOf(def, rows) };
}

async function get(sb, userId, boardKey, id) {
  const def = boardOrThrow(boardKey);
  const row = must(await sb.from('pipeline_items').select(COLS)
    .eq('user_id', userId).eq('board', def.key).eq('id', id).maybeSingle());
  if (!row) throw new NotFound('That ' + def.itemLabel + ' is gone.');
  return { def, item: shape(row) };
}

async function create(sb, userId, boardKey, input) {
  const def = boardOrThrow(boardKey);
  const fields = Object.assign({}, input || {});
  if (!fields.stage) fields.stage = def.stages[0].key;     // new cards start in the first stage
  const row = clean(def, fields, null);
  const position = await nextPosition(sb, userId, def.key, row.stage);
  const saved = must(await sb.from('pipeline_items').insert({
    user_id: userId, board: def.key, stage: row.stage, title: row.title,
    value: row.value === undefined ? null : row.value,
    due_on: row.due_on === undefined ? null : row.due_on,
    data: row.data, position
  }).select(COLS).single());
  return shape(saved);
}

async function update(sb, userId, boardKey, id, input) {
  const { def, item } = await get(sb, userId, boardKey, id);
  const patch = clean(def, input || {}, item);
  if (patch.stage && patch.stage !== item.stage) patch.position = await nextPosition(sb, userId, def.key, patch.stage);
  if (!Object.keys(patch).length) return item;
  const saved = must(await sb.from('pipeline_items').update(patch)
    .eq('user_id', userId).eq('board', def.key).eq('id', id).select(COLS).maybeSingle());
  if (!saved) throw new NotFound('That ' + def.itemLabel + ' is gone.');
  return shape(saved);
}

async function move(sb, userId, boardKey, id, stage) {
  const def = boardOrThrow(boardKey);
  if (!def.stages.some(s => s.key === stage)) throw new EngineError('That stage is not on this board.');
  const position = await nextPosition(sb, userId, def.key, stage);
  const saved = must(await sb.from('pipeline_items').update({ stage, position })
    .eq('user_id', userId).eq('board', def.key).eq('id', id).select(COLS).maybeSingle());
  if (!saved) throw new NotFound('That ' + def.itemLabel + ' is gone.');
  return shape(saved);
}

async function remove(sb, userId, boardKey, id) {
  const def = boardOrThrow(boardKey);
  must(await sb.from('pipeline_items').delete().eq('user_id', userId).eq('board', def.key).eq('id', id));
  return true;
}

// The weeks of a month, Monday first, padded with the neighbouring months'
// days so every row has seven cells.
function monthGrid(month, now = new Date()) {
  const ym = dates.parseMonth(month);
  if (!ym) throw new EngineError('Month must look like 2026-11.');
  const first = ym + '-01';
  const last = dates.addDays(dates.addMonths(ym, 1) + '-01', -1);
  const todayIso = dates.today(now);
  const weeks = [];
  for (let d = dates.mondayOf(first); d <= last; ) {
    const week = [];
    for (let i = 0; i < 7; i++, d = dates.addDays(d, 1)) {
      week.push({ date: d, day: Number(d.slice(8)), inMonth: d.slice(0, 7) === ym, today: d === todayIso });
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * Dated cards across one or more boards for one month: grouped by date, and
 * laid on the month grid (each cell gets its `items`). Unknown board keys are
 * skipped; if none are known it is a NotFound.
 */
async function calendar(sb, userId, boardKeys, month, now = new Date()) {
  const ym = dates.parseMonth(month) || dates.today(now).slice(0, 7);
  const keys = [...new Set((boardKeys || []).filter(k => registry.board(k)))];
  if (!keys.length) throw new NotFound('None of those boards exist.');
  const boards = {};
  keys.forEach(k => { boards[k] = registry.board(k); });
  const from = ym + '-01', to = dates.addMonths(ym, 1) + '-01';
  const rows = (must(await sb.from('pipeline_items').select(COLS)
    .eq('user_id', userId).in('board', keys).gte('due_on', from).lt('due_on', to)
    .order('due_on', { ascending: true }).order('position', { ascending: true }).limit(1000)) || []).map(shape);
  const byDate = {};
  rows.forEach(r => {
    const d = String(r.due_on).slice(0, 10);
    if (d < from || d >= to) return;                // a fake client or a sloppy filter must not misplace a card
    (byDate[d] = byDate[d] || []).push(r);
  });
  const weeks = monthGrid(ym, now).map(w => w.map(c => Object.assign(c, { items: c.inMonth ? (byDate[c.date] || []) : [] })));
  return { month: ym, prev: dates.addMonths(ym, -1), next: dates.addMonths(ym, 1), boards, byDate, weeks, count: Object.values(byDate).reduce((n, a) => n + a.length, 0) };
}

module.exports = { list, summary, get, create, update, move, remove, calendar, monthGrid, clean, totalsOf };
