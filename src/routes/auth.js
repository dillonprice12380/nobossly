const router = require('express').Router();
const crypto = require('crypto');
const { anonClient } = require('../supabase');
const { setSessionCookies, clearSessionCookies } = require('../middleware/auth');
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '.nobossly.com';
const cookieDomainOpts = COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {};
function callbackBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Log in', error: null, message: req.query.m || null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const sb = anonClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return res.render('login', { title: 'Log in', error: error ? error.message : 'Login failed', message: null });
  }
  setSessionCookies(res, data.session);
  res.redirect('/dashboard');
});

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('signup', { title: 'Sign up', error: null });
});

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!password || password.length < 8) {
    return res.render('signup', { title: 'Sign up', error: 'Password must be at least 8 characters.' });
  }
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.render('signup', { title: 'Sign up', error: 'Community username must be 3-24 characters: letters, numbers, underscores.' });
  }
  const sb = anonClient();
  const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
  if (taken) return res.render('signup', { title: 'Sign up', error: 'That username is taken — try another.' });
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
  if (error) return res.render('signup', { title: 'Sign up', error: error.message });
  if (data.session) {
    setSessionCookies(res, data.session);
    return res.redirect('/questionnaire');
  }
  res.redirect('/login?m=' + encodeURIComponent('Check your email to confirm your account, then log in.'));
});

router.post('/logout', (req, res) => {
  clearSessionCookies(res);
  res.redirect('/');
});


// ---------- OAuth (Google / LinkedIn / GitHub) via Supabase PKCE ----------
const OAUTH_PROVIDERS = { google: 'google', linkedin: 'linkedin_oidc', github: 'github' };
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

router.get('/auth/oauth/:provider', (req, res) => {
  const provider = OAUTH_PROVIDERS[req.params.provider];
  if (!provider) return res.redirect('/login');
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  res.cookie('pkce_verifier', verifier, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000, ...cookieDomainOpts });
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const redirectTo = callbackBase(req) + '/auth/callback';
  res.redirect(base + '/auth/v1/authorize?provider=' + provider
    + '&redirect_to=' + encodeURIComponent(redirectTo)
    + '&code_challenge=' + challenge + '&code_challenge_method=s256');
});

router.get('/auth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const verifier = req.cookies.pkce_verifier;
    if (!code || !verifier) return res.redirect('/login?m=' + encodeURIComponent('Sign-in was cancelled or expired. Please try again.'));
    const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const r = await fetch(base + '/auth/v1/token?grant_type=pkce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_ANON_KEY },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier })
    });
    const j = await r.json();
    res.clearCookie('pkce_verifier', cookieDomainOpts);
    if (!r.ok || !j.access_token) {
      return res.redirect('/login?m=' + encodeURIComponent('Social sign-in failed: ' + (j.error_description || j.msg || 'unknown error')));
    }
    setSessionCookies(res, j);
    res.redirect('/dashboard');
  } catch (e) {
    res.redirect('/login?m=' + encodeURIComponent('Social sign-in failed.'));
  }
});

module.exports = router;
