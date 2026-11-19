// What a member tracks in their app's database. A tracker is one table, and
// optionally only the rows where one column has one value (role = 'employer'):
//
//   { key, label, schema, table,
//     created?, createdEpoch?   date column → new per day
//     active?,  activeEpoch?    last-active column → active in 7 and 30 days
//     filter?: { column, value } }
//
// Sign-ups (job seekers, employers) and inventory (job posts, blog posts) are
// both trackers; inventory simply has no last-active column. Every table and
// column comes from the database's own catalogue, so nothing a member types
// reaches SQL except the filter value, which always travels as a parameter or
// an escaped literal.

const MAX = 12;
const DAYS = 90;

const TIME = /^(timestamp|date|datetime)/i;
const INTEGER = /^(bigint|integer|int|smallint)$/i;
const isTime = c => TIME.test(c.type || '');
const isEpoch = c => INTEGER.test(c.type || '') && /creat|join|sign|regist|_at$|time|seen|login/i.test(c.name);
const isFilterable = c => /^(text|character varying|varchar|char|character|user-defined|enum|boolean|tinyint|bool|integer|smallint|int)/i.test(c.type || '') && !/(^|_)(id|uuid|email|password|token|hash|phone|name|title|body|content|description|url|slug)$/i.test(c.name);

const pretty = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()).trim();
const CREATED = /^(created_at|created|inserted_at|joined_at|signup_at|signed_up_at|registered_at|date_joined|published_at|posted_at|date_created|createdat)$/i;
const ACTIVE = /^(last_sign_in_at|last_seen_at|last_active_at|last_login_at|last_login|lastloginat)$/i;

// The old single-table config (round 1) is one tracker called "users".
function trackersOf(config) {
  const c = config || {};
  if (Array.isArray(c.trackers)) return c.trackers.slice(0, MAX);
  if (c.table) return [{ key: 'users', label: 'Users', schema: c.schema, table: c.table, created: c.created, createdEpoch: !!c.createdEpoch, active: c.active || null, activeEpoch: !!c.activeEpoch }];
  return [];
}

// First suggestions from the tables a connection can read: the users table,
// then tables that look like people or content.
function suggest(tables) {
  const out = [];
  const add = (t, label) => {
    if (out.length >= 6 || out.some(x => x.schema === t.schema && x.table === t.table && !x.filter)) return;
    const created = t.columns.find(c => CREATED.test(c.name) && (isTime(c) || isEpoch(c))) || null;
    const active = t.columns.find(c => ACTIVE.test(c.name) && (isTime(c) || isEpoch(c))) || null;
    out.push({ key: 't' + (out.length + 1), label, schema: t.schema, table: t.table,
      created: created ? created.name : null, createdEpoch: !!(created && !isTime(created)),
      active: active ? active.name : null, activeEpoch: !!(active && !isTime(active)) });
  };
  const users = tables.find(t => t.schema === 'auth' && t.table === 'users') || tables.find(t => /^(users|accounts|members)$/i.test(t.table));
  if (users) add(users, 'Users');
  for (const t of tables) {
    if (/job|post|blog|article|listing|product|order|application|employer|seeker|candidate|compan|profile|customer|subscri/i.test(t.table) && !/(_log|_audit|_history|_tokens?|_sessions?|migrations?)$/i.test(t.table)) add(t, pretty(t.table));
  }
  return out;
}

/**
 * The set-up form → trackers, each checked against the tables NoBossly
 * listed. Rows come as arrays: t_table[], t_label[], t_created[], t_active[],
 * t_fcol[], t_fval[]. → { trackers } or { error }.
 */
