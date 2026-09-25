const { anonClient, userClient, serviceClient } = require('../supabase');

const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';

// One source of truth for cookie scope, used by every cookie this app sets.
// COOKIE_DOMAIN wins when set; otherwise cookies are host-only. Host-only is
// right on nobossly.com — the OAuth round trip comes back to req.get('host'),
// so a cookie set before the redirect is readable after it — and it is the only
// thing that works on localhost or a staging host, where a browser rejects a
// hardcoded .nobossly.com domain outright.
const cookieDomainOpts = () => (COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {});

// Secure is decided from the request, not NODE_ENV: behind a proxy that
// terminates TLS, req.secure is false while x-forwarded-proto says https.
function cookieOpts(req, overrides) {
  const proto = String((req && (req.headers['x-forwarded-proto'] || req.protocol)) || '').split(',')[0].trim();
  const isHttps = proto === 'https' || !!(req && req.secure);
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/',
    ...cookieDomainOpts(),
    ...(overrides || {})
  };
}

function setSessionCookies(res, session) {
  const opts = cookieOpts(res.req);
  res.cookie('sb_access', session.access_token, opts);
  res.cookie('sb_refresh', session.refresh_token, opts);
}

function clearSessionCookies(res) {
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
      // username is backfilled here the first time we see the user. Email/password
      // signups carry a chosen username in metadata; OAuth signups don't, so we derive
      // a placeholder and flag the account to pick one (/choose-username).
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
          needs_username: !hasChosen,
          account_status: 'active'  // ensure profile is visible in member directory
        };
        // Try user-scoped client first; fall back to service role if it returns nothing
        // (can happen with brand-new OAuth tokens before RLS settles).
        let sc = sb;
        if (prof) {
          let { data: upd } = await sb.from('profiles').update(patch).eq('id', user.id).select().maybeSingle();
          if (!upd) {
            try { sc = serviceClient(); ({ data: upd } = await sc.from('profiles').update(patch).eq('id', user.id).select().maybeSingle()); } catch (_) {}
          }
          prof = upd || Object.assign(prof, patch);
        } else {
          let { data: ins } = await sb.from('profiles').insert(Object.assign({ id: user.id }, patch)).select().maybeSingle();
          if (!ins) {
            try { sc = serviceClient(); ({ data: ins } = await sc.from('profiles').upsert(Object.assign({ id: user.id }, patch)).select().maybeSingle()); } catch (_) {}
          }
          prof = ins || Object.assign({ id: user.id }, patch);
        }
      }
      req.profile = prof;
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

      // No AI left in the product, so there is nothing left to meter.
      res.locals.credits = null;
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

// Pricing is gone — NoBossly is free for everyone. planOf() is kept as a
// function, always returning 'paid', rather than ripping out every
// isPaid()/planOf(...)==='paid' check spread across the route files: those
// checks now just always succeed, which is exactly the point.
function planOf() {
  return 'paid';
}

// Nothing is paywalled any more. Kept as a name so any route still mounted
// behind it (there are none left on purpose) doesn't need to change.
function requirePaid(req, res, next) { next(); }

module.exports = { attachUser, requireAuth, requireAdmin, requirePaid, planOf, setSessionCookies, clearSessionCookies, cookieOpts, cookieDomainOpts, COOKIE_DOMAIN };
