// NoBossly is for people 18 and older. Every signup gives a date of birth —
// on the signup form, or on the username step after a social sign-in — and is
// turned away below 18 with a neutral message. A short-lived cookie stops the
// same browser from simply trying again with an earlier year.

const MIN_AGE = 18;
const BLOCK_COOKIE = 'nb_age_block';
const BLOCK_MS = 24 * 60 * 60 * 1000;
const MESSAGE = 'NoBossly is for people 18 and older.';

// A real calendar date, not in the future and not before 1900 — or null.
function parseDob(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || s > new Date().toISOString().slice(0, 10)) return null;
  return s;
}

// Whole years old on `today` (a birthday counts on the day itself).
function ageOn(dob, today = new Date()) {
  const [y, m, d] = dob.split('-').map(Number);
  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1, td = today.getUTCDate();
  return ty - y - ((tm < m || (tm === m && td < d)) ? 1 : 0);
}

const isAdult = (dob, today) => ageOn(dob, today) >= MIN_AGE;

const isBlocked = req => !!(req.cookies && req.cookies[BLOCK_COOKIE]);
function block(res) {
  res.cookie(BLOCK_COOKIE, '1', { maxAge: BLOCK_MS, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
}

module.exports = { MIN_AGE, MESSAGE, parseDob, ageOn, isAdult, isBlocked, block };
