// Importing payments into the income log from a CSV export: a bank statement,
// Stripe, PayPal, Etsy, Shopify, Gumroad, a spreadsheet. Pure functions, no
// database: src/routes/budget.js reads the file, shows a preview with these,
// and saves what the member confirms.
//
// Only money coming in is imported. Rows that are money going out, refunds,
// failed or pending payments, future dates and payments already in the log
// are skipped, and the preview says why.

const MAX_ROWS = 5000;

// ---------------------------------------------------------------- CSV text

// The delimiter a file uses: whichever of , ; tab splits the first lines into
// the most, most consistently.
function delimiterOf(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim()).slice(0, 10);
  let best = ',', score = -1;
  for (const d of [',', ';', '\t']) {
    const counts = lines.map(l => splitLine(l, d).length);
    const most = Math.max(0, ...counts);
    const same = counts.filter(c => c === most).length;
    const s = most > 1 ? most * 10 + same : 0;
    if (s > score) { score = s; best = d; }
  }
  return best;
}
const splitLine = (line, d) => parse(line, d)[0] || [];

// RFC 4180: quoted fields, "" for a quote, newlines inside quotes, CRLF.
function parse(text, delimiter) {
  const s = String(text || '').replace(/^﻿/, '');
  const d = delimiter || delimiterOf(s);
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field.trim() === '') { quoted = true; field = ''; }
    else if (c === d) { row.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 20) break;
    } else field += c;
  }
  row.push(field.trim());
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------- columns

const DATE_H = /^(datum|fecha|data|date de l'op[ée]ration|buchungstag|date|transaction date|trans(action)?\.? date|posted( date)?|posting date|booking date|value date|created( date)?( \(utc\))?|created at|sale date|order date|date paid|paid at|payment date|completed date|available on)$/i;
const IN_H = /^(credit|credits|credit amount|deposit|deposits|paid in|money in|amount in|incoming|received)$/i;
const OUT_H = /^(debit|debits|debit amount|withdrawal|withdrawals|paid out|money out|amount out|outgoing)$/i;
const GROSS_H = /^(bedrag|betrag|importe|montant|valor|importo|beløb|belopp|gross|gross amount|amount|transaction amount|total|order total|order value|sale amount|price|value|amount \(usd\)|amount usd)$/i;
const NET_H = /^(net|net amount)$/i;
const DESC_H = /^(omschrijving|beschreibung|verwendungszweck|descripci[óo]n|concepto|libell[ée]|descri[çc][ãa]o|descrizione|description|details|transaction details|narrative|memo|payee|name|customer( name| email)?|from|counterparty|merchant|item( title| name)?|title|product|reference|ref|notes?|statement description)$/i;
const STATUS_H = /^(status|state|payment status|transaction status)$/i;
const TYPE_H = /^(type|transaction type|category)$/i;

// Which row holds the column names: the first of the opening lines with a
// date-like header and at least one other column. Bank files often start with
// an account summary above it.
function headerRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i];
    if (r.length >= 2 && r.some(c => DATE_H.test(c) || /date/i.test(c)) && r.some(c => GROSS_H.test(c) || IN_H.test(c) || NET_H.test(c) || /amount/i.test(c))) return i;
  }
  return 0;
}

const pick = (headers, ...tests) => {
  for (const t of tests) { const i = headers.findIndex(h => t.test(h)); if (i >= 0) return i; }
  return -1;
};

// A first guess at which column is which. -1 = none.
function guessColumns(headers) {
  const h = headers.map(x => String(x || '').trim());
  const credit = pick(h, IN_H);
  return {
    date: pick(h, DATE_H, /date/i),
    // Money in: a credit column if the file splits in and out, else the gross
    // amount (what you were paid, before fees, is what tax is worked out on).
    amount: credit >= 0 ? credit : pick(h, GROSS_H, /amount/i, NET_H),
    debit: pick(h, OUT_H),
    description: pick(h, DESC_H, /desc|name|memo|detail/i),
    status: pick(h, STATUS_H),
    type: pick(h, TYPE_H)
  };
}

