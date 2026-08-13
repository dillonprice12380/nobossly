// Client-side filter for /locations: search by country name + filter by continent.
// Everything is server-rendered up front (good for SEO/crawlers); this script only
// shows or hides existing DOM nodes, and the page still works fine with JS disabled,
// it just shows every continent and country unfiltered.
(function () {
  const searchInput = document.getElementById('loc-search');
  const pills = Array.from(document.querySelectorAll('.loc-pill'));
  const sections = Array.from(document.querySelectorAll('[data-continent-section]'));
  const emptyMsg = document.getElementById('loc-empty');
  if (!searchInput || !sections.length) return;

  let activeContinent = 'all';

  function apply() {
    const q = searchInput.value.trim().toLowerCase();
    let anyVisible = false;

    sections.forEach(section => {
      const continentSlug = section.dataset.continentSection;
      const continentMatches = activeContinent === 'all' || activeContinent === continentSlug;
      const items = Array.from(section.querySelectorAll('[data-country]'));
      let sectionHasVisible = false;

      items.forEach(item => {
        const nameMatches = !q || item.dataset.country.indexOf(q) !== -1;
        const show = continentMatches && nameMatches;
        item.classList.toggle('loc-hidden', !show);
        if (show) sectionHasVisible = true;
      });

      section.classList.toggle('loc-hidden', !sectionHasVisible);
      if (sectionHasVisible) anyVisible = true;
    });

    if (emptyMsg) emptyMsg.hidden = anyVisible;
  }

  searchInput.addEventListener('input', apply);

  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');
      activeContinent = pill.dataset.continent;
      apply();
    });
  });

  apply();
})();
