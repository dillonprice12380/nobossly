const router = require('express').Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const SAFE_EXT = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|md|docx?|xlsx?|pptx?|zip)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const orig = (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
    if (!SAFE_EXT.test(orig)) return res.status(400).json({ error: 'File type not allowed' });
    const path = req.user.id + '/' + Date.now() + '-' + orig;
    const { error } = await req.sb.storage.from('uploads').upload(path, req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream', upsert: false
    });
    if (error) return res.status(500).json({ error: error.message });
    const { data } = req.sb.storage.from('uploads').getPublicUrl(path);
    res.json({ url: data.publicUrl, name: req.file.originalname, isImage: IMG_EXT.test(orig) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
