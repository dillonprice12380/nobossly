// Leaked-password check (the free-plan stand-in for Supabase's Pro-only
// "leaked password protection"). Asks Have I Been Pwned whether a password has
// appeared in a known data breach, using its k-anonymity range API:
//
//   - the password is hashed with SHA-1 here, on our server;
//   - only the first 5 hex characters of that hash are sent;
//   - the service answers with every breached hash starting with those 5
//     characters (hundreds of them), and we look for ours in that list.
//
// The password, and even its full hash, never leave the server. The
// Add-Padding header makes every response a similar size, so nobody watching
// the traffic can tell anything from how big the answer was.
//
// If the service is slow or down, the check is skipped (fail open): a member
// should never be locked out of signing up because a third party is down.
// https://haveibeenpwned.com/API/v3#PwnedPasswords

const crypto = require('crypto');

const API = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2500;
const MESSAGE = 'That password has appeared in a known data breach, so it is not safe to use. Please choose a different one.';

const sha1 = s => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').toUpperCase();

// How many times the password appears in known breaches: 0 if never,
// null if the check could not be done (timeout, network, bad response).
async function timesPwned(password, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!password || typeof fetchImpl !== 'function') return null;
  const hash = sha1(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(API + prefix, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'NoBossly password check' },
      signal: ctrl.signal
    });
    if (!r || !r.ok) return null;
    const body = await r.text();
    for (const line of body.split('\n')) {
      const [s, n] = line.trim().split(':');
      if (s === suffix) return parseInt(n, 10) || 0;  // padding rows have count 0
    }
    return 0;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The message to show if the password must be refused, or null if it is fine
// (or could not be checked).
async function refusal(password, opts) {
  const n = await timesPwned(password, opts);
  if (n === null) {
    if (!(opts && opts.quiet)) console.warn('[pwned] password check skipped (service unavailable)');
    return null;
  }
  return n > 0 ? MESSAGE : null;
}

module.exports = { timesPwned, refusal, sha1, MESSAGE, API };
