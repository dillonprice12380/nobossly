// The workspace hub (views/workspace/index.ejs): every tool as a tile, the
// member's pinned ones first, what they touched last at the top, one search
// box across their docs, board cards and tasks, and tiles that say what is in
// them. Pins and hidden tiles are kept on the profile as
// { pinned: [ids…], hidden: [ids…] } (profiles.workspace_layout,
// migrations/2026-11-08_workspace_layout.sql).
//
// Everything is read with the member's own client; RLS keeps it to their rows.
// A missing table reads as empty.

const registry = require('./engines/registry');
const pipeline = require('./engines/pipeline');
const metrics = require('./engines/metrics');
const { WORKSHEETS } = require('./workspace/worksheets');
const richtext = require('./workspace/richtext');

const MAX_PINS = 12;
const ID = /^(tool|board|metric|checklist):[a-z][a-z0-9_]{1,39}$/;
const rowsOf = r => (r && !r.error && Array.isArray(r.data) ? r.data : []);
const safe = p => Promise.resolve(p).catch(() => null);
const shortDate = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const docKindOf = key => (key === 'goals' ? 'goal' : key);

/**
 * Every tile on the hub, in groups, before pins and hiding.
 * tools: dashboards.workspaceFor(slug); pathItems: dashboards.pathItemsFor(profile).
 */
function tilesOf(tools, pathItems) {
  const tool = (t, group) => ({ id: 'tool:' + t.key, key: t.key, group, href: t.href, emoji: t.emoji, label: t.label, blurb: t.blurb, docKind: t.kind || t.key === 'goals' ? docKindOf(t.key) : null });
  const out = [];
  (tools.featured || []).forEach(t => out.push(tool(t, 'featured')));
  if (pathItems) {
    pathItems.boards.forEach(b => out.push({ id: 'board:' + b.key, key: b.key, group: 'path', href: '/workspace/boards/' + b.key, emoji: b.emoji || '🗂️', label: b.label, blurb: 'Board · ' + b.stages.map(s => s.label).join(' → '), board: b.key }));
    pathItems.metrics.forEach(m => out.push({ id: 'metric:' + m.key, key: m.key, group: 'path', href: '/workspace/metrics/' + m.key, emoji: '📈', label: m.label, blurb: 'Logged each ' + m.period + (m.help ? ' · ' + m.help : ''), metric: m.key }));
    pathItems.checklists.forEach(c => out.push({ id: 'checklist:' + c.key, key: c.key, group: 'checklists', href: '/workspace/checklists/' + c.key, emoji: '☑️', label: c.label, blurb: 'Template · ' + c.items.length + ' items', checklist: c.key }));
  }
  (tools.available || []).forEach(t => out.push(tool(t, 'available')));
  (tools.library || []).forEach(t => out.push(tool(t, 'library')));
  return out;
}

// Whatever is stored → a clean { pinned, hidden }.
function clean(stored) {
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const list = v => [...new Set((Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && ID.test(x)))];
  const pinned = list(s.pinned).slice(0, MAX_PINS);
  const hidden = list(s.hidden).filter(x => !pinned.includes(x));
  return { pinned, hidden };
}

/**
 * Tiles with pins and hiding applied: { pinned: [tiles in pin order],
 * groups: { featured, path, checklists, available, library } without the
 * pinned or hidden ones, hidden: [tiles] }. Pins and hides of tiles this
 * member no longer has (another path) are kept but not shown.
 */
function arrange(tiles, stored) {
  const { pinned, hidden } = clean(stored);
  const byId = new Map(tiles.map(t => [t.id, t]));
  const pins = pinned.map(id => byId.get(id)).filter(Boolean).map(t => Object.assign({}, t, { pinned: true }));
  const off = new Set(hidden);
  const on = new Set(pinned);
  const groups = { featured: [], path: [], checklists: [], available: [], library: [] };
  const hiddenTiles = [];
  tiles.forEach(t => {
    if (on.has(t.id)) return;
    if (off.has(t.id)) hiddenTiles.push(Object.assign({}, t, { hidden: true }));
    else groups[t.group].push(t);
  });
  return { pinned: pins, groups, hidden: hiddenTiles, full: pinned.length >= MAX_PINS };
}

