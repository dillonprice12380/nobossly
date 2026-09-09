// Emits the ladder_rungs seed, so the database's copy of the ladder is generated
// from src/ladders.js rather than typed alongside it.
//
// Only what SQL has to decide with: the XP floor and the gates. Titles and
// emoji stay in src/ladders.js alone — the database never renders a rung, and a
// second copy of nine paths' worth of names is a duplication with no job.
//
// The database needs the ladder because current_level is decided in SQL now —
// see migrations/2026-09-09_the_score_is_server_owned.sql. Two copies of a
// ten-rung, nine-path ladder is exactly the drift this codebase has been bitten
// by before, so: this script is the only writer, and test/ladder-snapshot.js
// re-runs it and diffs the result against what is checked in. Regenerate with
//
//   node scripts/gen_ladder_sql.js > /tmp/rungs.sql
//
const ladders = require('../src/ladders');

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const rows = [];
for (const path of ladders.SLUGS.concat([ladders.DEFAULT_PATH])) {
  for (const r of ladders.ladderFor(path)) {
    // One string per gate, "c:" for a challenge and "m:" for a milestone, with
    // the title already lowercased and trimmed the way ladders.gateKey() does
    // it — so SQL never has to agree with JS about whitespace, and 100 rows of
    // gates stay small enough to read in a diff.
    const gates = (r.gates || []).map(g => (g.type === 'challenge' ? 'c:' : 'm:') + String(g.title).trim().toLowerCase());
    rows.push(`  (${q(path)}, ${r.level}, ${r.xp_required || 0}, ` +
              `${r.min && r.min > 0 ? r.min : 'null'}, ${q(JSON.stringify(gates))}::jsonb)`);
  }
}
process.stdout.write(
  'insert into ladder_rungs (path, level, xp_required, min_gates, gates) values\n' +
  rows.join(',\n') + '\non conflict (path, level) do update set\n' +
  '  xp_required = excluded.xp_required, min_gates = excluded.min_gates, gates = excluded.gates;\n');
