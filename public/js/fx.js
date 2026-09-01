/* ============================================================
   NoBossly celebration FX.

   Two full-screen moments, both drawn on a single canvas so the particle
   counts can scale with the viewport instead of hard-coding a desktop number
   and hoping a phone survives it:

     nbFX.accepted(sub)  — CHALLENGE ACCEPTED. Fire and embers climbing the
                           screen, arcade slam-in card. Meant to embolden.
     nbFX.completed(sub) — CONGRATULATIONS. Fireworks across the whole
                           viewport. The bigger of the two moments.
     nbFX.levelUp(n, t, e) — LEVEL UP. A field of chevrons climbing the screen
                           and a shaft of light, because the whole feeling of
                           this one is upward.

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
  var EMBER = ['#fde68a', '#fbbf24', '#f59e0b', '#f97316', '#ea580c', '#dc2626'];

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

  function stage(cardHTML, variant, ttl, draw) {
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

    setTimeout(end, reduce ? 1400 : ttl);
    return end;
  }

  /* ---------- 1. CHALLENGE ACCEPTED — fire ---------- */

  function accepted(sub) {
    var html =
      '<div class="nb-fx-card nb-fx-card--fire">' +
        '<span class="nb-fx-emoji">🔥</span>' +
        '<strong class="nb-fx-title">CHALLENGE<br>ACCEPTED</strong>' +
        '<em class="nb-fx-sub">' + (sub || "Let's do this.") + '</em>' +
      '</div>' +
      '<span class="nb-fx-ring"></span><span class="nb-fx-ring nb-fx-ring2"></span>';

    var embers = null, last = 0;

    stage(html, 'fire', 2600, function (cv, t, now) {
      var ctx = cv.ctx, w = cv.w, h = cv.h;
      if (!embers) {
        embers = [];
        var n = budget(w, 110);
        for (var i = 0; i < n; i++) {
          embers.push({
            x: Math.random() * w,
            y: h + Math.random() * h * 0.5,
            r: rand(1.4, 4.2),
            vy: rand(0.9, 2.9),
            drift: rand(-0.5, 0.5),
            phase: Math.random() * Math.PI * 2,
            col: pick(EMBER),
            life: rand(0.55, 1)
          });
        }
        last = now;
      }
      var dt = Math.min(48, now - last) / 16.67;
      last = now;

      ctx.clearRect(0, 0, w, h);

      // The heat haze at the foot of the screen, rising and fading with the run.
      var fade = t < 300 ? t / 300 : Math.max(0, 1 - (t - 1500) / 1100);
      var g = ctx.createLinearGradient(0, h, 0, h * 0.32);
      g.addColorStop(0, 'rgba(249,115,22,' + (0.5 * fade) + ')');
      g.addColorStop(0.45, 'rgba(234,88,12,' + (0.16 * fade) + ')');
      g.addColorStop(1, 'rgba(120,20,10,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < embers.length; i++) {
        var e = embers[i];
        e.y -= e.vy * dt * 1.6;
        e.phase += 0.06 * dt;
        e.x += (e.drift + Math.sin(e.phase) * 0.55) * dt;
        if (e.y < -20) { e.y = h + rand(0, 60); e.x = Math.random() * w; }
        var a = e.life * fade * (0.55 + 0.45 * Math.sin(e.phase * 1.7));
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = e.col;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    });
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

  window.nbFX = { accepted: accepted, completed: completed, levelUp: levelUp };
})();
