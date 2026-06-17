(function () {
  const TYPES = {
    p: { label: 'Paragraph' }, h1: { label: 'Heading 1' }, h2: { label: 'Heading 2' }, h3: { label: 'Heading 3' },
    ul: { label: 'Bullet list' }, ol: { label: 'Numbered list' }, img: { label: 'Image' },
    html: { label: 'HTML' }, advanced: { label: 'Advanced HTML/CSS/JS' }
  };
  let blocks = Array.isArray(window.__INITIAL_BLOCKS) && window.__INITIAL_BLOCKS.length ? window.__INITIAL_BLOCKS : null;
  if (!blocks) {
    // migrate legacy body: keep it intact in a single HTML block so nothing is lost
    blocks = window.__LEGACY_BODY && window.__LEGACY_BODY.trim()
      ? [{ type: 'html', html: window.__LEGACY_BODY }]
      : [{ type: 'p', text: '' }];
  }

  const wrap = document.getElementById('blocks');

  function field(ph, val, key, idx, tag, rows, cls) {
    const el = document.createElement(tag || 'textarea');
    if (tag !== 'input') el.rows = rows || 3;
    el.placeholder = ph;
    el.value = val || '';
    if (cls) el.className = cls;
    el.addEventListener('input', () => { blocks[idx][key] = el.value; refreshSeo(); });
    return el;
  }

  function wrapSelection(el, idx, before, after, placeholder) {
    const start = el.selectionStart || 0, end = el.selectionEnd || 0;
    const sel = el.value.slice(start, end) || placeholder;
    el.value = el.value.slice(0, start) + before + sel + after + el.value.slice(end);
    blocks[idx].text = el.value;
    el.focus();
    refreshSeo();
  }

  function toolbar(f, idx) {
    const bar = document.createElement('div');
    bar.className = 'block-toolbar';
    [
      ['B', () => wrapSelection(f, idx, '**', '**', 'bold text')],
      ['I', () => wrapSelection(f, idx, '*', '*', 'italic text')],
      ['🔗 Link', () => {
        const url = prompt('Link URL (https://…)');
        if (!url) return;
        wrapSelection(f, idx, '[', '](' + url + ')', 'link text');
      }]
    ].forEach(([t, fn]) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = t;
      btn.addEventListener('click', fn);
      bar.appendChild(btn);
    });
    return bar;
  }

  function render() {
    wrap.innerHTML = '';
    blocks.forEach((b, i) => {
      const div = document.createElement('div');
      div.className = 'block block-' + b.type;
      const head = document.createElement('div');
      head.className = 'block-head';
      head.innerHTML = '<span class="btype">' + (TYPES[b.type] || { label: b.type }).label + '</span>';
      const ctl = document.createElement('div');
      ctl.className = 'bctl';
      [['↑', () => move(i, -1)], ['↓', () => move(i, 1)], ['✕', () => del(i)]].forEach(([t, fn]) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = t; btn.addEventListener('click', fn); ctl.appendChild(btn);
      });
      head.appendChild(ctl);
      div.appendChild(head);

      if (['h1', 'h2', 'h3'].includes(b.type)) {
        const f = field('Heading text…', b.text, 'text', i, 'input');
        div.appendChild(toolbar(f, i));
        div.appendChild(f);
      } else if (b.type === 'p') {
        const f = field('Write something…', b.text, 'text', i, 'textarea', 3);
        div.appendChild(toolbar(f, i));
        div.appendChild(f);
      } else if (b.type === 'ul' || b.type === 'ol') {
        const f = field('One item per line…', b.text, 'text', i, 'textarea', 4);
        div.appendChild(toolbar(f, i));
        div.appendChild(f);
      } else if (b.type === 'img') {
        div.appendChild(field('Image URL (https://…)', b.src, 'src', i, 'input'));
        div.appendChild(field('Alt text (important for SEO)', b.alt, 'alt', i, 'input'));
        div.appendChild(field('Caption (optional)', b.caption, 'caption', i, 'input'));
        if (b.src) { const img = document.createElement('img'); img.src = b.src; img.style.maxWidth = '240px'; img.style.borderRadius = '8px'; img.style.marginTop = '.4rem'; div.appendChild(img); }
      } else if (b.type === 'html') {
        div.appendChild(field('<div>Raw HTML…</div>', b.html, 'html', i, 'textarea', 6, 'code'));
      } else if (b.type === 'advanced') {
        const l1 = document.createElement('p'); l1.className = 'muted small'; l1.textContent = 'HTML'; div.appendChild(l1);
        div.appendChild(field('<div class="my-widget">…</div>', b.html, 'html', i, 'textarea', 5, 'code'));
        const l2 = document.createElement('p'); l2.className = 'muted small'; l2.textContent = 'CSS'; div.appendChild(l2);
        div.appendChild(field('.my-widget { color: red; }', b.css, 'css', i, 'textarea', 4, 'code'));
        const l3 = document.createElement('p'); l3.className = 'muted small'; l3.textContent = 'JavaScript'; div.appendChild(l3);
        div.appendChild(field("document.querySelector('.my-widget')…", b.js, 'js', i, 'textarea', 4, 'code'));
      }
      wrap.appendChild(div);
    });
    refreshSeo();
  }

  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    render();
  }
  function del(i) { blocks.splice(i, 1); if (!blocks.length) blocks.push({ type: 'p', text: '' }); render(); }

  document.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', () => {
    const t = btn.dataset.add;
    blocks.push(t === 'img' ? { type: 'img', src: '', alt: '', caption: '' }
      : t === 'html' ? { type: 'html', html: '' }
      : t === 'advanced' ? { type: 'advanced', html: '', css: '', js: '' }
      : { type: t, text: '' });
    render();
    wrap.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));

  // ----- SEO scoring -----
  const $ = id => document.getElementById(id);
  function textContent() { return blocks.filter(b => ['p', 'h1', 'h2', 'h3', 'ul', 'ol'].includes(b.type)).map(b => b.text || '').join(' '); }
  function refreshSeo() {
    const title = ($('f-seotitle').value || $('f-title').value || '').trim();
    const desc = ($('f-seodesc').value || '').trim();
    const slug = ($('f-slug').value || '').trim();
    var __mf = document.getElementById('mode-field');
    var __raw = document.getElementById('raw-html');
    var __isRaw = __mf && __mf.value === 'raw' && __raw;
    const words = (__isRaw ? __raw.value.replace(/<[^>]+>/g, ' ') : textContent()).split(/\s+/).filter(Boolean).length;
    const hasH1 = __isRaw ? /<h1[\s>]/i.test(__raw.value) : blocks.some(b => b.type === 'h1' && (b.text || '').trim());
    const imgs = blocks.filter(b => b.type === 'img' && b.src);
    const imgsWithAlt = imgs.filter(b => (b.alt || '').trim());
    const feat = ($('f-featimg').value || '').trim();
    const checks = [
      [title.length >= 30 && title.length <= 60, 'Meta title 30–60 chars (' + title.length + ')', 15],
      [desc.length >= 120 && desc.length <= 160, 'Meta description 120–160 chars (' + desc.length + ')', 15],
      [!!slug && slug.length <= 60 && /^[a-z0-9-]*$/.test(slug), 'Clean short slug', 10],
      [hasH1, 'Has an H1 heading', 15],
      [words >= 300, 'At least 300 words (' + words + ')', 15],
      [imgs.length === 0 || imgsWithAlt.length === imgs.length, 'All images have alt text', 15],
      [!!feat, 'Featured image set', 10],
      [($('f-excerpt').value || '').trim().length > 0, 'Excerpt written', 5]
    ];
    let score = 0;
    const ul = $('seo-checks');
    ul.innerHTML = '';
    checks.forEach(([ok, label, pts]) => {
      if (ok) score += pts;
      const li = document.createElement('li');
      li.className = ok ? 'ok-check' : 'bad-check';
      li.textContent = (ok ? '✓ ' : '○ ') + label;
      ul.appendChild(li);
    });
    $('seo-score').textContent = score;
    $('seo-score').style.color = score >= 80 ? 'var(--accent)' : score >= 50 ? '#eab308' : 'var(--danger)';
    $('seotitle-count').textContent = title.length + '/60';
    $('seodesc-count').textContent = desc.length + '/160';
  }
  ['f-title', 'f-seotitle', 'f-seodesc', 'f-slug', 'f-featimg', 'f-excerpt'].forEach(id => $(id).addEventListener('input', refreshSeo));

  // ----- editor mode toggle (Visual blocks vs Raw HTML) -----
  function curMode() { var mf = document.getElementById('mode-field'); return mf ? mf.value : 'blocks'; }
  document.querySelectorAll('.mode-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var m = btn.dataset.mode;
      var mf = document.getElementById('mode-field'); if (mf) mf.value = m;
      var mb = document.getElementById('mode-blocks'); var mr = document.getElementById('mode-raw');
      if (mb) mb.style.display = m === 'blocks' ? '' : 'none';
      if (mr) mr.style.display = m === 'raw' ? '' : 'none';
      document.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === m); });
      refreshSeo();
    });
  });
  var __rawEl = document.getElementById('raw-html');
  if (__rawEl) __rawEl.addEventListener('input', refreshSeo);

  document.getElementById('editor-form').addEventListener('submit', () => {
    document.getElementById('blocks-field').value = curMode() === 'raw' ? '' : JSON.stringify(blocks);
  });

  render();
})();
