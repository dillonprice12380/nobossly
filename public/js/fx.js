/* ============================================================
   NoBossly celebration FX.

   Two full-screen moments, both drawn on a single canvas so the particle
   counts can scale with the viewport instead of hard-coding a desktop number
   and hoping a phone survives it:

     nbFX.accepted()     — CHALLENGE ACCEPTED. Plays a hosted video clip full
                           screen. No canvas, no card: the clip is the whole
                           thing, art and audio both.
     nbFX.completed(sub) — CONGRATULATIONS. Fireworks across the whole
                           viewport. The bigger of the two moments.
     nbFX.levelUp(n, t, e) — LEVEL UP. A field of chevrons climbing the screen
                           and a shaft of light, because the whole feeling of
                           this one is upward.
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

  // Brand first, then the colours that read as celebration.
  var SPARK = ['#10b981', '#34d399', '#fbbf24', '#f59e0b', '#ffffff', '#f472b6', '#38bdf8'];

  var pick = function (a) { return a[(Math.random() * a.length) | 0]; };
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

  /* ---------- 1. CHALLENGE ACCEPTED — hosted clip ----------
     The canvas fire effect and the accept soundbite are both gone; this clip
     carries the moment on its own. Hotlinked from the same R2 bucket the site
     already serves its images from.

     Autoplay with sound is blocked unless the browser counts the moment as a
     user gesture, and this fires after a Turbo navigation, so it may not. We
     ask for sound, and on refusal mute and play anyway — the visual always
     runs even when the audio can't. */

  var ACCEPTED_CLIP =
    'https://pub-95ede4ca0cce4b26aa322170b1a5b9f1.r2.dev/Video%20Clips/Challenge%20Accepted.mp4';

  function accepted() {
    // A full-screen video is motion by definition, so reduced motion gets the
    // confirmation as a plain line instead of the clip.
    if (reduce) {
      stage('<p class="nb-fx-plain">Challenge accepted</p>', 'plain', 1600);
      return;
    }

    // A ceiling only: the overlay closes when the clip ends, or immediately if
    // it cannot load. Nobody should be left staring at a black rectangle.
    var MAX = 20000;

    return stage(
      '<video class="nb-fx-video" playsinline preload="auto"></video>',
      'clip', MAX, null,
      function (overlay, end) {
        var v = overlay.querySelector('video');
        var settled = false;
        var give = function () { if (!settled) { settled = true; end(); } };

        v.addEventListener('ended', give);
        v.addEventListener('error', give);
        // A clip that never becomes playable (offline, blocked, 404) should not
        // hold the screen for the full ceiling.
        var stall = setTimeout(function () { if (v.readyState < 2) give(); }, 6000);
        v.addEventListener('loadeddata', function () { clearTimeout(stall); });

        v.src = ACCEPTED_CLIP;
        var withSound = v.play();
        if (withSound && withSound.catch) {
          withSound.catch(function () {
            v.muted = true;
            var silent = v.play();
            if (silent && silent.catch) silent.catch(give);
          });
        }
      }
    );
  }

  /* ---------- 2. CHALLENGE COMPLETE — fireworks ---------- */

  function completed(sub) {
    var html =
      '<div class="nb-fx-card nb-fx-card--win">' +
        '<strong class="nb-fx-title nb-fx-congrats">CONGRATULATIONS</strong>' +
        '<em class="nb-fx-sub">' + (sub || 'Challenge complete.') + '</em>' +
      '</div>';

    var shells = [], sparks = [], last = 0, spawned = 0, nextAt = 0;
    var TTL = 3400;

    stage(html, 'win', TTL, function (cv, t, now) {
      var ctx = cv.ctx, w = cv.w, h = cv.h;
      if (!last) last = now;
      var dt = Math.min(48, now - last) / 16.67;
      last = now;

      // Shells keep launching for most of the run, then stop so the last
      // bursts have time to fall and fade instead of being cut off.
      var maxShells = w < 560 ? 12 : w < 1000 ? 18 : 26;
      if (t < TTL - 1300 && t > nextAt && spawned < maxShells) {
        spawned++;
        nextAt = t + rand(55, 155);
        shells.push({
          x: rand(w * 0.06, w * 0.94),
          y: h + 10,
          vy: -rand(9.5, 13.5) * (h / 800),
          col: pick(SPARK),
          burstAt: rand(h * 0.08, h * 0.62)
        });
      }

      // Trails rather than a hard clear, so everything leaves a streak.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(6,10,18,0.17)';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      for (var i = shells.length - 1; i >= 0; i--) {
        var s = shells[i];
        s.y += s.vy * dt;
        s.vy += 0.16 * dt;
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = s.col;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2.4, 0, 6.283);
        ctx.fill();

        if (s.y <= s.burstAt || s.vy >= 0) {
          shells.splice(i, 1);
          var n = budget(w, 96);
          // Burst radius scales with the viewport so a desktop shell reads as big
          // as a phone one relative to the screen it is on.
          var spread = rand(5, 9) * Math.min(1.25, Math.max(0.6, w / 1280));
          for (var k = 0; k < n; k++) {
            var ang = (k / n) * 6.283 + rand(-0.08, 0.08);
            var sp = spread * rand(0.35, 1);
            sparks.push({
              x: s.x, y: s.y,
              vx: Math.cos(ang) * sp,
              vy: Math.sin(ang) * sp,
              col: Math.random() < 0.22 ? '#ffffff' : s.col,
              r: rand(1.5, 3.4),
              life: 1,
              decay: rand(0.006, 0.014)
            });
          }
        }
      }

      for (var j = sparks.length - 1; j >= 0; j--) {
        var p = sparks[j];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.085 * dt;   // gravity
        p.vx *= 0.985;         // drag
        p.vy *= 0.985;
        p.life -= p.decay * dt;
        if (p.life <= 0) { sparks.splice(j, 1); continue; }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * p.life, 0, 6.283);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    });
  }


  /* ---------- 3. LEVEL UP — arrows climbing ---------- */

  function levelUp(level, title, emoji) {
    var line = level ? ('LEVEL ' + level + (title ? ' \u00b7 ' + title : '')) : (title || '');
    var html =
      '<div class="nb-fx-card nb-fx-card--level">' +
        '<span class="nb-fx-chevs" aria-hidden="true">' +
          '<b class="nb-fx-chev"></b><b class="nb-fx-chev"></b><b class="nb-fx-chev"></b>' +
        '</span>' +
        '<strong class="nb-fx-title nb-fx-levelup">LEVEL UP</strong>' +
        '<em class="nb-fx-sub">' + (emoji ? emoji + ' ' : '') + line + '</em>' +
      '</div>';

    var arrows = null, last = 0;
    var TTL = 3000;
    var COL = ['#6ee7b7', '#34d399', '#10b981', '#fbbf24', '#ffffff'];

    stage(html, 'level', TTL, function (cv, t, now) {
      var ctx = cv.ctx, w = cv.w, h = cv.h;

      if (!arrows) {
        arrows = [];
        var n = budget(w, 46);
        for (var i = 0; i < n; i++) {
          // Depth: a big slow chevron reads as far away, a small fast one as
          // close. Mixing the two is what stops it looking like wallpaper.
          var far = Math.random() < 0.45;
          arrows.push({
            x: rand(w * 0.02, w * 0.98),
            y: rand(0, h * 1.6),
            size: far ? rand(26, 54) : rand(11, 24),
            speed: far ? rand(1.1, 2.2) : rand(2.6, 5.2),
            lw: far ? rand(3, 5.5) : rand(2, 3.4),
            alpha: far ? rand(0.1, 0.24) : rand(0.4, 0.9),
            col: pick(COL),
            wob: Math.random() * Math.PI * 2
          });
        }
        last = now;
      }
      var dt = Math.min(48, now - last) / 16.67;
      last = now;

      ctx.clearRect(0, 0, w, h);

      // Fade the whole field in, hold, then out with the card.
      var fade = t < 260 ? t / 260 : Math.max(0, 1 - (t - 2100) / 900);

      // A shaft of light up the middle: the direction of travel, stated once.
      var shaft = ctx.createLinearGradient(0, h, 0, 0);
      shaft.addColorStop(0, 'rgba(16,185,129,' + (0.22 * fade) + ')');
      shaft.addColorStop(0.55, 'rgba(52,211,153,' + (0.08 * fade) + ')');
      shaft.addColorStop(1, 'rgba(110,231,183,0)');
      ctx.fillStyle = shaft;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (var j = 0; j < arrows.length; j++) {
        var a = arrows[j];
        a.y -= a.speed * dt * 2.2;
        a.wob += 0.035 * dt;
        var x = a.x + Math.sin(a.wob) * 5;
        if (a.y < -a.size * 2) { a.y = h + rand(20, 200); a.x = rand(w * 0.02, w * 0.98); }

        ctx.globalAlpha = a.alpha * fade;
        ctx.strokeStyle = a.col;
        ctx.lineWidth = a.lw;
        // A chevron: up and over. Pointing where the founder is going.
        ctx.beginPath();
        ctx.moveTo(x - a.size * 0.5, a.y + a.size * 0.42);
        ctx.lineTo(x, a.y - a.size * 0.42);
        ctx.lineTo(x + a.size * 0.5, a.y + a.size * 0.42);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    });
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

  window.nbFX = { accepted: accepted, completed: completed, levelUp: levelUp, mastered: mastered };
})();
