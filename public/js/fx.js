/* ============================================================
   NoBossly celebration FX.

   Four full-screen moments, all of them a hosted video clip played edge to
   edge. The clip is the whole effect — art and audio both — so this file is
   now the shell around one: buffer it early, stage it, get out of the way.

     nbFX.accepted()     — CHALLENGE ACCEPTED   Challenge Accepted.mp4
     nbFX.completed()    — CHALLENGE COMPLETE   Level Complete.mp4
     nbFX.levelUp(n, t)  — LEVEL UP             Level Complete.mp4
     nbFX.mastered()     — MASTERED NOBOSSLY    You're the Boss Now (1).mp4
                           The final rung. Fires once ever.

   Rules this file keeps:
   - The overlay is pointer-events:none, so a celebration can never eat a
     click meant for the page underneath.
   - Any click or key cuts it short. Nobody is trapped watching a video.
   - prefers-reduced-motion gets a plain line and no clip at all.
   - The overlay is torn down the moment the clip ends, errors, or stalls,
     including when the tab is hidden mid-flight.
   ============================================================ */
(function () {
  if (window.nbFX) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the shared shell ---------- */

  function stage(cardHTML, variant, ttl, onMount) {
    var overlay = document.createElement('div');
    overlay.className = 'nb-fx-overlay nb-fx-' + variant;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = cardHTML;
    document.body.appendChild(overlay);

    var done = false;

    function end() {
      if (done) return;
      done = true;
      document.removeEventListener('click', end, true);
      document.removeEventListener('keydown', end, true);
      document.removeEventListener('visibilitychange', onHide);
      overlay.classList.add('nb-fx-out');
      setTimeout(function () { overlay.remove(); }, 260);
    }
    function onHide() { if (document.hidden) end(); }

    // Any input cuts it short, and a backgrounded tab tears it down rather
    // than leaving a clip playing to nobody.
    document.addEventListener('click', end, true);
    document.addEventListener('keydown', end, true);
    document.addEventListener('visibilitychange', onHide);

    // ttl is a ceiling, not a schedule — onMount can finish sooner (a video
    // ending) or bail out (a clip that fails to load).
    setTimeout(end, reduce ? 1400 : ttl);
    if (onMount) onMount(overlay, end);
    return end;
  }

  /* ---------- Hosted clips ----------
     Every celebration is a video. They share everything except the file and
     the reduced-motion line, so they share the code too.

     Hotlinked from the same R2 bucket the site already serves its images from.
     head.ejs preconnects to it, so DNS and TLS are off the critical path. */

  var CLIPS = {
    accepted: 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/Challenge%20Accepted.mp4',
    completed: 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/Level%20Complete.mp4',
    levelUp: 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/Level%20Complete.mp4',
    mastered: "https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/You're%20the%20Boss%20Now%20(1).mp4"
  };

  // Buffered ahead of the moment that needs it. The popup then adopts this
  // exact element rather than starting a fresh download at the worst possible
  // time — which is what made the first version feel slow.
  // Keyed by URL rather than by moment, so two celebrations sharing a clip
  // share the buffer instead of fetching it twice.
  var warm = {};

  function warmClip(name) {
    var url = CLIPS[name];
    if (reduce || !url) return;
    if (warm[url] && warm[url].isConnected) return;
    var v = document.createElement('video');
    v.className = 'nb-fx-video nb-fx-warm';
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.muted = true;              // a muted element may buffer without a gesture
    v.src = url;
    document.body.appendChild(v);
    try { v.load(); } catch (_) { /* preload is an optimisation, never required */ }
    warm[url] = v;
  }

  function playClip(name, plainText, ceiling) {
    // A full-screen video is motion by definition, so reduced motion gets the
    // confirmation as a plain line instead of the clip.
    if (reduce) {
      stage('<p class="nb-fx-plain">' + plainText + '</p>', 'plain', 1600);
      return;
    }

    // A backstop, not a schedule: the overlay closes on 'ended', on an error,
    // or on the stall check below, and any click or key cuts it short. This
    // only catches a clip that plays but never signals it finished, so it has
    // to be longer than the clip itself or it would truncate a good one.
    var MAX = ceiling || 20000;

    return stage('', 'clip', MAX, function (overlay, end) {
      // Adopt the preloaded element if there is one — it is already buffered,
      // so playback starts on the same frame instead of after a round trip.
      var url = CLIPS[name];
      var v = (warm[url] && warm[url].isConnected) ? warm[url] : null;
      warm[url] = null;
      if (v) {
        v.classList.remove('nb-fx-warm');
      } else {
        v = document.createElement('video');
        v.className = 'nb-fx-video';
        v.setAttribute('playsinline', '');
        v.preload = 'auto';
        v.src = url;
      }
      overlay.appendChild(v);

      var settled = false;
      var give = function () { if (!settled) { settled = true; end(); } };

      v.addEventListener('ended', give);
      v.addEventListener('error', give);
      // A clip that never becomes playable (offline, blocked, 404) should not
      // hold the screen for the full ceiling.
      var stall = setTimeout(function () { if (v.readyState < 2) give(); }, 6000);
      v.addEventListener('loadeddata', function () { clearTimeout(stall); });

      // Ask for sound; on refusal mute and play anyway, so the visual always
      // runs even where autoplay policy will not allow audio.
      v.muted = false;
      var withSound = v.play();
      if (withSound && withSound.catch) {
        withSound.catch(function () {
          v.muted = true;
          var silent = v.play();
          if (silent && silent.catch) silent.catch(give);
        });
      }

      // Some browsers pause a media element when it is moved between bodies.
      var resume = function () { if (!settled && v.paused && !v.ended) v.play().catch(function () {}); };
      document.addEventListener('turbo:render', resume);
      v.addEventListener('ended', function () { document.removeEventListener('turbo:render', resume); });
    });
  }

  function accepted() { return playClip('accepted', 'Challenge accepted'); }
  function completed() { return playClip('completed', 'Challenge complete'); }

  // level/title survive only for the reduced-motion line, which has no clip
  // to show.
  function levelUp(level, title) {
    var line = 'Level up' + (level ? ' \u2014 level ' + level : '') + (title ? ', ' + title : '');
    return playClip('levelUp', line);
  }

  // The final rung, once ever, and a longer piece than the other three — so it
  // gets a ceiling with room to play out rather than the short-clip default.
  function mastered() { return playClip('mastered', 'You did it \u2014 you\u2019re the boss now', 90000); }

  window.nbFX = { accepted: accepted, completed: completed, levelUp: levelUp, mastered: mastered, warmClip: warmClip };
})();
