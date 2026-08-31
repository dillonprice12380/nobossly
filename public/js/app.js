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

  // Level-up celebration: badge + CSS confetti. Rare, so it can be theatrical.
  function celebrate(level) {
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

  // --- Quest accepted: popup + "Let's do this!" -------------------------
  // Sound must start inside the click/submit gesture. Turbo swaps the <body>
  // without reloading the document, so an Audio object created here keeps
  // playing across the navigation. The server resolves the actual R2 object
  // keys at /challenges/sound/:n (probing likely names once and caching), so
  // the client never breaks on a renamed upload. Soundbites rotate via a
  // localStorage cursor; a failed clip falls through to the next, then to
  // the Web Speech API as a last resort.
  const QUEST_SOUNDS = ['/challenges/sound/1', '/challenges/sound/2'];
  function saySound() {
    const speak = () => {
      try {
        if (!window.speechSynthesis) return;
        const u = new SpeechSynthesisUtterance("Let's do this!");
        u.rate = 1.05; u.pitch = 1.1;
        window.speechSynthesis.speak(u);
      } catch (_) { /* silence is acceptable */ }
    };
    let start = 0;
    try {
      start = (parseInt(localStorage.getItem('nbQuestSound') || '-1', 10) + 1) % QUEST_SOUNDS.length;
      localStorage.setItem('nbQuestSound', String(start));
    } catch (_) { start = Math.floor(Math.random() * QUEST_SOUNDS.length); }
    const tryPlay = i => {
      if (i >= QUEST_SOUNDS.length) return speak();
      try {
        const a = new Audio(QUEST_SOUNDS[(start + i) % QUEST_SOUNDS.length]);
        a.volume = 0.9;
        a.addEventListener('error', () => tryPlay(i + 1));
        a.play().catch(() => tryPlay(i + 1));
      } catch (_) { speak(); }
    };
    tryPlay(0);
  }

  function questPopup() {
    const overlay = document.createElement('div');
    overlay.className = 'nb-overlay';
    const card = document.createElement('div');
    card.className = 'quest-pop';
    const emoji = document.createElement('span');
    emoji.className = 'quest-emoji';
    emoji.textContent = '\u2694\ufe0f';
    const label = document.createElement('strong');
    label.textContent = 'CHALLENGE ACCEPTED';
    const sub = document.createElement('em');
    sub.textContent = "Let's do this!";
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
  window.nbQuestPopup = questPopup;

  // Catch the accept form on its way out: play the sound in the gesture,
  // flag the popup to show on the page that comes back.
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form || !form.getAttribute) return;
    const action = form.getAttribute('action') || '';
    if (!/^\/challenges\/(custom\/)?[^/]+\/accept$/.test(action)) return;
    saySound();
    try { sessionStorage.setItem('nbQuestAccepted', '1'); } catch (_) { /* popup is a bonus */ }
  });

  function maybeQuestPopup() {
    try {
      if (sessionStorage.getItem('nbQuestAccepted') !== '1') return;
      sessionStorage.removeItem('nbQuestAccepted');
      questPopup();
    } catch (_) { /* ignore */ }
  }
  document.addEventListener('turbo:load', maybeQuestPopup);
  if (document.readyState !== 'loading') maybeQuestPopup();
  else document.addEventListener('DOMContentLoaded', maybeQuestPopup);

  // Dashboard task check-off: optimistic done state, XP float, then refresh.
  // On a level-up the celebration plays out before the page swaps.
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
      if (j.xp && j.xp.leveledUp) {
        celebrate(j.xp.level);
        setTimeout(refresh, 1900);
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
    const loading = document.createElement('p');
    loading.className = 'muted small notif-msg';
    loading.textContent = 'Loading\u2026';
    list.appendChild(loading);
    let data;
    try {
      const r = await fetch('/notifications/recent', { headers: { Accept: 'application/json' } });
      data = await r.json();
    } catch (_) {
      loading.textContent = 'Could not load notifications.';
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

  // An open menu should never survive a page transition.
  document.addEventListener('turbo:before-render', () => {
    document.querySelectorAll('.nav-dd-menu.open, .avatar-dropdown.open, .nav-links.open')
      .forEach(el => el.classList.remove('open'));
    document.querySelectorAll('#notif-menu[open]').forEach(d => d.removeAttribute('open'));
  });
})();