// When the headers say nothing we know (another language, a home-made sheet),
// guess from the values: the date column is the one that reads as dates, the
// amount the numeric one beside it that is not a running balance, and the
// description the wordiest text.
function fillFromValues(cols, body) {
  const sample = body.slice(0, 30);
  const width = Math.max(0, ...sample.map(r => r.length));
  const share = (i, f) => { const v = sample.map(r => r[i]).filter(x => x !== undefined && x !== ''); return v.length ? v.filter(f).length / v.length : 0; };
  const out = Object.assign({}, cols);
  const taken = () => [out.date, out.amount, out.debit, out.description, out.status, out.type].filter(i => i >= 0);
  if (out.date < 0) for (let i = 0; i < width; i++) if (share(i, v => dateOf(v)) >= 0.8) { out.date = i; break; }
  if (out.amount < 0) {
    const numeric = [];
    for (let i = 0; i < width; i++) if (!taken().includes(i) && share(i, v => amountOf(v, { comma: true }) !== null || amountOf(v) !== null) >= 0.8) numeric.push(i);
    // A running balance never goes negative in step with the rows; an amount
    // column usually has money both ways. Prefer the first one with a minus.
    out.amount = numeric.find(i => sample.some(r => /^\s*[-−(]/.test(r[i] || ''))) ?? (numeric[0] ?? -1);
  }
  if (out.description < 0) {
    let best = -1, len = 0;
    for (let i = 0; i < width; i++) {
      if (taken().includes(i)) continue;
      const avg = sample.reduce((n, r) => n + (/[A-Za-z]/.test(r[i] || '') ? String(r[i]).length : 0), 0) / (sample.length || 1);
      if (avg > len) { len = avg; best = i; }
    }
    out.description = best;
  }
  return out;
}

// Where the file came from, from its headers, for the "From" field.
function sourceOf(headers) {
  const h = headers.join(' | ').toLowerCase();
  if (/balance impact|gross.*fee.*net|from email address/.test(h)) return 'PayPal';
  if (/payment intent|customer email|seller message|amount refunded|captured/.test(h)) return 'Stripe';
  if (/sale date.*order id|etsy|buyer user ?id/.test(h)) return 'Etsy';
  if (/payout id|shopify|order name|financial status/.test(h)) return 'Shopify';
  if (/gumroad|purchase email/.test(h)) return 'Gumroad';
  if (/balance|credit|debit|deposit|withdrawal|posting|cheque|check number/.test(h)) return 'Bank';
  return '';
}

// ---------------------------------------------------------------- values

// "$1,234.50", "1.234,50", "(12.00)", "-12", "12.00 CR", "USD 40" → a number,
// or null when it is not one. Negative means money out.
function amountOf(raw, { comma = false } = {}) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bDR\b|\bdebit\b/i.test(s)) sign = -1;
  s = s.replace(/\b(CR|DR|USD|EUR|GBP|CAD|AUD)\b/gi, '').replace(/[$€£¥\s ]/g, '');
  if (/^[-−–]/.test(s)) { sign = -sign; s = s.slice(1); }
  if (/[-−–]$/.test(s)) { sign = -sign; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  // Decimal comma: a semicolon file ("12,50"), or "1.234,56" anywhere.
  if (comma || /^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s) * sign;
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = w => MONTHS[String(w).toLowerCase().slice(0, 4)] || MONTHS[String(w).toLowerCase().slice(0, 3)] || null;
const pad = n => String(n).padStart(2, '0');
const valid = (y, m, d) => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const year = y => (y < 100 ? 2000 + y : y);

// Whether a file's slashed dates are day-first: true if any first part is
// over 12, false if any second part is, else null (US order is assumed).
function dayFirst(values) {
  let dmy = false, mdy = false;
  for (const v of values) {
    const m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(String(v || '').trim());
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  return dmy && !mdy ? true : mdy && !dmy ? false : null;
}

// A date as it appears in an export → 'YYYY-MM-DD', or null.
function dateOf(raw, dmy = null) {
  const s = String(raw == null ? '' : raw).trim();
  let m;
  if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s))) return valid(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s))) return dmy ? valid(year(+m[3]), +m[2], +m[1]) : valid(year(+m[3]), +m[1], +m[2]);
  if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/.exec(s))) { const mo = monthNum(m[1]); return mo ? valid(+m[3], mo, +m[2]) : null; }
  if ((m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]+(\d{2,4})/.exec(s))) { const mo = monthNum(m[2]); return mo ? valid(year(+m[3]), mo, +m[1]) : null; }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return valid(+m[1], +m[2], +m[3]);
  return null;
}

// Statuses that mean the money did not (or not yet) arrive.
const NOT_PAID = /refund|reversed|reversal|fail|declin|void|cancel|pending|dispute|chargeback|denied|expired|unpaid|incomplete|uncaptured|requires/i;
// Types that are money moving between your own accounts, not income.
const NOT_INCOME = /transfer|withdrawal|payout|general currency conversion|bank deposit to pp|hold|reserve|fee|tax remittance/i;
// A bank line that is a payout from a payment platform: the same money as the
// platform's own export, so importing both would count it twice.
const PLATFORM_PAYOUT = /\b(stripe|paypal|shopify|etsy|square|squareup|gumroad|lemon ?squeezy|paddle|patreon|substack|kajabi|teachable)\b/i;

