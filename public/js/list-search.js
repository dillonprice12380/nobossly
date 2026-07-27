// Live search + AJAX pagination for /blog and /guides.
// Progressive enhancement: the wrapping <form method="get"> still works with JS off,
// and the server renders the same markup for a plain ?q=&page= request.
(function () {
  const form = document.getElementById('list-search-form');
  const input = document.getElementById('list-search');
  const results = document.getElementById('list-results');
  if (!form || !input || !results) return;

  const endpoint = form.dataset.endpoint;
  const listUrl = form.dataset.listUrl;
  const DEBOUNCE_MS = 200;

  let timer = null;
  let controller = null;

  async function load(page, updateUrl) {
    // Abort any request still in flight. Without this a slow early keystroke can
    // land after a fast later one and overwrite newer results with stale ones.
    if (controller) controller.abort();
    controller = new AbortController();

    const q = input.value.trim();
    results.classList.add('is-loading');

    try {
      const url = endpoint + '?q=' + encodeURIComponent(q) + '&page=' + page;
      const res = await fetch(url, { signal: controller.signal, headers: { 'X-Requested-With': 'fetch' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      results.innerHTML = await res.text();

      if (updateUrl !== false) {
        const parts = [];
        if (q) parts.push('q=' + encodeURIComponent(q));
        if (page > 1) parts.push('page=' + page);
        history.replaceState(null, '', listUrl + (parts.length ? '?' + parts.join('&') : ''));
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded by a newer keystroke
      results.innerHTML = '<div class="card center"><p class="muted">Search is unavailable right now. Please try again.</p></div>';
    } finally {
      results.classList.remove('is-loading');
    }
  }

  // Fires on typing, paste, and the native clear (×) on type="search".
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(1), DEBOUNCE_MS);
  });

  // Enter should refresh results, never reload the page.
  form.addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(timer);
    load(1);
  });

  // Pager links are replaced on every render, so listen on the stable container.
  results.addEventListener('click', e => {
    const link = e.target.closest('a[data-page]');
    if (!link) return;
    e.preventDefault();
    load(Number(link.dataset.page));
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
})();
