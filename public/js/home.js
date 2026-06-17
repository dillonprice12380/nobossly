(function () {
  const animate = el => {
    el.querySelectorAll('.stat-circle').forEach(c => {
      const pct = parseInt(c.dataset.pct, 10) || 0;
      const ring = c.querySelector('.ring');
      const label = c.querySelector('.pct');
      ring.style.strokeDashoffset = 339.3 * (1 - pct / 100);
      let n = 0;
      const t = setInterval(() => { n += 2; if (n >= pct) { n = pct; clearInterval(t); } label.textContent = n + '%'; }, 28);
    });
    el.querySelectorAll('.counter').forEach(c => {
      const target = parseInt(c.dataset.target, 10) || 0;
      let n = 0;
      const step = Math.max(1, Math.round(target / 40));
      const t = setInterval(() => { n += step; if (n >= target) { n = target; clearInterval(t); } c.textContent = n + (target > 9 ? '+' : ''); }, 36);
    });
  };
  const band = document.querySelector('.stats-band');
  if (!band) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { animate(band); io.disconnect(); } });
  }, { threshold: 0.3 });
  io.observe(band);
})();

// swipe-in reveals
(function () {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.15 });
  els.forEach(el => io.observe(el));
})();