// What a subscription payment usually says about itself.
const RECURRING = /subscri|recurring|renewal|membership|\bplan\b|retainer|patreon|\bmember\b/i;

const centsKey = (date, amount, source) => date + '|' + Math.round(amount * 100) + '|' + String(source || '').toLowerCase().slice(0, 80);

/**
 * What a file would import. text: the CSV. opts: { columns (as guessColumns
 * returns; guessed when missing), source (the "From" label for rows with no
 * description), recurring: 'none' | 'matching' | 'all', today: 'YYYY-MM-DD',
 * existing: [{ entry_date, amount, source }] already in the log }.
 * Returns { headers, columns, source, rows: [{ line, date, amount, source,
 * description, recurring, skip }], counts }.
 */
function plan(text, opts = {}) {
  const delimiter = delimiterOf(text);
  const all = parse(text, delimiter);
  const h = headerRow(all);
  const headers = (all[h] || []).map((x, i) => x || 'Column ' + (i + 1));
  const body = all.slice(h + 1).slice(0, MAX_ROWS);
  const columns = Object.assign(fillFromValues(guessColumns(headers), body), opts.columns || {});
  const source = String(opts.source == null ? sourceOf(headers) : opts.source).trim().slice(0, 40);
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const comma = delimiter === ';';
  const dmy = columns.date >= 0 ? dayFirst(body.map(r => r[columns.date])) : null;
  const seen = new Set((opts.existing || []).map(e => centsKey(String(e.entry_date).slice(0, 10), Number(e.amount), e.source)));
  const rec = ['none', 'matching', 'all'].includes(opts.recurring) ? opts.recurring : 'matching';
  const bankFile = source === 'Bank' || sourceOf(headers) === 'Bank';

  const rows = body.map((r, i) => {
    const cell = k => (columns[k] >= 0 ? r[columns[k]] || '' : '');
    const date = dateOf(cell('date'), dmy);
    let amount = amountOf(cell('amount'), { comma });
    if ((amount === null || amount === 0) && columns.debit >= 0 && amountOf(cell('debit'), { comma })) amount = -Math.abs(amountOf(cell('debit'), { comma }));
    const description = String(cell('description')).replace(/\s+/g, ' ').trim().slice(0, 200);
    const from = (description || source || 'Imported').slice(0, 80);
    const out = { row: i + 1, date, amount, source: from, description: description && description !== from ? description : null, recurring: false, skip: null };
    if (columns.date < 0 || columns.amount < 0) out.skip = 'columns';
    else if (!date) out.skip = 'date';
    else if (amount === null) out.skip = 'amount';
    else if (amount <= 0) out.skip = 'out';
    else if (date > today) out.skip = 'future';
    else if (columns.status >= 0 && NOT_PAID.test(cell('status'))) out.skip = 'status';
    else if (columns.type >= 0 && NOT_INCOME.test(cell('type'))) out.skip = 'transfer';
    else if (amount > 1e8) out.skip = 'amount';
    else if (bankFile && PLATFORM_PAYOUT.test(description)) { out.payout = true; if (opts.skipPayouts) out.skip = 'payout'; }
    if (!out.skip) {
      const key = centsKey(date, amount, from);
      if (seen.has(key)) out.skip = 'duplicate'; else seen.add(key);
    }
    if (!out.skip) out.recurring = rec === 'all' || (rec === 'matching' && RECURRING.test(description + ' ' + cell('type')));
    return out;
  });
  const counts = { total: rows.length, import: 0, total_amount: 0, recurring: 0, payouts: rows.filter(r => r.payout).length };
  for (const r of rows) {
    if (r.skip) counts[r.skip] = (counts[r.skip] || 0) + 1;
    else { counts.import++; counts.total_amount = Math.round((counts.total_amount + r.amount) * 100) / 100; if (r.recurring) counts.recurring++; }
  }
  return { headers, columns, source, recurring: rec, skipPayouts: !!opts.skipPayouts, rows, counts, truncated: all.length - h - 1 > MAX_ROWS };
}

const SKIP_LABEL = {
  out: 'money going out', payout: 'a payout from a payment platform', status: 'refunded, failed or pending', transfer: 'a transfer, payout or fee',
  duplicate: 'already in your income log', future: 'dated in the future', date: 'no date we could read',
  amount: 'no amount we could read', columns: 'date or amount column not chosen'
};

module.exports = { MAX_ROWS, parse, delimiterOf, headerRow, guessColumns, fillFromValues, sourceOf, amountOf, dateOf, dayFirst, plan, SKIP_LABEL };
