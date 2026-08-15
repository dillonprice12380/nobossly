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

  // Dashboard task check-off
  document.addEventListener('click', async e => {
    const chk = e.target.closest('.task .task-check');
    if (!chk) return;
    const el = chk.closest('.task');
    if (!el) return;
    try {
      const r = await fetch('/dashboard/task/' + el.dataset.id + '/toggle', { method: 'POST' });
      const j = await r.json();
      if (j.ok) refresh();
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
    loading.textContent = 'Loading…';
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
