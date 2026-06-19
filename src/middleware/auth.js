const { anonClient, userClient } = require('../supabase');

// Leave COOKIE_DOMAIN unset for HOST-ONLY cookies — they work on ANY host
// (Hostinger temp domains, nobossly.com, localhost) with no configuration.
// Only set it (e.g. ".nobossly.com") if you want one cookie shared across subdomains.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';

function cookieOpts(req) {
  const proto = String((req && (req.headers['x-forwarded-proto'] || req.protocol)) || '').split(',')[0].trim();
  const isHttps = proto === 'https' || (req && req.secure);
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/',
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {})
  };
}

function setSessionCookies(res, session) {
  const opts = cookieOpts(res.req);
  res.cookie('sb_access', session.access_token, opts);
  res.cookie('sb_refresh', session.refresh_token, opts);
}

function clearSessionCookies(res) {
  // Clear every variant the cookie could have been set under (host-only now, but
  // older sessions may carry an apex-domain cookie) so logout always sticks.
  const variants = [{ path: '/' }, { path: '/', domain: '.nobossly.com' }];
  if (COOKIE_DOMAIN && COOKIE_DOMAIN !== '.nobossly.com') variants.push({ path: '/', domain: COOKIE_DOMAIN });
  for (const opts of variants) {
    res.clearCookie('sb_access', opts);
    res.clearCookie('sb_refresh', opts);
  }
}

async function attachUser(req, res, next) {
  res.locals.user = null;
  res.locals.profile = null;
  const access = req.cookies.sb_access;
  const refresh = req.cookies.sb_refresh;
  if (!access && !refresh) return next();
  try {
    let token = access;
    let sb = token ? userClient(token) : null;
    let user = null;
    if (sb) {
      const { data } = await sb.auth.getUser(token);
      user = data && data.user;
    }
    if (!user && refresh) {
      const auth = anonClient();
      const { data, error } = await auth.auth.refreshSession({ refresh_token: refresh });
      if (!error && data.session) {
        setSessionCookies(res, data.session);
        token = data.session.access_token;
        sb = userClient(token);
        user = data.session.user;
      }
    }
    if (user) {
      req.sb = sb;
      req.user = user;
      req.accessToken = token;
      res.locals.user = user;
      const { data: existing } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      let prof = existing;
      // The on_auth_user_created DB trigger inserts a bare profile (id only), so the
      // username is backfilled here the first time we see the user — this covers
      // BOTH a missing profile and a trigger-created one with a null username.
      // Email/password signups carry a chosen username in metadata; social (OAuth)
      // signups don't, so we derive a placeholder and flag the account to pick one
      // (enforced by the /choose-username redirect in server.js).
      if (!prof || !prof.username) {
        const meta = user.user_metadata || {};
        const chosen = String(meta.username || '').replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 24);
        const hasChosen = chosen.length >= 3;
        const baseName = hasChosen ? chosen
          : ((user.email || 'founder').split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 20) || 'founder');
        const fullName = meta.full_name || meta.name || meta.display_name || '';
        let finalName = null;
        for (let attempt = 0; attempt < 3 && !finalName; attempt++) {
          const tryName = attempt === 0 ? baseName : (baseName.slice(0, 18) + '_' + user.id.slice(0, 3 + attempt));
          const { data: clash } = await sb.from('profiles').select('id').eq('username', tryName).neq('id', user.id).maybeSingle();
          if (!clash) finalName = tryName;
        }
        if (!finalName) finalName = (baseName.slice(0, 12) + '_' + user.id.slice(0, 8));
        const patch = {
          username: finalName,
          display_name: (prof && prof.display_name) || fullName || finalName,
          needs_username: !hasChosen
        };
        if (prof) {
          const { data: upd } = await sb.from('profiles').update(patch).eq('id', user.id).select().maybeSingle();
          prof = upd || Object.assign(prof, patch);
        } else {
          const { data: ins } = await sb.from('profiles').insert(Object.assign({ id: user.id }, patch)).select().maybeSingle();
          prof = ins || Object.assign({ id: user.id }, patch);
        }
      }
      req.profile = prof;
      // auto-reactivate a deactivated account on login
      if (prof && prof.account_status === 'deactivated') {
        await sb.from('profiles').update({ account_status: 'active' }).eq('id', user.id);
        req.profile.account_status = 'active';
        res.locals.reactivated = true;
      }
      res.locals.profile = req.profile;
      res.locals.plan = planOf(req.profile);
      res.locals.pendingDeletion = req.profile && req.profile.delete_requested_at ? req.profile.delete_requested_at : null;
      try {
        const [{ count }, { data: msgCount }] = await Promise.all([
          sb.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('is_read', false),
          sb.rpc('unread_message_count', { uid: user.id })
        ]);
        res.locals.unreadCount = count || 0;
        res.locals.unreadMsgs = typeof msgCount === 'number' ? msgCount : 0;
      } catch (_) { res.locals.unreadCount = 0; res.locals.unreadMsgs = 0; }
    } else {
      clearSessionCookies(res);
    }
  } catch (e) {
    console.error('attachUser error', e.message);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!req.profile || !req.profile.is_admin) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.' });
  }
  next();
}

// 'paid' if admin, lifetime, or an active/cancel-at-period-end subscription still in its period
function planOf(profile) {
  if (!profile) return 'free';
  if (profile.is_admin || profile.is_lifetime) return 'paid';
  const status = profile.subscription_status;
  const end = profile.subscription_period_end ? new Date(profile.subscription_period_end) : null;
  if ((status === 'active' || status === 'canceled' || status === 'trialing') && end && end > new Date()) return 'paid';
  if (status === 'active' && !end) return 'paid';
  return 'free';
}

function requirePaid(req, res, next) {
  if (planOf(req.profile) === 'paid') return next();
  res.redirect('/pricing?upgrade=1');
}

module.exports = { attachUser, requireAuth, requireAdmin, requirePaid, planOf, setSessionCookies, clearSessionCookies, COOKIE_DOMAIN };
