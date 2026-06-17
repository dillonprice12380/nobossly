document.querySelectorAll('.task').forEach(el => {
  el.querySelector('.task-check').addEventListener('click', async () => {
    const id = el.dataset.id;
    const r = await fetch('/dashboard/task/' + id + '/toggle', { method: 'POST' });
    const j = await r.json();
    if (j.ok) location.reload();
  });
});

// hamburger nav (mobile/tablet)
(function () {
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
  });
  document.addEventListener('click', e => {
    if (!links.contains(e.target) && !toggle.contains(e.target)) links.classList.remove('open');
  });
})();

// avatar dropdown
(function () {
  const btn = document.getElementById('avatar-btn');
  const dd = document.getElementById('avatar-dropdown');
  if (!btn || !dd) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = dd.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  });
  document.addEventListener('click', e => { if (!dd.contains(e.target)) dd.classList.remove('open'); });
})();

// nav dropdowns (Resources, etc.)
document.querySelectorAll('[data-dd]').forEach(dd => {
  const btn = dd.querySelector('.nav-dd-btn');
  const menu = dd.querySelector('.nav-dd-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.nav-dd-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  });
  document.addEventListener('click', e => { if (!dd.contains(e.target)) menu.classList.remove('open'); });
});
