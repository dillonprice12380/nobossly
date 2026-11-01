// Calendar dates as 'YYYY-MM-DD' strings, worked out in UTC so the server's
// time zone never moves a due date or a logging period by a day.

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

// A real calendar date, or null. Accepts a Date too.
function parseDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : iso(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const d = utc(+m[1], +m[2], +m[3]);
  return iso(d) === m[0] ? m[0] : null;   // rejects 2026-02-30
}

const today = (now = new Date()) => iso(now);
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return iso(utc(y, m, d + n)); };

// 'YYYY-MM' helpers.
const parseMonth = v => { const m = /^(\d{4})-(\d{2})$/.exec(String(v || '').trim()); return m && +m[2] >= 1 && +m[2] <= 12 ? m[0] : null; };
const monthOf = s => String(s).slice(0, 7);
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return iso(utc(y, m + n, 1)).slice(0, 7);
}

// Monday of the week containing the date (ISO weeks start on Monday).
function mondayOf(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dow = utc(y, m, d).getUTCDay() || 7;
  return iso(utc(y, m, d - dow + 1));
}

// The ISO week a date falls in, as 'YYYY-Www' (what <input type="week"> sends).
function isoWeek(s) {
  const [y, m, d] = s.split('-').map(Number);
  const t = utc(y, m, d);
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));      // the Thursday decides the year
  const jan1 = utc(t.getUTCFullYear(), 1, 1);
  const w = Math.ceil(((t - jan1) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(w)}`;
}

// Monday of ISO week 'YYYY-Www', or null if that week does not exist.
function weekStart(v) {
  const m = /^(\d{4})-W(\d{2})$/i.exec(String(v || '').trim());
  if (!m) return null;
  const y = +m[1], w = +m[2];
  if (w < 1 || w > 53) return null;
  const monday1 = mondayOf(iso(utc(y, 1, 4)));                   // 4 January is always in week 1
  const out = addDays(monday1, (w - 1) * 7);
  return isoWeek(out) === `${y}-W${pad(w)}` ? out : null;        // week 53 only in long years
}

module.exports = { pad, iso, parseDate, today, addDays, parseMonth, monthOf, addMonths, mondayOf, isoWeek, weekStart };
