// A WordPress site. The member makes an application password (Users → Profile
// → Application Passwords) and pastes the site address, their username and
// it. NoBossly lists users newest first through the REST API, with only their
// ID and registration date, to count sign-ups. WordPress does not record
// sign-ins, so there are no active-user numbers. An application password can
// be revoked at any time from the same screen.

const { resolvePublic } = require('./safety');
const { DAYS } = require('./common');

const MAX_PAGES = 20;   // 2,000 recent users

function parse(body) {
  const b = body || {};
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(b.url || '').trim()) ? String(b.url).trim() : 'https://' + String(b.url || '').trim()); } catch (_) { return { error: 'Enter your site address, e.g. https://example.com' }; }
  if (u.protocol !== 'https:') return { error: 'Your site needs to use https:// so the password is sent safely.' };
  const user = String(b.user || '').trim(), password = String(b.password || '').trim().replace(/\s+/g, ' ');
  if (!user || user.length > 60) return { error: 'Enter your WordPress username.' };
  if (!/^[A-Za-z0-9]{4}( [A-Za-z0-9]{4}){5}$/.test(password) && !/^[A-Za-z0-9]{24}$/.test(password)) return { error: 'Paste the application password WordPress showed you (six groups of four letters and numbers). Not your login password.' };
  const base = u.origin + u.pathname.replace(/\/+$/, '').replace(/\/wp-admin.*$/, '').replace(/\/wp-json.*$/, '');
  return { url: base, host: u.hostname.toLowerCase(), user, password, provider: 'wordpress' };
}

async function get(p, path, { fetchImpl = fetch, lookup, resolve = resolvePublic } = {}) {
  const r = await resolve(p.host, { lookup });
  if (r.error) return { error: r.error };
  let res;
  try {
    res = await fetchImpl(p.url + path, { redirect: 'manual', headers: { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(p.user + ':' + p.password).toString('base64') } });
  } catch (_) { return { status: 0 }; }
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON */ }
  const total = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('x-wp-total')) : NaN;
  return { status: res.status, body, total };
}

const explain = (status, body) => {
  const code = body && body.code;
  if (status === 401 || code === 'rest_not_logged_in' || code === 'incorrect_password' || code === 'invalid_username') return 'WordPress did not accept that username and application password.';
  if (status === 403 || code === 'rest_forbidden_context') return 'That account cannot list users. Use an administrator account, or ask your site admin to make the application password.';
  if (status === 404) return 'The WordPress REST API was not found at that address. Check the site address, and that the REST API is not switched off.';
  if (status >= 300 && status < 400) return 'That address redirects somewhere else. Use the exact address your site lives at (with https://).';
  return 'Your site did not answer properly (' + (status || 'no response') + ').';
};

const LIST = '/wp-json/wp/v2/users?context=edit&per_page=100&orderby=registered_date&order=desc&_fields=id,registered_date';

async function verify(p, opts = {}) {
  const r = await get(p, LIST.replace('per_page=100', 'per_page=1'), opts);
  if (r.error) return { ok: false, error: r.error };
  if (r.status !== 200 || !Array.isArray(r.body)) return { ok: false, error: explain(r.status, r.body) };
  return { ok: true };
}

async function counts(p, cfg, opts = {}) {
  const now = opts.now || Date.now();
  const since = now - DAYS * 86400000;
  const byDay = {};
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await get(p, LIST + '&page=' + page, opts);
    if (r.error) return { error: r.error };
    if (r.status === 400 && page > 1) break;   // past the last page
    if (r.status !== 200 || !Array.isArray(r.body)) return { error: explain(r.status, r.body) };
    if (total === null && isFinite(r.total)) total = r.total;
    let older = false;
    for (const u of r.body) {
      const t = Date.parse(String(u.registered_date || '') + (/[zZ]|[+-]\d\d:?\d\d$/.test(u.registered_date || '') ? '' : 'Z'));
      if (!t) continue;
      if (t < since) { older = true; break; }
      const d = new Date(t).toISOString().slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
    if (older || r.body.length < 100) break;
  }
  return { total, active7: null, active30: null, byDay };
}

module.exports = { parse, verify, counts, explain };
