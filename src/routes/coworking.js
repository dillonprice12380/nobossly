// Co-working sessions: /community/coworking (src/coworking.js). Members only.
const router = require('express').Router();
const cw = require('../coworking');
const paths = require('../paths');
const pi = require('../personal_info_filter');
const { quiet } = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);
const enc = encodeURIComponent;
const nameOf = req => (req.profile && (req.profile.display_name || req.profile.username)) || 'A member';
const ID = /^[0-9a-f-]{36}$/i;

router.get('/', async (req, res, next) => {
  try {
    const myPath = req.query.path === 'mine' && req.profile.path ? req.profile.path : null;
    let sessions = [], notReady = false;
    try { sessions = await cw.upcoming(req.sb, { me: req.user.id, path: myPath }); }
    catch (e) { if (!cw.missing(e)) throw e; notReady = true; }
    // Probe once: an empty list and a missing table look the same otherwise.
    if (!sessions.length && !notReady) {
      const { error } = await req.sb.from('coworking_sessions').select('id').limit(1);
      notReady = cw.missing(error);
    }
    const p = paths.get(req.profile.path);
    res.render('community/coworking', {
      title: 'Co-working', sessions, notReady, myPath, mine: sessions.filter(s => s.mine),
      pathOf: req.profile.path && p && req.profile.path !== 'default' ? { slug: req.profile.path, label: p.label } : null,
      form: {}, err: req.query.err || null, msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const c = cw.clean(req.body, req.user.id);
    if (c.error) return res.redirect('/community/coworking?err=' + enc(c.error) + '#host');
    const found = pi.check(c.row.title, c.row.about);
    if (found) return pi.refuse(req, res, '/community/coworking', found, 'coworking');
    const { data: s, error } = await req.sb.from('coworking_sessions').insert(c.row).select('id').maybeSingle();
    if (error || !s) {
      const why = /five upcoming/.test((error && error.message) || '') ? 'You already host five upcoming sessions.' : (cw.missing(error) ? 'Co-working is being switched on. Check back shortly.' : 'That did not save. Try again.');
      return res.redirect('/community/coworking?err=' + enc(why) + '#host');
    }
    await req.sb.from('coworking_links').insert({ session_id: s.id, link: c.link }).then(...quiet('coworking_links'));
    await req.sb.from('coworking_rsvps').insert({ session_id: s.id, user_id: req.user.id }).then(...quiet('coworking_rsvps:host'));
    res.redirect('/community/coworking/' + s.id + '?msg=' + enc('Posted. Share the page with anyone you want to work alongside.'));
  } catch (e) { next(e); }
});

router.get('/:id.ics', async (req, res, next) => {
  try {
    const s = await cw.one(req.sb, req.params.id, req.user.id);
    if (!s || s.cancelled_at) return res.status(404).send('Not found');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="nobossly-coworking.ics"');
    res.send(cw.ics(s, s.attending || s.mine ? s.link : null, req.protocol + '://' + req.get('host')));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const s = await cw.one(req.sb, req.params.id, req.user.id);
    if (!s) return res.status(404).render('error', { title: 'Not found', message: 'That session is gone.' });
    res.render('community/coworking_session', { title: s.title + ' · Co-working', s, msg: req.query.msg || null, err: req.query.err || null });
  } catch (e) { next(e); }
});

router.post('/:id/rsvp', async (req, res, next) => {
  try {
    if (!ID.test(req.params.id)) return res.redirect('/community/coworking');
    const to = '/community/coworking/' + req.params.id;
    const { error } = await req.sb.from('coworking_rsvps').insert({ session_id: req.params.id, user_id: req.user.id });
    if (error && error.code !== '23505') {
      const m = error.message || '';
      return res.redirect(to + '?err=' + enc(/full/.test(m) ? 'That session is full.' : /over|not on/.test(m) ? 'That session is not on any more.' : 'That did not save. Try again.'));
    }
    if (!error) {
      const { data: s } = await req.sb.from('coworking_sessions').select('host_id, title').eq('id', req.params.id).maybeSingle();
      if (s && s.host_id !== req.user.id) {
        await req.sb.rpc('push_notification', { target_user: s.host_id, ntype: 'community', nmessage: nameOf(req) + ' is joining your co-working session "' + String(s.title).slice(0, 60) + '"', nentity_type: 'coworking_sessions', nentity_id: req.params.id }).then(...quiet('push_notification:coworking'));
      }
    }
    res.redirect(to + '?msg=' + enc("You're in. The link is below, and you'll get a reminder about an hour before."));
  } catch (e) { next(e); }
});

router.post('/:id/leave', async (req, res, next) => {
  try {
    if (!ID.test(req.params.id)) return res.redirect('/community/coworking');
    await req.sb.from('coworking_rsvps').delete().eq('session_id', req.params.id).eq('user_id', req.user.id);
    res.redirect('/community/coworking/' + req.params.id + '?msg=' + enc('You are no longer going.'));
  } catch (e) { next(e); }
});

// The host calls it off; everyone going hears about it.
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const s = await cw.one(req.sb, req.params.id, req.user.id);
    if (!s || !s.mine || s.cancelled_at) return res.redirect('/community/coworking');
    const { error } = await req.sb.from('coworking_sessions').update({ cancelled_at: new Date().toISOString() }).eq('id', s.id).eq('host_id', req.user.id);
    if (error) return res.redirect('/community/coworking/' + s.id + '?err=' + enc('That did not save. Try again.'));
    for (const p of s.going.filter(p => p.id !== req.user.id).slice(0, 25)) {
      await req.sb.rpc('push_notification', { target_user: p.id, ntype: 'community', nmessage: nameOf(req) + ' cancelled the co-working session "' + String(s.title).slice(0, 60) + '" (' + s.when + ')', nentity_type: 'coworking_sessions', nentity_id: s.id }).then(...quiet('push_notification:coworking_cancel'));
    }
    res.redirect('/community/coworking?msg=' + enc('Cancelled. Everyone who was going has been told.'));
  } catch (e) { next(e); }
});

module.exports = router;
