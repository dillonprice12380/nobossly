const router = require('express').Router();
const crypto = require('crypto');
const { anonClient, userClient } = require('../supabase');
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

    // Seed the profile immediately from OAuth token metadata so the user appears
    // correctly in the member directory even before the attachUser middleware has
    // a chance to run its own backfill. Without this, the on_auth_user_created
    // trigger creates a bare profile (id only) and the user can show up in the
    // directory as a "?" card with no name and a broken /members/null link.
    if (j.user) {
      try {
        const sb = userClient(j.access_token);
        const meta = j.user.user_metadata || {};
        const fullName = meta.full_name || meta.name || meta.display_name || '';
        const { data: existing } = await sb.from('profiles')
          .select('id, username, display_name')
          .eq('id', j.user.id)
          .maybeSingle();
        // Only patch when the profile is still bare (missing username or display_name)
        if (!existing || !existing.username || !existing.display_name) {
          const emailBase = ((j.user.email || 'founder').split('@')[0]
            .replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 20)) || 'founder';
          let finalUsername = (existing && existing.username) || null;
          if (!finalUsername) {
            for (let attempt = 0; attempt < 3 && !finalUsername; attempt++) {
              const tryName = attempt === 0
                ? emailBase
                : (emailBase.slice(0, 18) + '_' + j.user.id.slice(0, 3 + attempt));
              const { data: clash } = await sb.from('profiles')
                .select('id').eq('username', tryName)
                .neq('id', j.user.id).maybeSingle();
              if (!clash) finalUsername = tryName;
            }
            if (!finalUsername) finalUsername = emailBase.slice(0, 12) + '_' + j.user.id.slice(0, 8);
          }
          const patch = {
            username: finalUsername,
            display_name: (existing && existing.display_name) || fullName || finalUsername,
            needs_username: true,
          };
          if (existing) {
            await sb.from('profiles').update(patch).eq('id', j.user.id);
          } else {
            await sb.from('profiles').insert({ id: j.user.id, ...patch });
          }
        }
      } catch (seedErr) {
        console.error('OAuth callback profile seed error:', seedErr.message);
      }
    }

    res.redirect('/dashboard');
  } catch (e) {
    res.redirect('/login?m=' + encodeURIComponent('Social sign-in failed.'));
  }
});

// ---------- Choose username (first-time OAuth users) ----------
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

router.get('/choose-username', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.profile && !req.profile.needs_username) return res.redirect('/dashboard');
  const meta = req.user.user_metadata || {};
  const suggestedName = (req.profile && req.profile.display_name) || meta.full_name || meta.name || '';
  const suggestedUser = (req.profile && req.profile.username) || '';
  res.render('choose-username', { title: 'Choose your username', error: null, suggestedUser, suggestedName });
});

router.post('/choose-username', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const sb = req.sb || anonClient();
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.display_name || '').trim().slice(0, 60);
  const rerender = (error) => res.render('choose-username', { title: 'Choose your username', error, suggestedUser: username, suggestedName: displayName });
  if (!USERNAME_RE.test(username)) {
    return rerender('Username must be 3–24 characters: letters, numbers, or underscores.');
  }
  const { data: taken } = await sb.from('profiles').select('id').eq('username', username).neq('id', req.user.id).maybeSingle();
  if (taken) return rerender('That username is taken — try another.');
  const { error } = await sb.from('profiles')
    .update({ username, display_name: displayName || username, needs_username: false })
    .eq('id', req.user.id);
  if (error) return rerender('Could not save that username: ' + error.message);
  res.redirect('/questionnaire');
});

module.exports = router;
