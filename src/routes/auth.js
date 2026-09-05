const router = require('express').Router();
const crypto = require('crypto');
const { anonClient, userClient, serviceClient } = require('../supabase');
const { setSessionCookies, clearSessionCookies } = require('../middleware/auth');
const mailer = require('../mailer');
const pathsLib = require('../paths');
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

const keepPath = req => pathsLib.isPath((req.body && req.body.path) || (req.query && req.query.path))
  ? ((req.body && req.body.path) || req.query.path) : null;
const pathDefOf = req => { const p = keepPath(req); return p ? pathsLib.get(p) : null; };

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  // A path landing page links here with ?path=creator. Carried through the form
  // so the founder is not asked to choose again on the other side of signup.
  const path = pathsLib.isPath(req.query.path) ? req.query.path : null;
  res.render('signup', { title: 'Sign up', error: null, path, pathDef: path ? pathsLib.get(path) : null });
});

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  const chosenPath = keepPath(req);
  if (!password || password.length < 8) {
    return res.render('signup', { title: 'Sign up', error: 'Password must be at least 8 characters.', path: keepPath(req), pathDef: pathDefOf(req) });
  }
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.render('signup', { title: 'Sign up', error: 'Community username must be 3-24 characters: letters, numbers, underscores.', path: keepPath(req), pathDef: pathDefOf(req) });
  }
  const sb = anonClient();
  const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
  if (taken) return res.render('signup', { title: 'Sign up', error: 'That username is taken \u2014 try another.', path: keepPath(req), pathDef: pathDefOf(req) });
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
  if (error) return res.render('signup', { title: 'Sign up', error: error.message, path: keepPath(req), pathDef: pathDefOf(req) });
  // Fire-and-forget: a mail failure must never block a signup.
  if (data.user) mailer.send('welcome', email, username, { userId: data.user.id }).catch(() => {});
  if (data.session) {
    setSessionCookies(res, data.session);
    // Straight into the product. The questionnaire used to stand between signup
    // and everything else, which is where the old onboarding lost people; it is
    // now the Level 1 quest, prompted on the dashboard instead of enforced here.
    // Straight into their own questions when a landing page sent them; the
    // questionnaire still owns the choice, this only pre-selects it.
    return res.redirect(chosenPath ? '/questionnaire?path=' + chosenPath : '/dashboard');
  }
  res.redirect('/login?m=' + encodeURIComponent('Check your email to confirm your account, then log in.'));
});

// ---------- Password reset ----------
// Supabase mails a recovery link that lands on /reset with the session in the
// URL fragment. Fragments never reach the server, so the page hands them to
// /reset/session, which validates them and sets the normal session cookies.

router.get('/forgot', (req, res) => {
  res.render('forgot', { title: 'Reset your password', error: null, message: null });
});

router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim();
  // The reply is identical whether or not the address has an account — telling
  // a stranger which emails are registered is an account-enumeration leak.
  const sent = 'If an account exists for that address, a reset link is on its way. Check your inbox and spam folder.';
  if (!email) return res.render('forgot', { title: 'Reset your password', error: 'Enter your email address.', message: null });
  try {
    await anonClient().auth.resetPasswordForEmail(email, { redirectTo: callbackBase(req) + '/reset' });
  } catch (e) {
    console.error('reset request', e && e.message);
  }
  res.render('forgot', { title: 'Reset your password', error: null, message: sent });
});

router.get('/reset', (req, res) => {
  res.render('reset', { title: 'Choose a new password' });
});

// Exchanges the recovery tokens from the email link for session cookies. The
// tokens must already be valid — this grants nothing the caller didn't hold.
router.post('/reset/session', async (req, res) => {
  try {
    const access = String((req.body && req.body.access_token) || '');
    const refresh = String((req.body && req.body.refresh_token) || '');
    if (!access || !refresh) {
      // No fragment supplied: only report ok if a session is already established.
      return res.json({ ok: !!req.user });
    }
    const { data, error } = await userClient(access).auth.getUser(access);
    if (error || !data || !data.user) return res.json({ ok: false });
    setSessionCookies(res, { access_token: access, refresh_token: refresh });
    res.json({ ok: true });
  } catch (e) {
    console.error('reset session', e && e.message);
    res.json({ ok: false });
  }
});

router.post('/reset', async (req, res) => {
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const fail = m => res.render('forgot', { title: 'Reset your password', error: m, message: null });
  if (password.length < 8) return fail('Your new password must be at least 8 characters.');
  if (password !== confirm) return fail('Those two passwords did not match. Please try again.');
  if (!req.accessToken) return fail('Your reset link has expired. Request a new one below.');
  try {
    const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const r = await fetch(base + '/auth/v1/user', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + req.accessToken
      },
      body: JSON.stringify({ password })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return fail(j.msg || j.error_description || j.error || 'Could not update your password. Request a fresh reset link and try again.');
  } catch (e) {
    console.error('password update', e && e.message);
    return fail('Could not update your password just now. Please try again.');
  }
  res.redirect('/dashboard');
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

    // Immediately seed the profile using the service role key so it bypasses RLS
    // entirely. This guarantees the user appears in the member directory from their
    // very first login, regardless of RLS policy timing on brand-new OAuth tokens.
    if (j.user) {
      try {
        // Prefer service role (bypasses RLS); fall back to user-scoped client.
        let sc;
        try { sc = serviceClient(); } catch (_) { sc = userClient(j.access_token); }

        const meta = j.user.user_metadata || {};
        const fullName = meta.full_name || meta.name || meta.display_name || '';
        const { data: existing } = await sc.from('profiles')
          .select('id, username, display_name')
          .eq('id', j.user.id)
          .maybeSingle();

        if (!existing || !existing.username || !existing.display_name) {
          const emailBase = ((j.user.email || 'founder').split('@')[0]
            .replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 20)) || 'founder';
          let finalUsername = (existing && existing.username) || null;
          if (!finalUsername) {
            for (let attempt = 0; attempt < 3 && !finalUsername; attempt++) {
              const tryName = attempt === 0
                ? emailBase
                : (emailBase.slice(0, 18) + '_' + j.user.id.slice(0, 3 + attempt));
              const { data: clash } = await sc.from('profiles')
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
            account_status: 'active',
          };
          if (existing) {
            await sc.from('profiles').update(patch).eq('id', j.user.id).is('username', null);
          } else {
            // Insert; if trigger already created the row (race), fall back to update
            const { error: insErr } = await sc.from('profiles').insert({ id: j.user.id, ...patch });
            if (insErr) await sc.from('profiles').update(patch).eq('id', j.user.id).is('username', null);
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
    return rerender('Username must be 3\u201324 characters: letters, numbers, or underscores.');
  }
  const { data: taken } = await sb.from('profiles').select('id').eq('username', username).neq('id', req.user.id).maybeSingle();
  if (taken) return rerender('That username is taken \u2014 try another.');
  const { error } = await sb.from('profiles')
    .update({ username, display_name: displayName || username, needs_username: false })
    .eq('id', req.user.id);
  if (error) return rerender('Could not save that username: ' + error.message);
  res.redirect('/dashboard');
});

module.exports = router;
