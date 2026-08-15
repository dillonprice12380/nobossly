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

  // An open menu should never survive a page transition.
  document.addEventListener('turbo:before-render', () => {
    document.querySelectorAll('.nav-dd-menu.open, .avatar-dropdown.open, .nav-links.open')
      .forEach(el => el.classList.remove('open'));
  });
})();
