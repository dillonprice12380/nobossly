const router = require('express').Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// SVG is deliberately absent. The uploads bucket is public, so an SVG served
// from it with image/svg+xml executes its own script when opened directly —
// on the storage origin rather than ours, so it cannot reach a session cookie,
// but it is still a page on our storage domain that we did not write.
const SAFE_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|csv|md|docx?|xlsx?|pptx?|zip)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;

// The content type is decided by the extension we just allowed, not by the
// mimetype on the request. Those are the client's words: a .png announced as
// text/html was stored and then served as HTML.
const TYPE_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  md: 'text/markdown', zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const orig = (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
    if (!SAFE_EXT.test(orig)) return res.status(400).json({ error: 'File type not allowed' });
    const path = req.user.id + '/' + Date.now() + '-' + orig;
    const ext = (orig.split('.').pop() || '').toLowerCase();
    const { error } = await req.sb.storage.from('uploads').upload(path, req.file.buffer, {
      contentType: TYPE_BY_EXT[ext] || 'application/octet-stream', upsert: false
    });
    if (error) return res.status(500).json({ error: error.message });
    const { data } = req.sb.storage.from('uploads').getPublicUrl(path);
    res.json({ url: data.publicUrl, name: req.file.originalname, isImage: IMG_EXT.test(orig) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
