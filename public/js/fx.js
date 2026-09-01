/* ============================================================
   NoBossly celebration FX.

   Two full-screen moments, both drawn on a single canvas so the particle
   counts can scale with the viewport instead of hard-coding a desktop number
   and hoping a phone survives it:

     nbFX.accepted()     — CHALLENGE ACCEPTED. Plays a hosted video clip full
                           screen. No canvas, no card: the clip is the whole
                           thing, art and audio both.
     nbFX.completed()    — CHALLENGE COMPLETE. Hosted clip (Level Complete.mp4).
     nbFX.levelUp(n, t) — LEVEL UP. Hosted clip (Level Complete.mp4), the same
                           file challenge-complete uses.
     nbFX.mastered()     — YOU DID IT / YOU'RE THE BOSS NOW. The summit: cloud
                           banks part, golden light breaks through, ridgelines
                           settle below. Fires once ever, at the final level.

   Rules this file keeps:
   - The overlay is pointer-events:none, so a celebration can never eat a
     click meant for the page underneath.
   - Any click or key cuts it short. Nobody is trapped watching an animation.
   - prefers-reduced-motion gets the card, no canvas, no motion.
   - The canvas is torn down and the rAF loop stopped the moment it ends,
     including when the tab is hidden mid-flight.
   ============================================================ */
