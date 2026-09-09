// Writes that must not fail their caller.
//
// Some writes are deliberately fire-and-forget. A notification that cannot be
// saved should not fail the level-up that triggered it; an analytics row should
// not fail the page. That reasoning is sound, and the twenty-four call sites
// that did it were right to.
//
// What was not sound: every one of them discarded the error entirely, with
// `.then(() => {}, () => {})`. So when a stale CHECK constraint began rejecting
// eleven of the twelve notification types the product sends, nothing anywhere
// said so — not a log line, not a metric. The bell was empty for months and the
// only way to find out was to run the insert by hand against production.
//
// "Safe to ignore" is not the same as "safe to hide". quiet() keeps the
// behaviour exactly — the promise still resolves, the caller still continues —
// and removes the silence.
//
//   sb.rpc('push_notification', {…}).then(...quiet('notify: level-up'))
//
// It returns the [onFulfilled, onRejected] pair so it spreads straight into
// .then(), which makes it a drop-in for the two no-ops it replaces.

function quiet(label) {
  return [
    // supabase-js resolves rather than rejects on a database error, so the
    // failure arrives here, in the SUCCESS handler, shaped as { error }. That
    // is precisely why these were so easy to miss.
    (res) => {
      // The client wrapper in src/supabase.js already reports write failures
      // and marks them, so the same error is not printed twice — once as
      // `notifications.insert` and again as `push_notification:levels`.
      if (res && res.error && !res.__dbLogged) {
        console.error('[db] ' + label + ' failed:',
                      res.error.code || '', res.error.message || res.error);
      }
      return res;
    },
    // A genuine throw: the network, a bad client, an exception in a trigger
    // surfaced as a rejection.
    (err) => {
      console.error('[db] ' + label + ' threw:', (err && err.message) || err);
      return { error: err };
    }
  ];
}

module.exports = { quiet };
