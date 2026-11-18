// "Connect with …" for app databases: Supabase, Google (Firebase) and
// PlanetScale. The member signs in there and approves NoBossly; nothing is
// pasted. Each needs NoBossly registered once with that provider (the client
// ID and secret below); until then its button reads "Coming soon" and the
// paste-a-login way stays.
//
// The redirect URI to register is https://nobossly.com/app-data/oauth/<provider>/callback.
// Tokens are kept in the Vault like any other secret; a rotated refresh token
// replaces the old one in place (data_connection_set_secret).

const crypto = require('crypto');
const { call, form } = require('../connections/common');

const SITE = (process.env.SITE_URL || 'https://nobossly.com').replace(/\/$/, '');
const redirectUri = p => SITE + '/app-data/oauth/' + p + '/callback';

const PROVIDERS = {
  supabase: {
    key: 'supabase', label: 'Supabase', env: ['SUPABASE_OAUTH_CLIENT_ID', 'SUPABASE_OAUTH_CLIENT_SECRET'],
    authorize: 'https://api.supabase.com/v1/oauth/authorize', token: 'https://api.supabase.com/v1/oauth/token',
    basic: true, pkce: true, params: {}
  },
  google: {
    key: 'google', label: 'Google', env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    basic: false, pkce: true,
    // Google has no read-only scope that can list Firebase Auth users; this is
    // the narrowest that can. NoBossly only ever lists sign-up and sign-in times.
    params: { scope: 'https://www.googleapis.com/auth/firebase', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
  },
  planetscale: {
    key: 'planetscale', label: 'PlanetScale', env: ['PLANETSCALE_OAUTH_CLIENT_ID', 'PLANETSCALE_OAUTH_CLIENT_SECRET'],
    authorize: 'https://auth.planetscale.com/oauth/authorize', token: 'https://auth.planetscale.com/oauth/token',
    basic: false, pkce: false, params: {}
  }
};

const creds = p => ({ id: process.env[p.env[0]], secret: process.env[p.env[1]] });
const configured = key => { const p = PROVIDERS[key]; return !!(p && process.env[p.env[0]] && process.env[p.env[1]]); };

const b64url = buf => buf.toString('base64url');
function start(key) {
  const p = PROVIDERS[key];
  const state = key + '.' + b64url(crypto.randomBytes(18));
  const verifier = p.pkce ? b64url(crypto.randomBytes(32)) : null;
  const q = Object.assign({ client_id: creds(p).id, redirect_uri: redirectUri(key), response_type: 'code', state }, p.params);
  if (verifier) Object.assign(q, { code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
  return { url: p.authorize + '?' + form(q), state, verifier };
}

const tokenOf = (b, now) => ({ mode: 'oauth', access_token: b.access_token, refresh_token: b.refresh_token || null,
  expires_at: b.expires_in ? now + (Number(b.expires_in) - 120) * 1000 : null, scope: b.scope || null });

async function post(p, body, fetchImpl) {
  const c = creds(p);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (p.basic) headers.Authorization = 'Basic ' + Buffer.from(c.id + ':' + c.secret).toString('base64');
  else Object.assign(body, { client_id: c.id, client_secret: c.secret });
  return call(fetchImpl, p.token, { method: 'POST', headers, body: form(body) });
}

async function exchange(key, code, verifier, { fetchImpl = fetch, now = Date.now() } = {}) {
  const p = PROVIDERS[key];
  const body = { grant_type: 'authorization_code', code, redirect_uri: redirectUri(key) };
  if (verifier) body.code_verifier = verifier;
  const r = await post(p, body, fetchImpl);
  if (r.status !== 200 && r.status !== 201) return { error: p.label + ' did not let NoBossly in. Try connecting again.' };
  if (!r.body || !r.body.access_token) return { error: p.label + ' did not let NoBossly in. Try connecting again.' };
  return { token: tokenOf(r.body, now), raw: r.body };
}

/** A usable access token; refreshes (and calls save with the new secret) when it has run out. */
async function fresh(key, secret, { fetchImpl = fetch, now = Date.now(), save } = {}) {
  if (!secret || secret.mode !== 'oauth') return { error: 'unreadable' };
  if (!secret.expires_at || now < secret.expires_at) return { access: secret.access_token, secret };
  const p = PROVIDERS[key];
  if (!secret.refresh_token || !configured(key)) return { error: p.label + ' access ran out. Connect again.' };
  const r = await post(p, { grant_type: 'refresh_token', refresh_token: secret.refresh_token }, fetchImpl);
  if ((r.status !== 200 && r.status !== 201) || !r.body || !r.body.access_token) return { error: p.label + ' access ran out or was removed. Connect again.' };
  const next = Object.assign(tokenOf(r.body, now), { refresh_token: r.body.refresh_token || secret.refresh_token }, secret.project ? { project: secret.project } : {});
  if (save) await save(next);
  return { access: next.access_token, secret: next };
}

module.exports = { PROVIDERS, configured, start, exchange, fresh, redirectUri, tokenOf };