/**
 * One change from a tile's buttons: { action: 'pin'|'unpin'|'hide'|'show'|'left'|'right', id }.
 * left/right move a pin one place. Returns the new stored value, or undefined
 * when the change makes no sense (unknown id, a tile this member does not
 * have, a pin past the limit).
 */
function apply(stored, change, tiles) {
  const action = String((change && change.action) || '');
  const id = String((change && change.id) || '');
  if (action === 'reset') return null;
  if (!ID.test(id) || !(tiles || []).some(t => t.id === id)) return undefined;
  const { pinned, hidden } = clean(stored);
  const without = (a, x) => a.filter(y => y !== x);
  if (action === 'pin') {
    if (pinned.includes(id)) return { pinned, hidden };
    if (pinned.length >= MAX_PINS) return undefined;
    return { pinned: pinned.concat(id), hidden: without(hidden, id) };
  }
  if (action === 'unpin') return { pinned: without(pinned, id), hidden };
  if (action === 'hide') return { pinned: without(pinned, id), hidden: hidden.includes(id) ? hidden : hidden.concat(id) };
  if (action === 'show') return { pinned, hidden: without(hidden, id) };
  if (action === 'left' || action === 'right') {
    const i = pinned.indexOf(id), j = action === 'left' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= pinned.length) return { pinned, hidden };
    const next = pinned.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return { pinned: next, hidden };
  }
  return undefined;
}

/**
 * What each tile can say about what is in it, keyed by tile id:
 * { 'board:fl_clients': '3 open · $1,700', 'metric:fl_hours': '32 · ▲ +4', 'tool:persona': '2 saved · Nov 5' }.
 * `docs` are the member's workspace_docs rows (kind, updated_at).
 */
async function liveOf(sb, userId, tiles, docs, now = new Date()) {
  const out = {};
  const byKind = {};
  (docs || []).forEach(d => { (byKind[d.kind] = byKind[d.kind] || []).push(d); });
  tiles.forEach(t => {
    const mine = t.docKind ? byKind[t.docKind] : null;
    if (mine && mine.length) out[t.id] = { text: mine.length + ' saved · ' + shortDate(mine[0].updated_at) };
  });
  const boards = tiles.filter(t => t.board), nums = tiles.filter(t => t.metric);
  const [b, m] = await Promise.all([
    Promise.all(boards.map(t => safe(pipeline.summary(sb, userId, t.board)))),
    Promise.all(nums.map(t => safe(metrics.card(sb, userId, t.metric, 6, now))))
  ]);
  boards.forEach((t, i) => {
    const s = b[i];
    if (!s || !s.totals) return;
    const tt = s.totals;
    if (!tt.count) { out[t.id] = { text: 'Empty so far', quiet: true }; return; }
    out[t.id] = { text: tt.openCount + ' open' + (tt.count > tt.openCount ? ' · ' + (tt.count - tt.openCount) + ' done' : '') + (tt.display && tt.display.openValue && tt.openValue ? ' · ' + tt.display.openValue + ' open' : '') };
  });
  nums.forEach((t, i) => {
    const c = m[i];
    if (!c || !c.summary) return;
    if (!c.summary.latest) { out[t.id] = { text: 'Nothing logged recently', quiet: true }; return; }
    const last = (c.series || []).filter(p => p.value !== null && p.value !== undefined).pop();
    const arrow = c.summary.direction === 'up' ? '▲ ' : c.summary.direction === 'down' ? '▼ ' : '';
    out[t.id] = {
      text: c.display.latest + (last ? ' · ' + last.label : ''),
      change: c.display.change ? arrow + c.display.change : '',
      good: c.summary.good
    };
  });
  return out;
}

const labelOfKind = kind => {
  if (kind === 'goal') return '🎯 Goal';
  const w = WORKSHEETS[kind];
  return w ? (w.emoji ? w.emoji + ' ' : '') + w.label : 'Doc';
};
const docHref = d => (d.kind === 'goal' ? '/workspace/goals' : '/workspace/docs/' + d.kind + '/' + d.id);
const cardHref = c => '/workspace/boards/' + c.board + '/' + c.id;
const boardLabel = key => { const b = registry.board(key); return b ? (b.emoji ? b.emoji + ' ' : '') + b.label : 'Board'; };

