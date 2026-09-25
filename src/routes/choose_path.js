const router = require('express').Router();
const paths = require('../paths');

// Onboarding, now just this: pick a path, land in the product. Replaces the
// old AI-driven questionnaire + Compass. Also reachable any time to switch
// paths later.
router.get('/', (req, res) => {
  res.render('choose_path', {
    title: 'Choose your path',
    paths: paths.PATHS,
    current: (req.profile && req.profile.path) || null,
    msg: req.query.msg || null
  });
});

router.post('/', async (req, res, next) => {
  try {
    const chosen = String(req.body.path || '').trim();
    if (!paths.isPath(chosen)) {
      return res.redirect('/choose-path?msg=' + encodeURIComponent('Pick the one that fits best — you can change it later.'));
    }
    await req.sb.from('profiles').update({
      path: chosen,
      onboarding_completed: true
    }).eq('id', req.user.id);
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

module.exports = router;
