// PlanetScale, after "Connect with PlanetScale". The sign-in is used once:
// NoBossly lists the member's databases, and for the one they pick makes its
// own read-only login on the default branch (a "reader" password for MySQL,
// a role with only pg_read_all_data for Postgres). From then on it is an
// ordinary read-only MySQL or Postgres connection.

const { call } = require('../connections/common');

const API = 'https://api.planetscale.com/v1';
const H = access => ({ Authorization: 'Bearer ' + access, Accept: 'application/json', 'Content-Type': 'application/json' });
const slug = s => /^[a-z0-9][a-z0-9-_]{0,62}$/i.test(String(s || ''));

const explain = status => (status === 401 ? 'PlanetScale says NoBossly is not allowed in. Connect PlanetScale again.'
  : status === 403 ? 'NoBossly is not allowed to make a read-only login on that database. Connect again and allow it.'
  : status === 404 ? 'That PlanetScale database was not found.'
  : 'PlanetScale did not answer properly (' + (status || 'no response') + ').');
const listOf = b => (b && Array.isArray(b.data) ? b.data : Array.isArray(b) ? b : []);

async function projects(access, { fetchImpl = fetch } = {}) {
  const o = await call(fetchImpl, API + '/organizations', { headers: H(access) });
  if (o.status !== 200) return { error: explain(o.status) };
  const out = [];
  for (const org of listOf(o.body).slice(0, 10)) {
    if (!slug(org.name)) continue;
    const d = await call(fetchImpl, API + '/organizations/' + org.name + '/databases?per_page=100', { headers: H(access) });
    if (d.status !== 200) continue;
    for (const db of listOf(d.body)) {
      if (!slug(db.name)) continue;
      const kind = /postgres/i.test(String(db.kind || db.database_kind || db.engine || '')) ? 'postgres' : 'mysql';
      out.push({ id: org.name + '/' + db.name, name: db.name, note: org.name + ' · ' + (kind === 'postgres' ? 'Postgres' : 'MySQL'), org: org.name, db: db.name, kind, branch: db.default_branch || 'main' });
    }
  }
  return { projects: out };
}

/** A read-only login on the database's default branch, as a connection string. */
async function readerLogin(access, pick, { fetchImpl = fetch } = {}) {
  if (!slug(pick.org) || !slug(pick.db) || !slug(pick.branch)) return { error: 'That database name does not look right.' };
  const base = API + '/organizations/' + pick.org + '/databases/' + pick.db + '/branches/' + pick.branch;
  if (pick.kind === 'postgres') {
    const r = await call(fetchImpl, base + '/roles', { method: 'POST', headers: H(access), body: JSON.stringify({ name: 'nobossly_reader_' + Date.now().toString(36), inherited_roles: ['pg_read_all_data'] }) });
    const b = r.body || {};
    if ((r.status !== 200 && r.status !== 201) || !b.username || !b.password || !b.access_host_url) return { error: explain(r.status) };
    return { kind: 'postgres', url: 'postgresql://' + encodeURIComponent(b.username) + ':' + encodeURIComponent(b.password) + '@' + b.access_host_url + ':5432/' + encodeURIComponent(b.database_name || 'postgres') };
  }
  const r = await call(fetchImpl, base + '/passwords', { method: 'POST', headers: H(access), body: JSON.stringify({ role: 'reader', name: 'nobossly-reader' }) });
  const b = r.body || {};
  if ((r.status !== 200 && r.status !== 201) || !b.username || !b.plain_text || !b.access_host_url) return { error: explain(r.status) };
  return { kind: 'mysql', url: 'mysql://' + encodeURIComponent(b.username) + ':' + encodeURIComponent(b.plain_text) + '@' + b.access_host_url + '/' + encodeURIComponent(pick.db) };
}

module.exports = { projects, readerLogin, explain };
