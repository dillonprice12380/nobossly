// A small formatted-text editor for worksheet boxes (the canvases).
//
// Each <div data-rt> wraps a <textarea>. With JavaScript, the textarea is
// hidden and replaced by an editable area with a toolbar; every change is
// copied back into the textarea, so the form posts exactly as before. The
// server cleans whatever arrives (src/workspace/richtext.js), so this file
// only has to be helpful, never trusted.
//
// Forms marked data-autosave also save themselves a couple of seconds after
// you stop typing.
(function () {
  var COLORS = [
    ['Default', ''], ['Green', '#0f9f6e'], ['Teal', '#0e7490'], ['Blue', '#2563eb'],
    ['Purple', '#7c3aed'], ['Red', '#dc2626'], ['Orange', '#ea580c'], ['Grey', '#6b7280']
  ];
  var HIGHLIGHTS = [
    ['None', ''], ['Yellow', '#fef08a'], ['Green', '#bbf7d0'], ['Blue', '#bfdbfe'],
    ['Pink', '#fbcfe8'], ['Orange', '#fed7aa']
  ];
  var BUTTONS = [
    { cmd: 'bold', label: '<b>B</b>', title: 'Bold (Ctrl+B)' },
    { cmd: 'italic', label: '<i>I</i>', title: 'Italic (Ctrl+I)' },
    { cmd: 'underline', label: '<u>U</u>', title: 'Underline (Ctrl+U)' },
    { cmd: 'strikeThrough', label: '<s>S</s>', title: 'Strikethrough' },
    { sep: true },
    { cmd: 'insertUnorderedList', label: '&#8226;&#8202;&#8212;', title: 'Bulleted list' },
    { cmd: 'insertOrderedList', label: '1.&#8202;&#8212;', title: 'Numbered list' },
    { cmd: 'outdent', label: '&#8676;', title: 'Decrease indent' },
    { cmd: 'indent', label: '&#8677;', title: 'Increase indent' },
    { sep: true },
    { menu: 'color', label: '<span class="rt-a">A</span>', title: 'Text colour' },
    { menu: 'hilite', label: '<span class="rt-hl">A</span>', title: 'Highlight' },
    { sep: true },
    { cmd: 'removeFormat', label: '&#10005;<small>fmt</small>', title: 'Clear formatting' },
    { cmd: 'undo', label: '&#8630;', title: 'Undo (Ctrl+Z)' },
    { cmd: 'redo', label: '&#8631;', title: 'Redo (Ctrl+Y)' }
  ];

  function exec(cmd, val) {
    try { document.execCommand('styleWithCSS', false, true); } catch (_) {}
    document.execCommand(cmd, false, val == null ? null : val);
  }

  function menu(items, apply) {
    var m = document.createElement('div');
    m.className = 'rt-menu';
    m.hidden = true;
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rt-swatch';
      b.title = it[0];
      b.setAttribute('aria-label', it[0]);
      b.style.background = it[1] || 'transparent';
      if (!it[1]) b.textContent = '∅';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { apply(it[1]); m.hidden = true; });
      m.appendChild(b);
    });
    return m;
  }

  function build(wrap) {
    if (wrap.getAttribute('data-rt-ready')) return;
    var ta = wrap.querySelector('textarea');
    if (!ta) return;
    wrap.setAttribute('data-rt-ready', '1');

    var bar = document.createElement('div');
    bar.className = 'rt-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Formatting');
    var ed = document.createElement('div');
    ed.className = 'rt-edit';
    ed.contentEditable = 'true';
    ed.setAttribute('role', 'textbox');
    ed.setAttribute('aria-multiline', 'true');
    if (ta.getAttribute('aria-label')) ed.setAttribute('aria-label', ta.getAttribute('aria-label'));
    ed.innerHTML = ta.value;
    ta.hidden = true;

    var sync = function () {
      ta.value = ed.innerHTML;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };

    BUTTONS.forEach(function (b) {
      if (b.sep) { var s = document.createElement('span'); s.className = 'rt-sep'; bar.appendChild(s); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rt-btn';
      btn.innerHTML = b.label;
      btn.title = b.title;
      btn.setAttribute('aria-label', b.title);
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the selection
      if (b.menu) {
        var holder = document.createElement('span');
        holder.className = 'rt-holder';
        var m = b.menu === 'color'
          ? menu(COLORS, function (c) { ed.focus(); exec('foreColor', c || '#000000'); if (!c) exec('removeFormat'); sync(); })
          : menu(HIGHLIGHTS, function (c) { ed.focus(); exec('hiliteColor', c || 'transparent'); sync(); });
        btn.addEventListener('click', function () {
          bar.querySelectorAll('.rt-menu').forEach(function (x) { if (x !== m) x.hidden = true; });
          m.hidden = !m.hidden;
        });
        holder.appendChild(btn);
        holder.appendChild(m);
        bar.appendChild(holder);
      } else {
        btn.addEventListener('click', function () { ed.focus(); exec(b.cmd); sync(); refresh(); });
        btn.setAttribute('data-cmd', b.cmd);
        bar.appendChild(btn);
      }
    });

    // Show which styles are on where the cursor is.
    function refresh() {
      bar.querySelectorAll('[data-cmd]').forEach(function (btn) {
        var c = btn.getAttribute('data-cmd');
        if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].indexOf(c) < 0) return;
        var on = false;
        try { on = document.queryCommandState(c); } catch (_) {}
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    ed.addEventListener('input', sync);
    ed.addEventListener('keyup', refresh);
    ed.addEventListener('mouseup', refresh);
    ed.addEventListener('focus', function () { wrap.classList.add('focus'); });
    ed.addEventListener('blur', function () { wrap.classList.remove('focus'); sync(); });
    // Paste as plain text, one paragraph per line: no stray fonts from Word or the web.
    ed.addEventListener('paste', function (e) {
      var t = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (t == null) return;
      e.preventDefault();
      exec('insertText', t);
      sync();
    });
    document.addEventListener('click', function (e) {
      if (!bar.contains(e.target)) bar.querySelectorAll('.rt-menu').forEach(function (x) { x.hidden = true; });
    });

    wrap.insertBefore(bar, ta);
    wrap.insertBefore(ed, ta);
    var form = ta.form;
    if (form) form.addEventListener('submit', sync);
  }

  // Save a canvas a moment after typing stops, and say so.
  function autosave(form) {
    if (form.getAttribute('data-autosave-ready')) return;
    form.setAttribute('data-autosave-ready', '1');
    var status = form.querySelector('[data-save-status]');
    var timer = null;
    var dirty = false;
    var say = function (t) { if (status) status.textContent = t; };
    function save() {
      if (!dirty) return;
      dirty = false;
      say('Saving…');
      fetch(form.action, {
        method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin',
        headers: { 'X-Autosave': '1' }
      }).then(function (r) {
        say(r.ok ? 'Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not saved — press Save');
      }).catch(function () { say('Not saved — check your connection'); });
    }
    form.addEventListener('input', function () {
      dirty = true;
      say('Unsaved changes');
      clearTimeout(timer);
      timer = setTimeout(save, 2500);
    });
    form.addEventListener('submit', function () { dirty = false; clearTimeout(timer); });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  function init() {
    document.querySelectorAll('[data-rt]').forEach(build);
    document.querySelectorAll('form[data-autosave]').forEach(autosave);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  document.addEventListener('turbo:load', init);
  document.addEventListener('turbo:render', init);
})();