(function () {
  if (window.nbFX) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var rand = function (lo, hi) { return lo + Math.random() * (hi - lo); };

  /* ---------- canvas plumbing ---------- */

  function makeCanvas() {
    var c = document.createElement('canvas');
    c.className = 'nb-fx-canvas';
    c.setAttribute('aria-hidden', 'true');
    document.body.appendChild(c);
    var ctx = c.getContext('2d');
    // Cap the device pixel ratio at 2: a 3x phone screen triples the fill cost
    // for a difference nobody can see on a particle.
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = 0, h = 0;
    function size() {
      w = window.innerWidth; h = window.innerHeight;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener('resize', size);
    return { el: c, ctx: ctx, get w() { return w; }, get h() { return h; },
             destroy: function () { window.removeEventListener('resize', size); c.remove(); } };
  }

  // Scales a particle budget to the screen so a phone does less work than a
  // desktop for the same visual density.
  function budget(w, base) {
    var n = Math.round(base * Math.min(1.35, Math.max(0.42, w / 1280)));
    return Math.max(12, n);
  }

  /* ---------- the shared shell ---------- */

  function stage(cardHTML, variant, ttl, draw, onMount) {
    var overlay = document.createElement('div');
    overlay.className = 'nb-fx-overlay nb-fx-' + variant;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = cardHTML;
    document.body.appendChild(overlay);

    var canvas = null, raf = 0, done = false;

    function end() {
      if (done) return;
      done = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('click', end, true);
      document.removeEventListener('keydown', end, true);
      document.removeEventListener('visibilitychange', onHide);
      overlay.classList.add('nb-fx-out');
      setTimeout(function () { overlay.remove(); if (canvas) canvas.destroy(); }, 260);
    }
    function onHide() { if (document.hidden) end(); }

    // Any input cuts it short, and a backgrounded tab stops the loop entirely
    // rather than piling up frames nobody is watching.
    document.addEventListener('click', end, true);
    document.addEventListener('keydown', end, true);
    document.addEventListener('visibilitychange', onHide);

    if (!reduce && draw) {
      canvas = makeCanvas();
      var t0 = performance.now();
      var frame = function (now) {
        if (done) return;
        var t = now - t0;
        draw(canvas, t, now);
        if (t < ttl) raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    // ttl is a ceiling, not a schedule — onMount can finish sooner (a video
    // ending) or bail out (a clip that fails to load).
    setTimeout(end, reduce ? 1400 : ttl);
    if (onMount) onMount(overlay, end);
    return end;
  }

  /* ---------- Hosted clips ----------
     Two celebrations are now video rather than canvas. They share everything
     except the file and the reduced-motion line, so they share the code too.

     Hotlinked from the same R2 bucket the site already serves its images from.
     head.ejs preconnects to it, so DNS and TLS are off the critical path. */

  var CLIPS = {
    accepted: 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/Challenge%20Accepted.mp4',
    completed: 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/Level%20Complete.mp4',
    levelUp: 'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/Level%20Complete.mp4'
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

  function playClip(name, plainText) {
    // A full-screen video is motion by definition, so reduced motion gets the
    // confirmation as a plain line instead of the clip.
    if (reduce) {
      stage('<p class="nb-fx-plain">' + plainText + '</p>', 'plain', 1600);
      return;
    }

    // A ceiling only: the overlay closes when the clip ends, or immediately if
    // it cannot load. Nobody should be left staring at a black rectangle.
    var MAX = 20000;

    return stage('', 'clip', MAX, null, function (overlay, end) {
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

  /* ---------- 4. MASTERED NOBOSSLY — the summit ----------
     Staged rather than looped, because this one tells a short story:
       0.0-1.6s  above the cloud line, everything still closed
       1.0-3.2s  the banks draw apart and light comes through the gap
       2.0s+     god-rays sweep out from the break
       2.4s      YOU DID IT
       3.6s      YOU'RE THE BOSS NOW
       9.5s+     hold, then fade
     Fires once ever, so it is allowed to take its time. */

  function mastered() {
    var html =
      '<div class="nb-fx-card nb-fx-card--summit">' +
        '<strong class="nb-fx-title nb-fx-didit">YOU DID IT!</strong>' +
        '<em class="nb-fx-sub nb-fx-boss">YOU\u2019RE THE BOSS NOW</em>' +
      '</div>';

    var TTL = 11000;
    var clouds = null, motes = null, last = 0;

    // Progress 0..1 across [a,b], eased, clamped. The whole sequence is built
    // from these rather than a timeline library.
    function seg(t, a, b) {
      var p = (t - a) / (b - a);
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      return p * p * (3 - 2 * p);   // smoothstep: eases in and out
    }

    // One soft cloud bank: a row of overlapping blobs, drawn as one shape so
    // the edges read as vapour rather than circles.
    function bank(ctx, x, y, scale, alpha, tint) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tint;
      ctx.beginPath();
      for (var i = 0; i < 11; i++) {
        var bx = x + (i - 5) * 62 * scale;
        var by = y + Math.sin(i * 1.7) * 16 * scale;
        ctx.moveTo(bx, by);
        ctx.arc(bx, by, (46 + (i % 3) * 20) * scale, 0, 6.283);
      }
      ctx.fill();
    }

    stage(html, 'summit', TTL, function (cv, t, now) {
      var ctx = cv.ctx, w = cv.w, h = cv.h;
      if (!last) last = now;
      var dt = Math.min(48, now - last) / 16.67;
      last = now;

      if (!clouds) {
        clouds = [];
        var rows = w < 560 ? 4 : 6;
        for (var i = 0; i < rows; i++) {
          clouds.push({
            y: h * (0.30 + i * 0.115) + rand(-14, 14),
            scale: (w / 1100) * rand(0.75, 1.5) * (w < 560 ? 1.25 : 1),
            off: rand(0, w * 0.05),
            speed: rand(0.55, 1.25),
            alpha: rand(0.5, 0.9),
            drift: rand(-0.22, 0.22)
          });
        }
        motes = [];
        var mn = budget(w, 60);
        for (var k = 0; k < mn; k++) {
          motes.push({ x: Math.random() * w, y: Math.random() * h, r: rand(0.8, 2.6),
                       vy: rand(-0.5, -0.12), vx: rand(-0.18, 0.18), a: rand(0.2, 0.75) });
        }
      }

      var open = seg(t, 900, 4000);      // how far the banks have parted
      var light = seg(t, 1200, 3600);    // how far the sun has come up
      var rays = seg(t, 2000, 4200);
      var out = t > TTL - 1200 ? 1 - seg(t, TTL - 1200, TTL) : 1;

      var sunX = w / 2, sunY = h * 0.34;

      // Sky: night-blue at the top, warming toward the break in the cloud.
      var sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#071324');
      sky.addColorStop(0.42, '#123049');
      sky.addColorStop(0.72, '#2d4a5c');
      sky.addColorStop(1, '#0a1a22');
      ctx.globalAlpha = out;
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      // The sun behind the gap, blooming as the clouds give way.
      var glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, Math.max(w, h) * (0.18 + 0.55 * light));
      glow.addColorStop(0, 'rgba(255,248,214,' + (0.96 * light * out) + ')');
      glow.addColorStop(0.16, 'rgba(253,224,138,' + (0.72 * light * out) + ')');
      glow.addColorStop(0.42, 'rgba(251,191,36,' + (0.28 * light * out) + ')');
      glow.addColorStop(1, 'rgba(251,191,36,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // God-rays fanning from the break, turning very slowly.
      if (rays > 0) {
        ctx.save();
        ctx.translate(sunX, sunY);
        ctx.rotate(t / 14000);
        ctx.globalCompositeOperation = 'lighter';
        var len = Math.max(w, h) * 1.5;
        for (var r = 0; r < 14; r++) {
          var ang = (r / 14) * 6.283;
          var wide = (0.035 + (r % 3) * 0.022);
          ctx.globalAlpha = rays * out * (0.055 + (r % 2) * 0.045);
          ctx.fillStyle = '#ffe9a8';
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, len, ang - wide, ang + wide);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        ctx.globalCompositeOperation = 'source-over';
      }

      // Cloud banks: each row slides outward from the centre as `open` grows.
      for (var c = 0; c < clouds.length; c++) {
        var cl = clouds[c];
        cl.off += cl.drift * dt * 0.35;
        var push = open * w * 0.75 * cl.speed;
        var lit = 0.35 + 0.65 * light;
        var tint = 'rgba(' + Math.round(196 + 44 * lit) + ',' + Math.round(206 + 38 * lit) + ',' + Math.round(224 + 26 * lit) + ',1)';
        bank(ctx, w * 0.5 - push - cl.off, cl.y, cl.scale, cl.alpha * (1 - open * 0.25) * out, tint);
        bank(ctx, w * 0.5 + push + cl.off, cl.y, cl.scale, cl.alpha * (1 - open * 0.25) * out, tint);
      }

      // Dust in the light.
      ctx.globalCompositeOperation = 'lighter';
      for (var m = 0; m < motes.length; m++) {
        var mo = motes[m];
        mo.y += mo.vy * dt; mo.x += mo.vx * dt;
        if (mo.y < -6) { mo.y = h + 6; mo.x = Math.random() * w; }
        ctx.globalAlpha = mo.a * light * out * 0.6;
        ctx.fillStyle = '#fff3cd';
        ctx.beginPath();
        ctx.arc(mo.x, mo.y, mo.r, 0, 6.283);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // Ridgelines. Far range first, then the near summit the founder is stood
      // on, rising into frame as the sequence settles.
      var rise = seg(t, 300, 2600);
      ctx.globalAlpha = out;

      var far = h * 0.72 - 26 * rise;
      ctx.fillStyle = '#20384a';
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, far + 40);
      ctx.lineTo(w * 0.16, far - 26); ctx.lineTo(w * 0.3, far + 16);
      ctx.lineTo(w * 0.46, far - 44); ctx.lineTo(w * 0.62, far + 10);
      ctx.lineTo(w * 0.78, far - 30); ctx.lineTo(w, far + 30);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      var near = h * 0.9 - 34 * rise;
      ctx.fillStyle = '#0d1c26';
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, near + 60);
      ctx.lineTo(w * 0.24, near + 6);
      ctx.lineTo(w * 0.5, near - 56);   // the peak, dead centre
      ctx.lineTo(w * 0.76, near + 6);
      ctx.lineTo(w, near + 60);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      // A rim of sunlight along the near ridge.
      ctx.globalAlpha = out * light * 0.85;
      ctx.strokeStyle = 'rgba(253,224,138,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w * 0.24, near + 6);
      ctx.lineTo(w * 0.5, near - 56);
      ctx.lineTo(w * 0.76, near + 6);
      ctx.stroke();

      // The founder, stood on the peak, arms up. Small on purpose — the scale
      // is the point.
      var figure = seg(t, 2400, 4000);
      if (figure > 0) {
        var fx0 = w * 0.5, fy0 = near - 56;
        var sc = Math.max(1.1, Math.min(2.1, w / 780));
        ctx.globalAlpha = out * figure;
        ctx.strokeStyle = '#06121a';
        ctx.lineWidth = 3.2 * sc;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(fx0, fy0 - 22 * sc, 4.2 * sc, 0, 6.283);      // head
        ctx.moveTo(fx0, fy0 - 17 * sc); ctx.lineTo(fx0, fy0 - 6 * sc);  // body
        ctx.moveTo(fx0, fy0 - 6 * sc); ctx.lineTo(fx0 - 5 * sc, fy0);   // legs
        ctx.moveTo(fx0, fy0 - 6 * sc); ctx.lineTo(fx0 + 5 * sc, fy0);
        ctx.moveTo(fx0, fy0 - 15 * sc); ctx.lineTo(fx0 - 8 * sc, fy0 - 26 * sc); // arms up
        ctx.moveTo(fx0, fy0 - 15 * sc); ctx.lineTo(fx0 + 8 * sc, fy0 - 26 * sc);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    });
  }

  window.nbFX = { accepted: accepted, completed: completed, levelUp: levelUp, mastered: mastered, warmClip: warmClip };
})();
