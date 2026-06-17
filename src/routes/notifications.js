const router = require('express').Router();

router.get('/', async (req, res, next) => {
  try {
    const { data: notifs } = await req.sb.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(60);
    req.sb.from('notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false).then(() => {});
    res.render('notifications', { title: 'Notifications', notifs: notifs || [] });
  } catch (e) { next(e); }
});

module.exports = router;
