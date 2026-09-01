// Turbo Drive re-evaluates body scripts on every visit, so anything bound to
// `document` here would stack up a duplicate listener per navigation. Guard the
// whole file, and use event delegation so nav/dropdowns keep working against
// markup that Turbo swapped in after this ran.
(function () {
  if (window.__nbAppInit) return;
  window.__nbAppInit = true;

  // Refresh in place when Turbo is present: same result as location.reload(),
  // without the white flash or losing scroll position.
  const refresh = () => (window.Turbo
    ? window.Turbo.visit(window.location.href, { action: 'replace' })
    : window.location.reload());
  window.nbRefresh = refresh;

  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Game soundbites --------------------------------------------------
  // All clips are served by our own app at /challenges/sound/:name (stored in
  // the database, uploaded via /admin/sounds). Playback is best started inside
  // a user gesture; Turbo swaps the <body> without a document reload, so the
  // Audio object keeps playing across the navigation. Failure is always
  // silent — sound is seasoning, never load-bearing.
  function playSound(name) {
    try {
      const clip = new Audio('/challenges/sound/' + name);
      clip.volume = 0.9;
      clip.play().catch(() => { /* autoplay blocked or offline — stay silent */ });
      return clip;
    } catch (_) { return null; /* audio unsupported — stay silent */ }
  }

  // Long clips shouldn't outlive the animation they belong to. Ramps the volume
  // down and stops, so dismissing a celebration silences it too.
  function fadeOut(clip, ms) {
    if (!clip) return;
    const step = 40, dec = clip.volume / Math.max(1, ms / step);
    const t = setInterval(() => {
      clip.volume = Math.max(0, clip.volume - dec);
      if (clip.volume <= 0.001) { clearInterval(t); try { clip.pause(); } catch (_) {} }
    }, step);
  }

  // --- Game juice -------------------------------------------------------
  // +XP chip that floats up from where the action happened.
  function floatXP(x, y, amount) {
    const chip = document.createElement('span');
    chip.className = 'xp-float';
    chip.textContent = '+' + amount + ' XP';
    chip.style.left = Math.round(x) + 'px';
    chip.style.top = Math.round(y - 8) + 'px';
    document.body.appendChild(chip);
    setTimeout(() => chip.remove(), 1000);
  }

  // Level-up celebration: badge + CSS confetti + the Level Up clip. Rare, so
  // it can be theatrical. Called right after a click's fetch resolves, which
  // is close enough to the gesture that browsers allow the audio.
  // lvlEmoji, not emoji: the fallback body below declares its own `emoji`.
  function celebrate(level, lvlTitle, lvlEmoji, isMax) {
    // The final rung gets its own once-ever moment: the summit, and the track
    // that goes with it. The supplied clip runs about 56 seconds, far longer
    // than any popup should hold the screen, so it fades with the animation.
    // Raise SUMMIT_MS (and the matching durations in motion.css) to let more
    // of it play.
    if (isMax && window.nbFX) {
      const SUMMIT_MS = 11000;
      const clip = playSound('mastered');
      const stop = window.nbFX.mastered();
      // fx.js hands back its own end() — wrap it so dismissing kills the audio.
      const silence = () => fadeOut(clip, 900);
      setTimeout(silence, SUMMIT_MS - 900);
      document.addEventListener('click', silence, { once: true, capture: true });
      document.addEventListener('keydown', silence, { once: true, capture: true });
      return stop;
    }
    playSound('levelup');
    // Full-screen climbing chevrons when fx.js is available; the original
    // badge-and-confetti stays as the fallback so a level-up is never silent.
    if (window.nbFX) return window.nbFX.levelUp(level, lvlTitle, lvlEmoji);
    const overlay = document.createElement('div');
    overlay.className = 'nb-overlay';
    const badge = document.createElement('div');
    badge.className = 'levelup-badge';
    const emoji = document.createElement('span');
    emoji.className = 'lvl-emoji';
    emoji.textContent = '\u2b06\ufe0f';
    const label = document.createElement('strong');
    label.textContent = 'LEVEL UP! Level ' + level;
    badge.appendChild(emoji);
    badge.appendChild(label);
    overlay.appendChild(badge);
    document.body.appendChild(overlay);
    const colors = ['#10b981', '#f59e0b', '#3b82f6', '#ef4444', '#a855f7'];
    const bits = [];
    for (let i = 0; i < 26; i++) {
      const bit = document.createElement('span');
      bit.className = 'nb-confetti';
      bit.style.background = colors[i % colors.length];
      bit.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 420) + 'px');
      bit.style.setProperty('--dy', Math.round(120 + Math.random() * 260) + 'px');
      bit.style.setProperty('--rot', Math.round((Math.random() - 0.5) * 720) + 'deg');
      document.body.appendChild(bit);
      bits.push(bit);
    }
    setTimeout(() => { overlay.remove(); bits.forEach(b => b.remove()); }, 1900);
  }
  window.nbCelebrate = celebrate;

  // Trophy unlocked: reuses the quest popup styling — same energy, different
  // occasion. Shown when a task completion tips a milestone over its target.
  function trophyPopup(t) {
    const overlay = document.createElement('div');
    overlay.className = 'nb-overlay';
    const card = document.createElement('div');
    card.className = 'quest-pop';
    const emoji = document.createElement('span');
    emoji.className = 'quest-emoji';
    emoji.textContent = '\ud83c\udfc6';
    const label = document.createElement('strong');
    label.textContent = 'TROPHY UNLOCKED';
    const sub = document.createElement('em');
    sub.textContent = (t.emoji ? t.emoji + ' ' : '') + (t.title || '');
    card.appendChild(emoji);
    card.appendChild(label);
    card.appendChild(sub);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 1900);
  }
  window.nbTrophyPopup = trophyPopup;

  // --- Quest accepted / completed: popup + soundbite --------------------
  // Both popups share one skeleton; only the flavor differs.
  function questCard(emojiChar, labelText, subText) {
    const overlay = document.createElement('div');
    overlay.className = 'nb-overlay';
    const card = document.createElement('div');
    card.className = 'quest-pop';
    const emoji = document.createElement('span');
    emoji.className = 'quest-emoji';
    emoji.textContent = emojiChar;
    const label = document.createElement('strong');
    label.textContent = labelText;
    const sub = document.createElement('em');
    sub.textContent = subText;
    card.appendChild(emoji);
    card.appendChild(label);
    card.appendChild(sub);
    overlay.appendChild(card);
    const ring = document.createElement('span');
    ring.className = 'quest-ring';
    document.body.appendChild(ring);
    document.body.appendChild(overlay);
    setTimeout(() => { overlay.remove(); ring.remove(); }, 1800);
  }
  // The two challenge moments get the full-screen treatment from fx.js —
  // fire for accepting, fireworks for completing. questCard stays as the
  // fallback for anything that loads before fx.js, and for trophies.
  const questPopup = () => (window.nbFX
    ? window.nbFX.accepted()
    : questCard('\ud83c\udfc1', 'CHALLENGE ACCEPTED', "Let's do this!"));
  const completePopup = () => (window.nbFX
    ? window.nbFX.completed('Challenge complete.')
    : questCard('\ud83c\udfc6', 'CONGRATULATIONS', 'Challenge complete!'));
  window.nbQuestPopup = questPopup;
  window.nbCompletePopup = completePopup;

  // Catch challenge forms on their way out: start the right sound inside the
  // submit gesture and flag the matching popup to show on the page that comes
  // back. Native validation (required proof notes, confirms) has already
  // passed by the time `submit` fires, so the celebration tracks success.
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form || !form.getAttribute) return;
    const action = form.getAttribute('action') || '';
    if (/^\/challenges\/(custom\/)?[^/]+\/accept$/.test(action)) {
      // Play it NOW, inside the click, rather than after the accept round-trip
      // and re-render — that wait was the whole of the delay. fx.js carries the
      // overlay into the incoming body so the navigation doesn't kill it, and
      // being inside a gesture is also what lets the clip play with sound.
      //
      // Without Turbo the form does a real page load and takes the overlay with
      // it, so fall back to flagging it for the page that comes back.
      if (window.Turbo && window.nbFX) {
        window.nbFX.accepted();
      } else {
        try { sessionStorage.setItem('nbQuestAccepted', '1'); } catch (_) { /* popup is a bonus */ }
      }
      return;
    }
    if (/^\/challenges\/(custom\/)?[^/]+\/finish$/.test(action)) {
      playSound('complete');
      try { sessionStorage.setItem('nbQuestComplete', '1'); } catch (_) { /* popup is a bonus */ }
    }
  });

  function maybeQuestPopup() {
    try {
      if (sessionStorage.getItem('nbQuestAccepted') === '1') {
        sessionStorage.removeItem('nbQuestAccepted');
        questPopup();
      } else if (sessionStorage.getItem('nbQuestComplete') === '1') {
        sessionStorage.removeItem('nbQuestComplete');
        completePopup();
      }
    } catch (_) { /* ignore */ }
  }
  document.addEventListener('turbo:load', maybeQuestPopup);
  if (document.readyState !== 'loading') maybeQuestPopup();
  else document.addEventListener('DOMContentLoaded', maybeQuestPopup);

  // Dashboard task check-off: optimistic done state, XP float, then refresh.
  // Level-ups and trophy unlocks each get their moment before the page swaps.
  document.addEventListener('click', async e => {
    const chk = e.target.closest('.task .task-check');
    if (!chk) return;
    const el = chk.closest('.task');
    if (!el || !el.dataset.id) return;
    const rect = chk.getBoundingClientRect();
    try {
      const r = await fetch('/dashboard/task/' + el.dataset.id + '/toggle', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) return;
      if (reduceMotion || !j.done) return refresh();
      el.classList.add('done', 'just-done');
      chk.textContent = '\u2713';
      floatXP(rect.left, rect.top, 10);
      const trophies = j.trophies || [];
      if (j.xp && j.xp.leveledUp) {
        celebrate(j.xp.level, j.xp.title, j.xp.emoji, j.xp.isMax);
        if (trophies.length) {
          setTimeout(() => trophyPopup(trophies[0]), 1950);
          setTimeout(refresh, 3800);
        } else {
          setTimeout(refresh, 1900);
        }
      } else if (trophies.length) {
        trophyPopup(trophies[0]);
        setTimeout(refresh, 2000);
      } else {
        setTimeout(refresh, 750);
      }
    } catch (_) { /* leave the box as-is; a refresh will show the truth */ }
  });

  // Hamburger nav (mobile/tablet)
  document.addEventListener('click', e => {
    const links = document.getElementById('nav-links');
    if (!links) return;
    const toggle = e.target.closest('#nav-toggle');
    if (toggle) {
      const open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open);
      return;
    }
    if (!links.contains(e.target)) links.classList.remove('open');
  });

  // Avatar dropdown
  document.addEventListener('click', e => {
    const dd = document.getElementById('avatar-dropdown');
    if (!dd) return;
    const btn = e.target.closest('#avatar-btn');
    if (btn) {
      const open = dd.classList.toggle('open');
      btn.setAttribute('aria-expanded', open);
      return;
    }
    if (!dd.contains(e.target)) dd.classList.remove('open');
  });

  // Nav dropdowns (Resources, etc.)
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-dd] .nav-dd-btn');
    if (btn) {
      const wrap = btn.closest('[data-dd]');
      const menu = wrap && wrap.querySelector('.nav-dd-menu');
      if (!menu) return;
      document.querySelectorAll('.nav-dd-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
      const open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', open);
      return;
    }
    document.querySelectorAll('[data-dd]').forEach(wrap => {
      if (!wrap.contains(e.target)) {
        const menu = wrap.querySelector('.nav-dd-menu');
        if (menu) menu.classList.remove('open');
      }
    });
  });

  // --- Notification bell dropdown ---------------------------------------
  // Contents load on first open so the panel costs nothing on pages nobody
  // opens it from. `toggle` doesn't bubble, hence the capture-phase listener.
  const timeAgo = iso => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  };

  const setBadge = n => {
    const summary = document.querySelector('#notif-menu > summary');
    if (!summary) return;
    let badge = summary.querySelector('.nav-badge');
    if (n > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        summary.appendChild(badge);
      }
      badge.textContent = n > 9 ? '9+' : String(n);
    } else if (badge) {
      badge.remove();
    }
  };

  async function loadNotifs() {
    const list = document.querySelector('#notif-menu .notif-list');
    if (!list) return;
    list.textContent = '';
    const skel = document.createElement('div');
    skel.setAttribute('aria-hidden', 'true');
    skel.innerHTML = '<div class="nb-skel nb-skel-row"></div><div class="nb-skel nb-skel-row short"></div>'
      + '<div class="nb-skel nb-skel-row"></div><div class="nb-skel nb-skel-row short"></div>';
    const sr = document.createElement('p');
    sr.className = 'muted small notif-msg';
    sr.style.position = 'absolute';
    sr.style.clip = 'rect(0 0 0 0)';
    sr.textContent = 'Loading notifications\u2026';
    list.appendChild(skel);
    list.appendChild(sr);
    let data;
    try {
      const r = await fetch('/notifications/recent', { headers: { Accept: 'application/json' } });
      data = await r.json();
    } catch (_) {
      list.textContent = '';
      const err = document.createElement('p');
      err.className = 'muted small notif-msg';
      err.textContent = 'Could not load notifications.';
      list.appendChild(err);
      return;
    }
    list.textContent = '';
    setBadge(data.unread || 0);
    if (!data.items || !data.items.length) {
      const empty = document.createElement('p');
      empty.className = 'muted small notif-msg';
      empty.textContent = 'Nothing yet. Deadlines, messages and replies show up here.';
      list.appendChild(empty);
      return;
    }
    data.items.forEach(item => {
      const a = document.createElement('a');
      a.className = 'notif-item' + (item.is_read ? '' : ' is-unread');
      a.href = item.href;
      const msg = document.createElement('span');
      msg.className = 'notif-text';
      msg.textContent = item.message;          // textContent: never inject markup
      const when = document.createElement('span');
      when.className = 'notif-when muted small';
      when.textContent = timeAgo(item.created_at);
      a.appendChild(msg);
      a.appendChild(when);
      list.appendChild(a);
    });
  }

  document.addEventListener('toggle', e => {
    const d = e.target;
    if (d && d.id === 'notif-menu' && d.open) loadNotifs();
  }, true);

  document.addEventListener('click', async e => {
    if (!e.target.closest('.notif-readall')) return;
    e.preventDefault();
    try {
      await fetch('/notifications/read-all', { method: 'POST', headers: { Accept: 'application/json' } });
    } catch (_) { /* the panel still reloads below */ }
    setBadge(0);
    loadNotifs();
  });

  // --- Pending submits ------------------------------------------------
  // Turbo announces the start and end of every form submission, so one pair of
  // listeners covers every slow POST on the site rather than each template
  // hand-rolling its own onsubmit. The button keeps its exact box size while
  // spinning, so nothing reflows around it.
  document.addEventListener('turbo:submit-start', e => {
    const btn = (e.detail && e.detail.formSubmission && e.detail.formSubmission.submitter)
      || (e.target && e.target.querySelector('button[type=submit], button:not([type])'));
    if (!btn || btn.classList.contains('nb-pending')) return;
    const r = btn.getBoundingClientRect();
    if (r.width) { btn.style.minWidth = r.width + 'px'; btn.style.minHeight = r.height + 'px'; }
    btn.classList.add('nb-pending');
    btn.setAttribute('aria-busy', 'true');
    btn.__nbPending = true;
  });

  const clearPending = () => {
    document.querySelectorAll('.nb-pending').forEach(btn => {
      btn.classList.remove('nb-pending');
      btn.removeAttribute('aria-busy');
      btn.style.minWidth = '';
      btn.style.minHeight = '';
    });
  };
  document.addEventListener('turbo:submit-end', clearPending);
  // A failed or redirected submit may never fire submit-end on this page.
  document.addEventListener('turbo:load', clearPending);
  window.addEventListener('pageshow', clearPending);

  // An open menu should never survive a page transition.
  document.addEventListener('turbo:before-render', () => {
    document.querySelectorAll('.nav-dd-menu.open, .avatar-dropdown.open, .nav-links.open')
      .forEach(el => el.classList.remove('open'));
    document.querySelectorAll('#notif-menu[open]').forEach(d => d.removeAttribute('open'));
  });

  // --- Entrance motion -------------------------------------------------
  // Scroll reveals used to live in home.js, loaded by the marketing homepage
  // and nothing else — one view out of seventy. This runs everywhere by
  // reading the page structure instead of asking every template to opt in.
  //
  // The hidden state is applied by JS and never by CSS, so a blocked or broken
  // script can't leave a page blank. Anything already on screen animates in a
  // short stagger; anything below the fold waits for the scroll.

  const REVEAL_MAX = 14;      // beyond this a page is a list, not a composition
  const STAGGER_MS = 55;
  const STAGGER_CAP = 5;      // never delay the 6th item further than the 5th

  function revealTargets() {
    const main = document.querySelector('main.container');
    if (!main) return [];
    return Array.from(main.children).filter(el => {
      if (el.classList.contains('reveal')) return false;      // homepage runs its own
      if (el.classList.contains('nb-rv')) return false;        // already processed
      if (el.classList.contains('modal')) return false;
      // A transform on an ancestor re-bases position:fixed, so anything
      // containing a modal is left alone entirely.
      if (el.querySelector('.modal')) return false;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'sticky') return false;
      return el.getBoundingClientRect().height > 0;
    }).slice(0, REVEAL_MAX);
  }

  function initReveals() {
    if (reduceMotion) return;
    const els = revealTargets();
    if (els.length < 2) return;   // a single block reads as a glitch, not motion

    els.forEach(el => el.classList.add('nb-rv'));

    let shown = 0;
    const show = el => {
      const delay = Math.min(shown, STAGGER_CAP) * STAGGER_MS;
      shown++;
      setTimeout(() => {
        el.classList.add('nb-rv-go');
        requestAnimationFrame(() => el.classList.add('in'));
        // Drop the transform entirely once it has played, so nothing is left
        // creating a containing block for descendants.
        setTimeout(() => el.classList.remove('nb-rv', 'nb-rv-go', 'in'), 900);
      }, delay);
    };

    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        show(e.target);
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -40px 0px' });

    els.forEach(el => io.observe(el));

    // A safety net: if the observer never fires for anything (an odd layout,
    // a zero-height parent), clear the hidden state rather than hide content.
    setTimeout(() => {
      els.forEach(el => el.classList.remove('nb-rv', 'nb-rv-go'));
      io.disconnect();
    }, 4000);
  }

  // Count-ups on any [data-count] number. The dashboard stat row uses it, so
  // XP and streak land as something earned rather than something printed.
  function initCounters() {
    document.querySelectorAll('[data-count]').forEach(el => {
      const to = parseInt(el.dataset.count, 10);
      if (!Number.isFinite(to) || el.dataset.counted) return;
      el.dataset.counted = '1';
      if (reduceMotion || to <= 0) { el.textContent = to.toLocaleString(); return; }
      const start = performance.now(), dur = 850;
      const frame = now => {
        const t = Math.min(1, (now - start) / dur);
        el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3))).toLocaleString();
        if (t < 1) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  const onPage = () => {
    initReveals();
    initCounters();
    // Only where an Accept button actually exists — no reason to pull a video
    // down on pages that can never play it.
    if (window.nbFX && document.querySelector('form[action*="/accept"]')) {
      window.nbFX.warmAccepted();
    }
  };
  document.addEventListener('turbo:load', onPage);
  if (document.readyState !== 'loading') onPage();
  else document.addEventListener('DOMContentLoaded', onPage);
})();
