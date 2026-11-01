// Checklists: a template in code ("licences & insurance for a plumber"), the
// member's ticks in checklist_progress. Items marked `expires` can carry a
// renew-by date (insurance, a trade licence), and the soonest one is what a
// dashboard card warns about.

const registry = require('./registry');
const dates = require('./dates');
const fmt = require('./format');
const { EngineError, NotFound, must } = require('./errors');

const SOON_DAYS = 30;

function checklistOrThrow(key) {
  const def = registry.checklist(key);
  if (!def) throw new NotFound('There is no checklist called "' + key + '".');
  return def;
}

function itemOrThrow(def, item) {
  const it = def.items.find(i => i.key === item);
  if (!it) throw new NotFound('That item is not on this checklist.');
  return it;
}

/**
 * The template merged with this member's ticks. Rows for items the template
 * no longer has are ignored. nextExpiry is the soonest renew-by date on an
 * `expires` item, overdue ones included (they matter most).
 */
function merge(def, rows, now = new Date()) {
  const by = {};
  (rows || []).forEach(r => { by[r.item] = r; });
  const t = dates.today(now), soon = dates.addDays(t, SOON_DAYS);
  const items = def.items.map(it => {
    const r = by[it.key] || {};
    const due = it.expires && r.due_on ? String(r.due_on).slice(0, 10) : null;
    return Object.assign({}, it, {
      done: !!r.done_at, done_at: r.done_at || null, due_on: due, note: r.note || '',
      dueLabel: due ? fmt.date(due) : '',
      overdue: !!due && due < t, dueSoon: !!due && due >= t && due <= soon
    });
  });
  const done = items.filter(i => i.done).length;
  const expiring = items.filter(i => i.due_on).sort((a, b) => (a.due_on < b.due_on ? -1 : 1));
  return {
    def, items, done, total: items.length,
    pct: items.length ? Math.round(done / items.length * 100) : 0,
    open: items.filter(i => !i.done),
    nextExpiry: expiring[0] ? { key: expiring[0].key, label: expiring[0].label, due_on: expiring[0].due_on, dueLabel: expiring[0].dueLabel, overdue: expiring[0].overdue, dueSoon: expiring[0].dueSoon } : null
  };
}

async function progress(sb, userId, key, now = new Date()) {
  const def = checklistOrThrow(key);
  const rows = must(await sb.from('checklist_progress').select('item, done_at, due_on, note')
    .eq('user_id', userId).eq('checklist', def.key));
  return merge(def, rows, now);
}

// `done` true/false sets it (a double-submitted form stays put); left out, it flips.
async function toggle(sb, userId, key, item, done, now = new Date()) {
  const def = checklistOrThrow(key);
  itemOrThrow(def, item);
  if (done === undefined || done === null) {
    const row = must(await sb.from('checklist_progress').select('done_at')
      .eq('user_id', userId).eq('checklist', def.key).eq('item', item).maybeSingle());
    done = !(row && row.done_at);
  }
  // Upsert with only these columns leaves due_on and note as they were.
  must(await sb.from('checklist_progress').upsert({
    user_id: userId, checklist: def.key, item, done_at: done ? now.toISOString() : null
  }, { onConflict: 'user_id,checklist,item' }));
  return !!done;
}

async function setDue(sb, userId, key, item, due) {
  const def = checklistOrThrow(key);
  const it = itemOrThrow(def, item);
  if (!it.expires) throw new EngineError('That item does not need a renewal date.');
  const blank = due === null || due === undefined || String(due).trim() === '';
  const d = blank ? null : dates.parseDate(due);
  if (!blank && !d) throw new EngineError('The renew-by date must be a date.');
  must(await sb.from('checklist_progress').upsert({
    user_id: userId, checklist: def.key, item, due_on: d
  }, { onConflict: 'user_id,checklist,item' }));
  return d;
}

async function setNote(sb, userId, key, item, note) {
  const def = checklistOrThrow(key);
  itemOrThrow(def, item);
  const n = String(note || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null;
  must(await sb.from('checklist_progress').upsert({
    user_id: userId, checklist: def.key, item, note: n
  }, { onConflict: 'user_id,checklist,item' }));
  return n;
}

module.exports = { progress, merge, toggle, setDue, setNote, SOON_DAYS };
