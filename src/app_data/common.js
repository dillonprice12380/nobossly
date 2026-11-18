// Shared by the app-database connectors (src/app_data/*): reading and storing
// a connection's secret, and turning counts into the daily rows the member's
// charts read (app_metrics).

const DAYS = 90;                 // how far back new sign-ups are counted per day
const TIMEOUT_MS = 10000;        // any one query
const CONNECT_MS = 8000;

async function secretOf(sc, conn) {
  const { data, error } = await sc.rpc('data_connection_secret', { p_id: conn.id });
  return error ? null : data || null;
}
const store = (sc, { id = null, userId, kind, provider, label, host, secret }) =>
  sc.rpc('data_connection_store', { p_id: id, p_user: userId, p_kind: kind, p_provider: provider || null, p_label: label || null, p_host: host || null,
    p_secret: typeof secret === 'string' ? secret : JSON.stringify(secret) });

async function fail(sc, conn, error, now = new Date()) {
  await sc.from('data_connections').update({ status: 'error', last_error: String(error).slice(0, 300), last_synced_at: now.toISOString() }).eq('id', conn.id);
  return { error };
}

const ymd = d => new Date(d).toISOString().slice(0, 10);
const int = v => { const n = Number(v); return isFinite(n) && n >= 0 ? Math.round(n) : null; };

/**
 * What a sync found → app_metrics rows. counts: { total, active7, active30,
 * byDay: { 'YYYY-MM-DD': new users } } (active ones null when the app does not
 * record activity). Every day of the window gets a row, so a quiet day reads
 * as 0 rather than missing. Two sets, saved separately so an upsert of the
 * history never blanks the totals earlier syncs recorded on those days:
 * history (new users per day) and today (with the totals).
 */
function rowsOf(conn, counts, now = new Date()) {
  const history = [];
  for (let i = DAYS - 1; i >= 1; i--) {
    const day = ymd(now.getTime() - i * 86400000);
    history.push({ connection_id: conn.id, user_id: conn.user_id, day, new_users: int((counts.byDay || {})[day]) || 0 });
  }
  const day = ymd(now);
  const today = { connection_id: conn.id, user_id: conn.user_id, day, new_users: int((counts.byDay || {})[day]) || 0,
    total_users: int(counts.total), active_7d: int(counts.active7), active_30d: int(counts.active30) };
  return { history, today };
}

module.exports = { DAYS, TIMEOUT_MS, CONNECT_MS, secretOf, store, fail, rowsOf, ymd, int };
