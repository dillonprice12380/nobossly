// Firebase Authentication. The member makes a service account with only the
// "Firebase Authentication Viewer" role and pastes its JSON key. NoBossly
// signs a short-lived token with it and lists users through the Identity
// Toolkit API: sign-up time and last sign-in for each, never anything else.
// If Google says the key can also change or delete users, it is refused.

const crypto = require('crypto');
const { call } = require('../connections/common');
const { DAYS } = require('./common');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_PAGES = 50;   // 50,000 users

function parse(raw) {
  let k;
  try { k = JSON.parse(String(raw || '').trim()); } catch (_) { return { error: 'Paste the whole JSON key file (it starts with { and ends with }).' }; }
  if (!k || k.type !== 'service_account') return { error: 'That is not a service account key. Download a JSON key for a service account.' };
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(String(k.project_id || ''))) return { error: 'The key has no project ID in it.' };
  if (!/^[^@\s]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(String(k.client_email || ''))) return { error: 'The key has no service account email in it.' };
  if (!/-----BEGIN PRIVATE KEY-----/.test(String(k.private_key || ''))) return { error: 'The key has no private key in it.' };
  return { project: k.project_id, email: k.client_email, key: k.private_key, keyId: k.private_key_id || null, provider: 'firebase', host: k.project_id + ' (Firebase)' };
}

const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function assertion(p, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = b64(Object.assign({ alg: 'RS256', typ: 'JWT' }, p.keyId ? { kid: p.keyId } : {}));
  const body = b64({ iss: p.email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 600 });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(p.key).toString('base64url');
  return head + '.' + body + '.' + sig;
}

async function token(p, fetchImpl, now) {
  let a;
  try { a = assertion(p, now); } catch (_) { return { error: 'The private key in that file could not be read.' }; }
  const r = await call(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: a }).toString() });
  if (r.status !== 200 || !r.body || !r.body.access_token) return { error: 'Google did not accept that key. It may have been deleted; make a new one.' };
  return { token: r.body.access_token };
}

const explain = (status) => (status === 403 ? 'That service account cannot read users. Give it the Firebase Authentication Viewer role.'
  : status === 404 ? 'That Firebase project was not found.'
  : status === 429 ? 'Google asked us to slow down. We will try again shortly.'
  : 'Google did not answer properly (' + (status || 'no response') + '). We will try again later.');

// Permissions that would let the key change users; any of them and it is refused.
const WRITE_PERMS = ['firebaseauth.users.update', 'firebaseauth.users.delete', 'firebaseauth.users.create'];

async function verify(p, { fetchImpl = fetch, now = Date.now() } = {}) {
  const t = await token(p, fetchImpl, now);
  if (t.error) return { ok: false, error: t.error };
  const auth = { Authorization: 'Bearer ' + t.token, 'Content-Type': 'application/json' };
  const perms = await call(fetchImpl, 'https://cloudresourcemanager.googleapis.com/v1/projects/' + p.project + ':testIamPermissions', { method: 'POST', headers: auth, body: JSON.stringify({ permissions: WRITE_PERMS }) });
  if (perms.status === 200 && perms.body && Array.isArray(perms.body.permissions) && perms.body.permissions.length) {
    return { ok: false, error: 'That service account can change or delete users. Give it only the Firebase Authentication Viewer role.' };
  }
  const r = await call(fetchImpl, 'https://identitytoolkit.googleapis.com/v1/projects/' + p.project + '/accounts:batchGet?maxResults=1', { headers: auth });
  if (r.status !== 200) return { ok: false, error: explain(r.status) };
  return { ok: true };
}

const ms = v => { const n = Number(v); return isFinite(n) && n > 0 ? n : (v ? Date.parse(v) || null : null); };

// The member's Firebase projects, after "Connect with Google".
async function projects(access, { fetchImpl = fetch } = {}) {
  const r = await call(fetchImpl, 'https://firebase.googleapis.com/v1beta1/projects?pageSize=100', { headers: { Authorization: 'Bearer ' + access } });
  if (r.status !== 200 || !r.body) return { error: explain(r.status) };
  return { projects: (r.body.results || []).filter(x => /^[a-z][a-z0-9-]{4,29}$/.test(x.projectId || '')).map(x => ({ id: x.projectId, name: x.displayName || x.projectId, note: x.projectId })) };
}

async function counts(p, cfg, { fetchImpl = fetch, now = Date.now() } = {}) {
  // After "Connect with Google" the member's own token is used; otherwise the service account's.
  const t = p.access ? { token: p.access } : await token(p, fetchImpl, now);
  if (t.error) return { error: t.error };
  const since = now - DAYS * 86400000, d7 = now - 7 * 86400000, d30 = now - 30 * 86400000;
  let total = 0, active7 = 0, active30 = 0, next = null;
  const byDay = {};
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = 'https://identitytoolkit.googleapis.com/v1/projects/' + p.project + '/accounts:batchGet?maxResults=1000' + (next ? '&nextPageToken=' + encodeURIComponent(next) : '');
    const r = await call(fetchImpl, url, { headers: { Authorization: 'Bearer ' + t.token } });
    if (r.status !== 200 || !r.body) return { error: explain(r.status) };
    for (const u of r.body.users || []) {
      total++;
      const made = ms(u.createdAt);
      if (made && made >= since) { const d = new Date(made).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
      const seen = Math.max(ms(u.lastLoginAt) || 0, ms(u.lastRefreshAt) || 0);
      if (seen >= d7) active7++;
      if (seen >= d30) active30++;
    }
    next = r.body.nextPageToken;
    if (!next) break;
  }
  return { total, active7, active30, byDay };
}

module.exports = { parse, verify, counts, projects, assertion, WRITE_PERMS };
