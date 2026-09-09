// No write may fail in silence.
//
// Two separate mechanisms hid failures in this codebase, and between them they
// covered every write there is:
//
//   1. Fire-and-forget writes spelled `.then(() => {}, () => {})` — two no-op
//      handlers that discard the result. Correct behaviour (a notification that
//      cannot be saved must not fail the level-up that caused it), silent
//      implementation.
//
//   2. Awaited writes inside try/catch. supabase-js RESOLVES on a database
//      error rather than rejecting, so the catch never runs. A hundred and
//      seventeen writes are written this way. It reads as careful and is, for a
//      database error, exactly as silent as no handling at all.
//
// Between them, a stale CHECK constraint rejected every notification in the
// product for months with nothing in any log.
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
    // db.js and supabase.js quote the old pattern in their headers to explain
    // what they replaced.
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    if (NOOP.test(line)) offenders.push(`${rel}:${i + 1}`);
  });
}
ok('no `.then(() => {}, () => {})` survives in src/', offenders.length === 0,
   offenders.join(', ') || 'clean');

const labels = [];
for (const f of jsFiles(path.join(ROOT, 'src'))) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/quiet\('([^']*)'\)/g)) labels.push(m[1]);
}
ok('every quiet() call is labelled', labels.length > 0 && labels.every(l => l && l !== 'write'),
   labels.length ? `${labels.length} sites, ${new Set(labels).size} distinct` : 'none found');

// Every client handed to the app must carry the write logging. A raw
// createClient() slipping back into src/supabase.js is how this regresses.
{
  const src = fs.readFileSync(path.join(ROOT, 'src/supabase.js'), 'utf8');
  const makers = ['anonClient', 'userClient', 'serviceClient'];
  const unwrapped = makers.filter(m => {
    const body = src.slice(src.indexOf('function ' + m), src.indexOf('function ' + m) + 420);
    return !/withWriteLogging\(/.test(body);
  });
  ok('every client factory wraps its client', unwrapped.length === 0, unwrapped.join(', ') || makers.join(', '));
}

const { quiet } = require('../src/db');
const { withWriteLogging } = require('../src/supabase');

// A stand-in PostgrestBuilder: thenable, and its filter methods return `this`,
// which is what lets one `then` override cover an entire chain.
const builder = (result) => ({
  eq() { return this; }, select() { return this; }, in() { return this; },
  then(okFn, errFn) { return Promise.resolve(result).then(okFn, errFn); }
});
const fakeClient = (result) => withWriteLogging({
  from() {
    return { insert: () => builder(result), update: () => builder(result),
             upsert: () => builder(result), delete: () => builder(result) };
  },
  rpc() { return builder(result); }
});

// Capture only our own lines. Node writes its deprecation warnings through
// console.error too, and one of them landed in the middle of an assertion and
// failed it — the test reporting a bug in itself.
const said = [];
const realError = console.error;
console.error = (...a) => {
  const line = a.join(' ');
  if (line.startsWith('[db]')) said.push(line);
  else realError(...a);
};

(async () => {
  try {
    console.log('\nquiet() reports fire-and-forget failures:');

    said.length = 0;
    const res = await Promise.resolve({ error: { code: '23514', message: 'violates check constraint' } })
      .then(...quiet('notifications.insert'));
    ok('a resolved { error } is logged', said.length === 1 && /notifications\.insert/.test(said[0]) && /23514/.test(said[0]),
       said[0] || 'nothing logged');
    ok('...and the result still comes back', !!(res && res.error && res.error.code === '23514'), 'passed through');

    said.length = 0;
    const thrown = await Promise.reject(new Error('connection reset')).then(...quiet('push_notification:levels'));
    ok('a rejection is logged too', said.length === 1 && /connection reset/.test(said[0]), said[0] || 'nothing logged');
    ok('...and is swallowed, not rethrown', !!(thrown && thrown.error instanceof Error), 'caller continues');

    said.length = 0;
    await Promise.resolve({ data: [{ id: 1 }], error: null }).then(...quiet('activity_events.insert'));
    ok('a success logs nothing', said.length === 0, said[0] || 'silent');

    console.log('\nThe client reports awaited failures, without changing control flow:');

    // The case that was invisible everywhere: an awaited write inside a
    // try/catch. supabase-js resolves, so the catch never runs.
    said.length = 0;
    let reached = false;
    try {
      await fakeClient({ data: null, error: { code: '23514', message: 'violates check constraint' } })
        .from('notifications').insert({ type: 'levels' });
      reached = true;
    } catch (_) { /* unreachable — which is the whole problem */ }
    ok('an awaited write that fails is logged',
       said.length === 1 && /notifications\.insert/.test(said[0]), said[0] || 'nothing logged');
    ok('...and still does not throw, exactly as before', reached, 'control flow unchanged');

    said.length = 0;
    await fakeClient({ error: { code: '42501', message: 'permission denied' } })
      .from('profiles').update({ x: 1 }).eq('id', 'u').select();
    ok('the wrapper survives .eq().select() chaining',
       said.length === 1 && /profiles\.update/.test(said[0]), said[0] || 'nothing logged');

    // push_notification is an rpc — the call that was failing for every
    // notification type in the product.
    said.length = 0;
    await fakeClient({ error: { code: '23514', message: 'violates check constraint' } })
      .rpc('push_notification', { ntype: 'levels' });
    ok('rpc failures are logged', said.length === 1 && /rpc push_notification/.test(said[0]),
       said[0] || 'nothing logged');

    said.length = 0;
    const good = await fakeClient({ data: [{ id: 7 }], error: null }).from('tasks').insert({});
    ok('a successful write logs nothing', said.length === 0, said[0] || 'silent');
    ok('...and still returns its data', !!(good && good.data && good.data[0].id === 7), 'data intact');

    // The two layers must not both report the same failure.
    said.length = 0;
    await fakeClient({ error: { code: '23514', message: 'violates check constraint' } })
      .rpc('push_notification', {}).then(...quiet('push_notification:levels'));
    ok('a failure is reported once, not twice', said.length === 1, said.length + ' line(s)');
  } finally {
    console.error = realError;
  }

  console.log(fail ? `\n${fail} failed` : '\nAll good');
  process.exit(fail ? 1 : 0);
})();
