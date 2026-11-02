// A worksheet opened from an emailed share link (/shared/<token>). No account
// needed: shared_doc_by_token() checks the token, that the link was not turned
// off and that it has not expired, and returns only that one document.
const router = require('express').Router();
const { anonClient } = require('../supabase');
const { WORKSHEETS } = require('../workspace/worksheets');

router.get('/:token', async (req, res, next) => {
  try {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');   // keep the token out of other sites' logs
    const gone = () => res.status(404).render('error', {
      title: 'Link not available', message: 'This link has expired or was turned off. Ask the person who shared it to send a new one.'
    });
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{48,64}$/.test(token)) return gone();
    const { data: d, error } = await (req.sb || anonClient()).rpc('shared_doc_by_token', { p_token: token });
    const def = d && WORKSHEETS[d.kind];
    if (error || !def) return gone();
    res.render('workspace/view', {
      title: (d.title || def.label) + ' — shared on NoBossly', def, kind: d.kind,
      doc: { id: d.share_id, title: d.title, updated_at: d.updated_at }, data: d.data || {},
      mode: 'link', ownerName: d.owner, note: d.note || null, canShare: false
    });
  } catch (e) { next(e); }
});

module.exports = router;