function fromForm(body, tables) {
  const b = body || {};
  const arr = k => (Array.isArray(b[k]) ? b[k] : b[k] === undefined ? [] : [b[k]]).map(v => String(v == null ? '' : v));
  const tabs = arr('t_table'), labels = arr('t_label'), created = arr('t_created'), active = arr('t_active'), fcols = arr('t_fcol'), fvals = arr('t_fval');
  const out = [];
  for (let i = 0; i < tabs.length; i++) {
    if (!tabs[i]) continue;
    const t = (tables || []).find(x => x.key === tabs[i]);
    if (!t) return { error: 'Row ' + (i + 1) + ': choose a table from the list.' };
    const col = n => (n ? t.columns.find(c => c.name === n) || false : null);
    const c = col(created[i]), a = col(active[i]), f = col(fcols[i]);
    if (c === false || a === false || f === false) return { error: 'Row ' + (i + 1) + ': a column chosen is not in ' + t.key + '.' };
    if (c && !isTime(c) && !isEpoch(c)) return { error: 'Row ' + (i + 1) + ': "' + c.name + '" is not a date column.' };
    if (a && !isTime(a) && !isEpoch(a)) return { error: 'Row ' + (i + 1) + ': "' + a.name + '" is not a date column.' };
    const value = String(fvals[i] || '').trim().slice(0, 120);
    if (f && !value) return { error: 'Row ' + (i + 1) + ': say which value of "' + f.name + '" to count (for example employer).' };
    if (out.length >= MAX) return { error: 'Up to ' + MAX + ' things can be tracked per database.' };
    const label = String(labels[i] || '').replace(/\s+/g, ' ').trim().slice(0, 40) || pretty(t.table) + (f ? ' (' + value + ')' : '');
    out.push(Object.assign({ key: 't' + (out.length + 1), label, schema: t.schema, table: t.table,
      created: c ? c.name : null, createdEpoch: !!(c && !isTime(c)), active: a ? a.name : null, activeEpoch: !!(a && !isTime(a)) },
      f ? { filter: { column: f.name, value } } : {}));
  }
  if (!out.length) return { error: 'Choose at least one thing to track.' };
  return { trackers: out };
}

// ------------------------------------------------------------------ SQL
// One tracker as SQL for a dialect: 'pg' ($1 parameters), 'lit' (Postgres
// with escaped literals, for Supabase's query endpoint) or 'mysql' (? parameters).
const qPg = id => '"' + String(id).replace(/"/g, '""') + '"';
const qMy = id => '`' + String(id).replace(/`/g, '``') + '`';
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";

function sqlFor(tr, dialect) {
  const my = dialect === 'mysql';
  const q = my ? qMy : qPg;
  const t = q(tr.schema) + '.' + q(tr.table);
  const ts = (col, epoch) => (epoch ? (my ? 'FROM_UNIXTIME(' + q(col) + ')' : 'to_timestamp(' + q(col) + ')') : q(col));
  const params = [];
  let where = '';
  if (tr.filter) {
    const col = my ? 'CAST(' + q(tr.filter.column) + ' AS CHAR)' : q(tr.filter.column) + '::text';
    if (dialect === 'lit') where = col + ' = ' + lit(tr.filter.value);
    else { params.push(tr.filter.value); where = col + ' = ' + (my ? '?' : '$1'); }
  }
  const w = extra => { const parts = [where, extra].filter(Boolean); return parts.length ? ' where ' + parts.join(' and ') : ''; };
  const a = tr.active ? ts(tr.active, tr.activeEpoch) : null;
  const ago = n => (my ? 'UTC_TIMESTAMP() - interval ' + n + ' day' : "now() - interval '" + n + " days'");
  const total = my
    ? 'select count(*) as n' + (a ? `, sum(${a} >= ${ago(7)}) as a7, sum(${a} >= ${ago(30)}) as a30` : '') + ' from ' + t + w()
    : 'select count(*)::bigint as n' + (a ? `, count(*) filter (where ${a} >= ${ago(7)})::bigint as a7, count(*) filter (where ${a} >= ${ago(30)})::bigint as a30` : '') + ' from ' + t + w();
  let days = null;
  if (tr.created) {
    const c = ts(tr.created, tr.createdEpoch);
    days = my
      ? `select date_format(${c}, '%Y-%m-%d') as d, count(*) as n from ${t}${w(c + ' >= ' + ago(DAYS))} group by 1`
      : `select to_char(date_trunc('day', ${c}${tr.createdEpoch ? '' : "::timestamptz at time zone 'UTC'"}), 'YYYY-MM-DD') as d, count(*)::bigint as n from ${t}${w(c + ' >= ' + ago(DAYS))} group by 1`;
  }
  return { total, days, params, columns: [tr.created, tr.active, tr.filter && tr.filter.column].filter(Boolean) };
}

// Rows from the two queries → counts for one tracker.
function countsFrom(tr, totalRow, dayRows) {
  const byDay = {};
  (dayRows || []).forEach(r => { if (r.d) byDay[r.d] = Number(r.n); });
  const row = totalRow || {};
  return { total: Number(row.n), active7: tr.active ? Number(row.a7 || 0) : null, active30: tr.active ? Number(row.a30 || 0) : null, byDay: tr.created ? byDay : null };
}

module.exports = { MAX, DAYS, isTime, isEpoch, isFilterable, pretty, trackersOf, suggest, fromForm, sqlFor, countsFrom, lit, qPg, qMy };
