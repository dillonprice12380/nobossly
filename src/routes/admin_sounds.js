const router = require('express').Router();
const express = require('express');

// Game soundbites live in site_assets (base64) and are served from our own
// domain by /challenges/sound/:name — no external object storage, no filename
// matching. This page lets an admin upload or replace any of them without a
// deploy. The file goes browser → server → database untouched, so what you
// upload is byte-for-byte what plays.
// Only the fallback clips are left. Challenge accepted, challenge complete,
// level up and mastered NoBossly are all hosted video now and carry their own
// audio, so nothing uploaded here plays over them.
const SLOTS = [
  { name: 'complete', key: 'challenge-complete', label: 'Challenge complete', hint: 'Legacy. Only reaches members still running cached JS from before the video clips.' },
  { name: 'levelup', key: 'level-up', label: 'Level up', hint: 'Fallback only. Plays on a level up where the celebration script failed to load.' }
];

router.get('/', async (req, res, next) => {
  try {
    const { data } = await req.sb.from('site_assets').select('key, mime, updated_at').in('key', SLOTS.map(s => s.key));
    const byKey = {};
    (data || []).forEach(r => byKey[r.key] = r);
    const rows = SLOTS.map(s => {
      const r = byKey[s.key];
      const status = r
        ? '<span style="color:#1a7f37">\u2713 uploaded</span> <small style="color:#666">' + new Date(r.updated_at).toLocaleString() + '</small>'
        : '<span style="color:#b35900">\u2014 not uploaded yet</span>';
      return '<div style="border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0">'
        + '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">'
        + '<strong>' + s.label + '</strong><span>' + status + '</span></div>'
        + '<p style="margin:6px 0 10px;color:#555;font-size:.92em">' + s.hint + '</p>'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<input type="file" accept="audio/mpeg,.mp3" id="file-' + s.name + '">'
        + '<button data-upload="' + s.name + '" style="padding:6px 14px;cursor:pointer">Upload</button>'
        + (r ? '<button data-play="' + s.name + '" style="padding:6px 14px;cursor:pointer">\u25b6 Test play</button>' : '')
        + '<span id="msg-' + s.name + '" style="font-size:.9em"></span>'
        + '</div></div>';
    }).join('');
    res.send('<!doctype html><html><head><title>Sounds \u2014 Admin</title>'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px}</style>'
      + '</head><body>'
      + '<p><a href="/admin">\u2190 Admin</a></p>'
      + '<h1>\ud83d\udd0a Game sounds</h1>'
      + '<p style="color:#555">MP3 files up to 10&nbsp;MB. Uploading replaces the current sound immediately \u2014 no deploy needed. Changes reach members within about a minute.</p>'
      + rows
      + '<script>\n'
      + 'document.addEventListener("click", async function (e) {\n'
      + '  var up = e.target.getAttribute("data-upload");\n'
      + '  var pl = e.target.getAttribute("data-play");\n'
      + '  if (pl) { try { new Audio("/challenges/sound/" + pl + "?t=" + Date.now()).play(); } catch (_) {} return; }\n'
      + '  if (!up) return;\n'
      + '  var input = document.getElementById("file-" + up);\n'
      + '  var msg = document.getElementById("msg-" + up);\n'
      + '  if (!input.files || !input.files[0]) { msg.textContent = "Choose a file first."; return; }\n'
      + '  var f = input.files[0];\n'
      + '  if (f.size > 10 * 1024 * 1024) { msg.textContent = "File is over 10 MB."; return; }\n'
      + '  msg.textContent = "Uploading\u2026";\n'
      + '  try {\n'
      + '    var r = await fetch("/admin/sounds/upload?name=" + up, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f });\n'
      + '    var j = await r.json();\n'
      + '    if (j.ok) { msg.textContent = "\u2713 Saved (" + Math.round(j.bytes / 1024) + " KB)"; setTimeout(function () { location.reload(); }, 900); }\n'
      + '    else { msg.textContent = "Failed: " + (j.error || "unknown error"); }\n'
      + '  } catch (err) { msg.textContent = "Failed: " + err.message; }\n'
      + '});\n'
      + '</script></body></html>');
  } catch (e) { next(e); }
});

router.post('/upload', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  try {
    const slot = SLOTS.find(s => s.name === String(req.query.name || ''));
    if (!slot) return res.status(400).json({ ok: false, error: 'Unknown sound slot' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100) return res.status(400).json({ ok: false, error: 'No file received' });
    // Loose MP3 sanity check: ID3 tag or an MPEG frame sync in the first bytes.
    const looksMp3 = (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    if (!looksMp3) return res.status(400).json({ ok: false, error: 'That does not look like an MP3 file' });
    const { error } = await req.sb.from('site_assets').upsert({
      key: slot.key, mime: 'audio/mpeg', data_b64: buf.toString('base64'), updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, key: slot.key, bytes: buf.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
