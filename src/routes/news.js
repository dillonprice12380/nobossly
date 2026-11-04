// /news: headlines that matter to the member's path, gathered every 30 minutes
// (supabase/functions/path-news), and the switch for news notifications.
const router = require('express').Router();
const news = require('../news');
const paths = require('../paths');

const enc = encodeURIComponent;
// The switches live on /news and in account settings; go back to whichever
// one was used (one of two fixed pages, never a URL from the request).
const returnTo = req => (req.body.from === 'account' ? '/account?m=' : '/news?msg=');

router.get('/', async (req, res, next) => {
  try {
    const path = paths.isPath(req.query.path) ? req.query.path : null;   // browse another path's news
    const topic = /^[a-z_]{2,60}$/.test(req.query.topic || '') ? req.query.topic : null;
    const { items, notReady } = await news.forMember(req.sb, req.profile, { path, topic, limit: 80 });
    const topics = [];
    items.forEach(n => { if (!topics.some(t => t.key === n.topic)) topics.push({ key: n.topic, label: n.label }); });
    const mine = req.profile && req.profile.path;
    res.render('news', {
      title: 'News for your path', items, notReady, topics, topic, ago: news.ago,
      chosenPath: path || mine || null, mine, pathDef: (path || mine) ? paths.get(path || mine) : null,
      allPaths: paths.SLUGS.map(s => paths.get(s)), alertsOn: !(req.profile && req.profile.news_alerts === false),
      digestOn: !(req.profile && req.profile.weekly_digest_enabled === false), msg: req.query.msg || null
    });
  } catch (e) { next(e); }
});

// Turn news notifications on or off.
router.post('/alerts', async (req, res, next) => {
  try {
    const on = req.body.on === '1';
    const { error } = await req.sb.from('profiles').update({ news_alerts: on }).eq('id', req.user.id);
    res.redirect(returnTo(req) + enc(error ? 'Could not change that yet — news alerts are being set up.' : on ? 'News notifications are on: at most one a day, when something big happens for your path.' : 'News notifications are off. The news is still here whenever you look.'));
  } catch (e) { next(e); }
});

// Turn the weekly news email on or off.
router.post('/digest', async (req, res, next) => {
  try {
    const on = req.body.on === '1';
    const { error } = await req.sb.from('profiles').update({ weekly_digest_enabled: on }).eq('id', req.user.id);
    res.redirect(returnTo(req) + enc(error ? 'Could not change that. Please try again.' : on ? 'The weekly digest is on: one email on Monday mornings with the week\'s news for your path.' : 'The weekly digest is off.'));
  } catch (e) { next(e); }
});

module.exports = router;
