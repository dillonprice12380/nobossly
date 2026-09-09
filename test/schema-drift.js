// Does the code write things the database will actually accept?
//
// Four features were live and silently broken by exactly this: the code wrote a
// value the schema rejected, the call site swallowed the error, and nothing
// surfaced. Every notification in the product (eleven types, one of which the
// constraint allowed). Cutting an idea. Saving a coach thread. Deactivating an
// account. None of them threw anywhere a person would see.
//
// Nothing in a unit test hits the database, and the sandbox cannot reach it at
// all, so this compares the code against test/schema-snapshot.json — a dump of
// the real columns and CHECK constraints. Regenerate the snapshot after any
// migration that adds a column or changes a CHECK.
//
//   node test/schema-drift.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema-snapshot.json'), 'utf8'));

let fail = 0;
const problems = [];
const note = (kind, where, what) => { fail++; problems.push(`${kind}  ${where}  ${what}`); };

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Top-level "key: value" pairs of an object literal body, ignoring anything
// nested. Depth-counted rather than regexed, because the values contain commas,
// braces and template strings.
function pairs(body) {
  const out = [];
  let depth = 0, cur = '', key = null;
  for (const ch of body) {
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    if (depth === 0 && ch === ':' && key === null) { key = cur.trim().replace(/^['"]|['"]$/g, ''); cur = ''; continue; }
    if (depth === 0 && ch === ',') { if (key !== null) out.push([key, cur.trim()]); key = null; cur = ''; continue; }
    cur += ch;
  }
  if (key !== null) out.push([key, cur.trim()]);
  return out;
}

// The body of the object literal starting at src[start].
function literal(src, start) {
  let depth = 0, from = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; if (depth === 1) from = i + 1; }
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(from, i); }
  }
  return '';
}

const sources = files(path.join(ROOT, 'src')).concat([path.join(ROOT, 'server.js')]);

for (const file of sources) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  // .from('table') ... .insert|update|upsert({ ... })
  for (const m of src.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 900);
    const w = tail.match(/^\s*\.(insert|update|upsert)\(\s*\{/);
    if (!w) continue;                       // written from a variable — nothing to read here
    const table = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    const where = `${rel}:${line}`;

    const cols = snap.columns[table];
    if (!cols) { note('NO SUCH TABLE  ', where, table); continue; }

    for (const [key, val] of pairs(literal(tail, tail.indexOf('{')))) {
      if (!/^[A-Za-z_]\w*$/.test(key)) continue;
      if (!cols.includes(key)) note('NO SUCH COLUMN ', where, `${table}.${key}`);
      const allowed = (snap.enums[table] || {})[key];
      const lit = val.match(/^'([^']*)'$|^"([^"]*)"$/);
      if (allowed && lit) {
        const v = lit[1] !== undefined ? lit[1] : lit[2];
        if (!allowed.includes(v)) note('REJECTED VALUE ', where, `${table}.${key} = '${v}' (allowed: ${allowed.join(', ')})`);
      }
    }
  }

  // push_notification(ntype) writes notifications.type. This is the one that
  // broke every notification in the product, and it never looks like a write.
  const allowedTypes = (snap.enums.notifications || {}).type || [];
  for (const m of src.matchAll(/ntype:\s*'([^']+)'/g)) {
    if (allowedTypes.length && !allowedTypes.includes(m[1])) {
      note('REJECTED VALUE ', `${rel}:${src.slice(0, m.index).split('\n').length}`,
           `notifications.type = '${m[1]}' via push_notification (allowed: ${allowedTypes.join(', ')})`);
    }
  }

  // activity.record(sb, user, KIND, …) writes activity_events.kind.
  const allowedKinds = (snap.enums.activity_events || {}).kind || [];
  for (const m of src.matchAll(/activity\.record\([^,]+,[^,]+,\s*'([^']+)'/g)) {
    if (allowedKinds.length && !allowedKinds.includes(m[1])) {
      note('REJECTED VALUE ', `${rel}:${src.slice(0, m.index).split('\n').length}`,
           `activity_events.kind = '${m[1]}' (allowed: ${allowedKinds.join(', ')})`);
    }
  }
}

console.log('\nEvery write matches the schema:');
if (problems.length) problems.forEach(p => console.log('  ✗ ' + p));
else console.log(`  ✓ ${sources.length} source files, ${Object.keys(snap.columns).length} tables, ${Object.values(snap.enums).reduce((n, t) => n + Object.keys(t).length, 0)} enum-constrained columns  — clean`);

console.log(fail ? `\n${fail} failed` : '\nAll good');
process.exit(fail ? 1 : 0);
