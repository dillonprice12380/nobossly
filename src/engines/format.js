// How numbers read on the workspace pages: money like $1,234 (cents only when
// there are some), percent with %, counts with thousands separators.

const grouped = (n, digits) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function money(v) {
  if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '';
  const n = Number(v);
  const cents = Math.round(Math.abs(n) * 100) % 100 !== 0;
  return (n < 0 ? '−$' : '$') + grouped(Math.abs(n), cents ? 2 : 0);
}

function number(v) {
  if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '';
  const n = Number(v);
  return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function percent(v) {
  const s = number(v);
  return s === '' ? '' : s + '%';
}

// By metric unit ('count' | 'money' | 'percent') or field type ('money' | 'number').
function byUnit(unit, v) {
  if (unit === 'money') return money(v);
  if (unit === 'percent') return percent(v);
  return number(v);
}

// A change, signed: +$200, −3, +1.5%.
function change(unit, v) {
  if (v === null || v === undefined || !isFinite(Number(v))) return '';
  const n = Number(v);
  if (n === 0) return unit === 'money' ? '$0' : unit === 'percent' ? '0%' : '0';
  return (n > 0 ? '+' : '') + byUnit(unit, n);
}

// "3 Nov 2026" from 'YYYY-MM-DD', without the server's time zone getting a say.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function date(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
function monthLabel(ym, short) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ym || ''));
  if (!m) return '';
  return short ? `${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}` : `${MONTHS_LONG[Number(m[2]) - 1]} ${m[1]}`;
}

module.exports = { money, number, percent, byUnit, change, date, monthLabel, MONTHS, MONTHS_LONG };
