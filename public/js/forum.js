// Lightweight WYSIWYG for forum posts/replies
(function () {
  document.querySelectorAll('[data-rich]').forEach(function (wrap) {
    var form = wrap.closest('form');
    var hidden = form.querySelector('input[name="body_html"]');
    var fallback = form.querySelector('textarea[name="body"]');
    if (fallback) { fallback.style.display = 'none'; fallback.required = false; }

    var bar = document.createElement('div');
    bar.className = 'rt-toolbar';
    var ed = document.createElement('div');
    ed.className = 'rt-editor';
    ed.contentEditable = 'true';
    ed.setAttribute('data-placeholder', wrap.getAttribute('data-placeholder') || 'Write something…');
    var tpl = wrap.querySelector('template');
    if (tpl) { ed.innerHTML = tpl.innerHTML; tpl.remove(); }
    wrap.appendChild(bar); wrap.appendChild(ed);

    function btn(label, title, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'rt-btn'; b.innerHTML = label; b.title = title;
      b.addEventListener('click', function (e) { e.preventDefault(); ed.focus(); fn(); });
      bar.appendChild(b);
    }
    function cmd(c, v) { document.execCommand(c, false, v || null); }

    btn('<b>B</b>', 'Bold', function () { cmd('bold'); });
    btn('<i>I</i>', 'Italic', function () { cmd('italic'); });
    btn('<u>U</u>', 'Underline', function () { cmd('underline'); });
    btn('H2', 'Heading', function () { cmd('formatBlock', 'h2'); });
    btn('H3', 'Subheading', function () { cmd('formatBlock', 'h3'); });
    btn('&bull; List', 'Bullet list', function () { cmd('insertUnorderedList'); });
    btn('1. List', 'Numbered list', function () { cmd('insertOrderedList'); });
    btn('&ldquo;&rdquo;', 'Quote', function () { cmd('formatBlock', 'blockquote'); });
    btn('🔗', 'Link (selected text becomes a link; a URL on its own line becomes a preview card)', function () {
      var url = prompt('Link URL (https://…)');
      if (!url) return;
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) cmd('createLink', url);
      else cmd('insertHTML', '<p>' + url.replace(/</g, '&lt;') + '</p>');
    });
    btn('🖼️', 'Insert image', function () {
      var input = document.createElement('input');
      input.type = 'file'; input.accept = '.png,.jpg,.jpeg,.gif,.webp';
      input.onchange = async function () {
        if (!input.files[0]) return;
        var fd = new FormData(); fd.append('file', input.files[0]);
        var note = document.createElement('span'); note.className = 'muted small'; note.textContent = ' uploading…';
        bar.appendChild(note);
        try {
          var r = await fetch('/upload', { method: 'POST', body: fd });
          var j = await r.json();
          if (j.url && j.isImage) { ed.focus(); cmd('insertHTML', '<p><img src="' + j.url + '" alt=""></p>'); }
          else alert(j.error || 'Upload failed');
        } catch (e) { alert('Upload failed'); }
        note.remove();
      };
      input.click();
    });

    form.addEventListener('submit', function () {
      hidden.value = ed.innerHTML;
      if (fallback) fallback.value = ed.textContent.trim().slice(0, 4000);
    });
  });
})();
