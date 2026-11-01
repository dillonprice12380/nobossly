// Errors the engines raise, and how the routes tell them apart.
//
//  - EngineError: the member typed something we will not save (no title, a
//    stage the board does not have). Its message is written for them.
//  - NotFound: a board, metric, checklist or row that is not there.
//  - Anything else came from the database. dbError() keeps its code, so a
//    missing table (the migration not applied yet) can be recognised.

class EngineError extends Error {
  constructor(message) { super(message); this.user = true; }
}

class NotFound extends Error {
  constructor(message) { super(message || 'Not found'); this.notFound = true; }
}

// supabase-js resolves with { error } rather than rejecting; turn that into a
// throw that still carries the Postgres / PostgREST code.
function dbError(error) {
  const e = new Error(error.message || String(error));
  e.code = error.code;
  e.db = true;
  return e;
}

function must(res) {
  if (res && res.error) throw dbError(res.error);
  return res ? res.data : null;
}

// Until migrations/2026-11-01_workspace_foundations.sql is applied the tables
// are not there. Same test as src/routes/exchange.js, for any table.
const missing = err => !!err && (err.code === '42P01' || err.code === 'PGRST205' ||
  /does not exist|Could not find the table/i.test(err.message || ''));

module.exports = { EngineError, NotFound, dbError, must, missing };
