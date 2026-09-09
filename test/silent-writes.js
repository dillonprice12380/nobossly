// No write may fail in silence.
//
// Every notification in the product was rejected by the database for months and
// nothing anywhere said so, because all twenty-odd fire-and-forget writes were
// spelled `.then(() => {}, () => {})` — two no-op handlers that throw the error
// on the floor. The behaviour was right (a failed notification must not fail
// the level-up that caused it); the silence was not.
//
// This asserts the pattern stays gone, and that quiet() actually reports.
//
//   node test/silent-writes.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let fail = 0;
const ok = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? '  — ' + detail : ''}`);
};

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

console.log('\nNothing throws an error on the floor:');

const NOOP = /\.then\(\s*\(\)\s*=>\s*\{\}\s*,\s*\(\)\s*=>\s*\{\}\s*\)/;
const offenders = [];
for (const f of jsFiles(path.join(ROOT, 'src'))) {
  const rel = path.relative(ROOT, f);
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    // db.js quotes the old pattern in its own header to explain what it replaced.
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    if (NOOP.test(line)) offenders.push(`${rel}:${i + 1}`);
  });
}
ok('no `.then(() => {}, () => {})` survives in src/', offenders.length === 0,
   offenders.join(', ') || 'clean');

// Every fire-and-forget write should carry a label worth reading in a log.
const labels = [];
for (const f of jsFiles(path.join(ROOT, 'src'))) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/quiet\('([^']*)'\)/g)) labels.push(m[1]);
}
ok('every quiet() call is labelled', labels.length > 0 && labels.every(l => l && l !== 'write'),
   labels.length ? `${labels.length} sites, ${new Set(labels).size} distinct` : 'none found');

console.log('\nquiet() actually reports:');

const { quiet } = require('../src/db');
const said = [];
const realError = console.error;
console.error = (...a) => said.push(a.join(' '));

(async () => {
  try {
    // supabase-js RESOLVES on a database error rather than rejecting, so the
    // failure arrives in the success handler shaped as { error }. That is
    // exactly why these were so easy to miss, and the case that matters most.
    said.length = 0;
    const res = await Promise.resolve({ error: { code: '23514', message: 'violates check constraint' } })
      .then(...quiet('notifications.insert'));
    ok('a resolved { error } is logged', said.length === 1 && /notifications\.insert/.test(said[0]) && /23514/.test(said[0]),
       said[0] || 'nothing logged');
    ok('...and the result still comes back', res && res.error && res.error.code === '23514', 'passed through');

    said.length = 0;
    const thrown = await Promise.reject(new Error('connection reset')).then(...quiet('push_notification:levels'));
    ok('a rejection is logged too', said.length === 1 && /connection reset/.test(said[0]), said[0] || 'nothing logged');
    ok('...and is swallowed, not rethrown', thrown && thrown.error instanceof Error, 'caller continues');

    said.length = 0;
    await Promise.resolve({ data: [{ id: 1 }], error: null }).then(...quiet('activity_events.insert'));
    ok('a success logs nothing', said.length === 0, said[0] || 'silent');
  } finally {
    console.error = realError;
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})();
