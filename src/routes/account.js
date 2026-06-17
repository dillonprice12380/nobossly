const router = require('express').Router();
const { planOf, clearSessionCookies } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    let tierName = null;
    if (req.profile.subscription_tier) {
      const { data: t } = await req.sb.from('pricing_tiers').select('name').eq('key', req.profile.subscription_tier).maybeSingle();
      tierName = t ? t.name : req.profile.subscription_tier;
    }
    res.render('account', {
      title: 'Account settings',
      p: req.profile, plan: planOf(req.profile), tierName,
      msg: req.query.m || (req.query.sub === 'success' ? 'Subscription activated — welcome aboard! 🎉'
        : req.query.sub === 'canceled' ? 'Your subscription will end at the close of the current billing period.'
        : req.query.sub === 'pending' ? 'Payment is still processing — your plan will activate shortly.' : null),
      err: req.query.e || null
    });
  } catch (e) { next(e); }
});

// Update email (Supabase sends confirmation links)
router.post('/email', async (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect('/account?e=' + encodeURIComponent('Enter a valid email address.'));
  const { error } = await req.sb.auth.updateUser({ email });
  if (error) return res.redirect('/account?e=' + encodeURIComponent(error.message));
  res.redirect('/account?m=' + encodeURIComponent('Check both your old and new inbox to confirm the email change.'));
});

// Change password
router.post('/password', async (req, res) => {
  const { password, password2 } = req.body;
  if (!password || password.length < 8) return res.redirect('/account?e=' + encodeURIComponent('Password must be at least 8 characters.'));
  if (password !== password2) return res.redirect('/account?e=' + encodeURIComponent('Passwords do not match.'));
  const { error } = await req.sb.auth.updateUser({ password });
  if (error) return res.redirect('/account?e=' + encodeURIComponent(error.message));
  res.redirect('/account?m=' + encodeURIComponent('Password updated.'));
});

// Profile visibility
router.post('/visibility', async (req, res, next) => {
  try {
    await req.sb.from('profiles').update({ profile_is_public: req.body.visibility === 'public' }).eq('id', req.user.id);
    res.redirect('/account?m=' + encodeURIComponent('Profile is now ' + (req.body.visibility === 'public' ? 'public' : 'private') + '.'));
  } catch (e) { next(e); }
});

// Deactivate (logging back in reactivates)
router.post('/deactivate', async (req, res, next) => {
  try {
    await req.sb.from('profiles').update({ account_status: 'deactivated' }).eq('id', req.user.id);
    clearSessionCookies(res);
    res.redirect('/login?m=' + encodeURIComponent('Account deactivated. Log in any time to reactivate it.'));
  } catch (e) { next(e); }
});

// Request deletion (7-day grace period)
router.post('/delete', async (req, res, next) => {
  try {
    if (req.body.confirm !== 'DELETE') return res.redirect('/account?e=' + encodeURIComponent('Type DELETE to confirm.'));
    await req.sb.from('profiles').update({ delete_requested_at: new Date().toISOString(), account_status: 'pending_deletion' }).eq('id', req.user.id);
    clearSessionCookies(res);
    res.redirect('/login?m=' + encodeURIComponent('Your account is scheduled for permanent deletion in 7 days. Log in before then and cancel from Account settings if you change your mind.'));
  } catch (e) { next(e); }
});

// Cancel a pending deletion
router.post('/cancel-deletion', async (req, res, next) => {
  try {
    await req.sb.from('profiles').update({ delete_requested_at: null, account_status: 'active' }).eq('id', req.user.id);
    res.redirect('/account?m=' + encodeURIComponent('Deletion canceled — welcome back!'));
  } catch (e) { next(e); }
});

module.exports = router;