/**
 * What the member touched last: docs and board cards, newest first.
 * `docs` are the hub's workspace_docs rows (id, kind, title, updated_at).
 */
async function recent(sb, userId, docs, max = 6) {
  const cards = rowsOf(await safe(sb.from('pipeline_items').select('id, board, title, updated_at')
    .eq('user_id', userId).order('updated_at', { ascending: false }).limit(max)));
  const items = (docs || []).slice(0, max).map(d => ({ title: d.title || labelOfKind(d.kind), kind: labelOfKind(d.kind), href: docHref(d), at: d.updated_at }))
    .concat(cards.filter(c => registry.board(c.board)).map(c => ({ title: c.title, kind: boardLabel(c.board), href: cardHref(c), at: c.updated_at })));
  return items.filter(i => i.at).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, max)
    .map(i => Object.assign(i, { when: shortDate(i.at) }));
}

// The searchable words of a doc: its title and every filled-in field.
function textOfDoc(d) {
  const parts = [d.title || ''];
  const walk = v => {
    if (v == null) return;
    if (typeof v === 'string') parts.push(/<[a-z]/i.test(v) ? richtext.textOf(v) : v);
    else if (typeof v === 'number') parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(d.data);
  return parts.join(' \n ').replace(/\s+/g, ' ');
}

// A few words either side of the first match.
function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return '';
  const a = Math.max(0, i - 50), b = Math.min(text.length, i + q.length + 70);
  return (a ? '…' : '') + text.slice(a, b).trim() + (b < text.length ? '…' : '');
}

const likeOf = q => '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';

/**
 * Search the member's docs (titles and contents), board cards and tasks.
 * Returns { q, results: [{ title, kind, href, snippet }], count, tooShort }.
 */
async function search(sb, userId, raw, max = 40) {
  const q = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (q.length < 2) return { q, results: [], count: 0, tooShort: !!q };
  const [docs, cards, tasks] = await Promise.all([
    safe(sb.from('workspace_docs').select('id, kind, title, data, updated_at').eq('user_id', userId).order('updated_at', { ascending: false }).limit(400)),
    safe(sb.from('pipeline_items').select('id, board, title, data, updated_at').eq('user_id', userId).ilike('title', likeOf(q)).order('updated_at', { ascending: false }).limit(30)),
    safe(sb.from('tasks').select('id, title, status, due_date').eq('user_id', userId).ilike('title', likeOf(q)).limit(30))
  ]);
  const lower = q.toLowerCase();
  const results = [];
  rowsOf(docs).forEach(d => {
    const text = textOfDoc(d);
    if (!text.toLowerCase().includes(lower)) return;
    const inTitle = String(d.title || '').toLowerCase().includes(lower);
    results.push({ title: d.title || labelOfKind(d.kind), kind: labelOfKind(d.kind), href: docHref(d), snippet: inTitle ? '' : snippet(text, q), rank: inTitle ? 0 : 1 });
  });
  rowsOf(cards).forEach(c => {
    if (!registry.board(c.board) || !String(c.title || '').toLowerCase().includes(lower)) return;
    results.push({ title: c.title, kind: boardLabel(c.board), href: cardHref(c), snippet: '', rank: 0 });
  });
  rowsOf(tasks).forEach(t => {
    if (!String(t.title || '').toLowerCase().includes(lower)) return;
    results.push({ title: t.title, kind: '✅ Task' + (t.status === 'done' ? ' · done' : ''), href: '/tasks', snippet: t.due_date ? 'Due ' + shortDate(t.due_date + 'T12:00:00Z') : '', rank: t.status === 'done' ? 2 : 0 });
  });
  results.sort((a, b) => a.rank - b.rank);
  return { q, results: results.slice(0, max).map(({ rank, ...r }) => r), count: results.length, tooShort: false };
}

module.exports = { MAX_PINS, tilesOf, clean, arrange, apply, liveOf, recent, search, textOfDoc, snippet };
