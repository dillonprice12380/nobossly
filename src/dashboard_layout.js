// Which dashboard sections a member sees, and in what order
// (profiles.dashboard_layout, migrations/2026-11-08_dashboard_layout.sql).
//
// Stored as { order: [keys…], hidden: [keys…] }. Only the keys below mean
// anything; unknown ones are dropped, and sections added later appear in their
// default spot. Each section keeps its column: the money strip and the week
// ahead across the top, the work on the left, quick glances on the right.

const SECTIONS = [
  { key: 'money',      label: '💰 Money this month', col: 'top' },
  { key: 'upcoming',   label: '📅 Coming up this week', col: 'top' },
  { key: 'challenges', label: '🏁 Your challenges', col: 'main' },
  { key: 'sprint',     label: '🎯 Sprint', col: 'main', flag: 'sprints' },
  { key: 'path',       label: '🧭 Your path dashboard', col: 'main' },
  { key: 'tools',      label: '🧰 Your tools', col: 'main' },
  { key: 'paid',       label: '💵 Got paid?', col: 'side' },
  { key: 'news',       label: '📰 News for your path', col: 'side' },
  { key: 'people',     label: '👥 Your people', col: 'side' },
  { key: 'ladder',     label: '🪜 Next rung', col: 'side', flag: 'ladder' }
];
const BY_KEY = Object.fromEntries(SECTIONS.map(s => [s.key, s]));
const DEFAULT_ORDER = SECTIONS.map(s => s.key);
const COLS = ['top', 'main', 'side'];

// Whatever is stored → a clean { order, hidden }.
function clean(stored) {
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const seen = new Set();
  const order = [];
  (Array.isArray(s.order) ? s.order : []).forEach(k => {
    if (BY_KEY[k] && !seen.has(k)) { seen.add(k); order.push(k); }
  });
  // New or missing sections slot in after the one they follow by default.
  DEFAULT_ORDER.forEach((k, i) => {
    if (seen.has(k)) return;
    const before = DEFAULT_ORDER.slice(0, i).reverse().find(p => seen.has(p));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, k);
    seen.add(k);
  });
  const hidden = [...new Set((Array.isArray(s.hidden) ? s.hidden : []).filter(k => BY_KEY[k]))];
  return { order, hidden };
}

const available = (s, flags) => !s.flag || !!(flags && flags[s.flag]);

/**
 * The layout to render. top/main/side are visible keys in the member's order;
 * `all` lists every available section (for the customize page) with its
 * column, position and whether it is shown.
 */
function resolve(stored, flags) {
  const { order, hidden } = clean(stored);
  const off = new Set(hidden);
  const out = { top: [], main: [], side: [], all: [], hidden: [], customized: !!(stored && (Array.isArray(stored.order) && stored.order.length || Array.isArray(stored.hidden) && stored.hidden.length)) };
  order.forEach(k => {
    const s = BY_KEY[k];
    if (!available(s, flags)) return;
    out.all.push({ key: k, label: s.label, col: s.col, shown: !off.has(k) });
    if (off.has(k)) out.hidden.push(k); else out[s.col].push(k);
  });
  // On a phone the columns stack into one: the top cards, then Got paid (the
  // thing people open the app to do), then the work, then the other glances.
  const side = out.side.filter(k => k !== 'paid');
  out.mobile = [...out.top, ...(out.side.includes('paid') ? ['paid'] : []), ...out.main, ...side];
  out.mobileOrder = Object.fromEntries(out.mobile.map((k, i) => [k, i + 1]));
  return out;
}

/**
 * Apply one change from the customize page: { action: 'up'|'down'|'hide'|'show'|'reset', key }.
 * Moving swaps a section with its neighbour in the same column (skipping
 * sections the member cannot have). Returns the new stored value, or null for
 * a reset, or undefined when the change makes no sense.
 */
function apply(stored, change, flags) {
  const action = String((change && change.action) || '');
  if (action === 'reset') return null;
  const key = String((change && change.key) || '');
  const s = BY_KEY[key];
  if (!s || !available(s, flags)) return undefined;
  const { order, hidden } = clean(stored);
  if (action === 'hide' || action === 'show') {
    const set = new Set(hidden);
    if (action === 'hide') set.add(key); else set.delete(key);
    return { order, hidden: DEFAULT_ORDER.filter(k => set.has(k)) };
  }
  if (action !== 'up' && action !== 'down') return undefined;
  const peers = order.filter(k => BY_KEY[k].col === s.col && available(BY_KEY[k], flags));
  const i = peers.indexOf(key);
  const j = action === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= peers.length) return { order, hidden };
  const a = order.indexOf(key), b = order.indexOf(peers[j]);
  [order[a], order[b]] = [order[b], order[a]];
  return { order, hidden };
}

module.exports = { SECTIONS, DEFAULT_ORDER, COLS, clean, resolve, apply };
