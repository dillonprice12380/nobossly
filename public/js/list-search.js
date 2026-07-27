// Live search, filters, and AJAX pagination for /blog and /guides.
// Progressive enhancement: the wrapping <form method="get"> still works with JS
// off, and the server renders the same markup for a plain ?q=&cat=&loc=&page=.
(function () {
  const form = document.getElementById('list-search-form');
  const input = document.getElementById('list-search');
  const results = document.getElementById('list-results');
  if (!form || !input || !results) return;

  const endpoint = form.dataset.endpoint;
  const listUrl = form.dataset.listUrl;
  const clearBtn = document.getElementById('filter-clear');
  const selects = Array.from(form.querySelectorAll('select[data-facet]'));
  const DEBOUNCE_MS = 200;

  let timer = null;
  let controller = null;

  // Read straight off the form so any field added later is picked up for free.
  function params(page) {
    const p = new URLSearchParams();
    new FormData(form).forEach((v, k) => {
      const val = String(v).trim();
      if (val) p.set(k, val);
    });
    if (page > 1) p.set('page', page);
    return p;
  }

  // Refresh option counts from the payload the fragment carries, so the
  // dropdowns stay honest as the other filters narrow things down.
  function applyFacets() {
    const el = results.querySelector('#facet-data');
    if (!el) return;
    let data;
    try { data = JSON.parse(el.textContent); } catch (e) { return; }
    selects.forEach(sel => {
      const list = (sel.dataset.facet === 'category' ? data.categories : data.locations) || [];
      const byslug = new Map(list.map(o => [o.slug, o]));
      Array.from(sel.options).forEach(opt => {
        if (!opt.value) return;
        const match = byslug.get(opt.value);
        if (match) {
          opt.textContent = match.name + ' (' + match.n + ')';
          opt.disabled = false;
        } else {
          opt.disabled = opt.value !== sel.value; // never disable the active choice
        }
      });
    });
  }

  function toggleClear() {
    if (!clearBtn) return;
    const any = input.value.trim() !== '' || selects.some(s => s.value !== '');
    clearBtn.hidden = !any;
  }

  async function load(page) {
    // Abort any request still in flight. Without this a slow early keystroke can
    // land after a fast later one and overwrite newer results with stale ones.
    if (controller) controller.abort();
    controller = new AbortController();
    results.classList.add('is-loading');

    try {
      const qs = params(page).toString();
      const res = await fetch(endpoint + '?' + qs, {
        signal: controller.signal,
        headers: { 'X-Requested-With': 'fetch' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      results.innerHTML = await res.text();
      applyFacets();
      toggleClear();
      history.replaceState(null, '', listUrl + (qs ? '?' + qs : ''));
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded by a newer request
      results.innerHTML = '<div class="card center"><p class="muted">Search is unavailable right now. Please try again.</p></div>';
    } finally {
      results.classList.remove('is-loading');
    }
  }

  // Fires on typing, paste, and the native clear (x) on type="search".
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(1), DEBOUNCE_MS);
  });

  // Filters apply immediately - no debounce needed for a discrete choice.
  selects.forEach(sel => sel.addEventListener('change', () => {
    clearTimeout(timer);
    load(1);
  }));

  if (clearBtn) {
    clearBtn.addEventListener('click', e => {
      e.preventDefault();
      input.value = '';
      selects.forEach(s => { s.value = ''; });
      clearTimeout(timer);
      load(1);
    });
  }

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

  applyFacets();
  toggleClear();
})();
