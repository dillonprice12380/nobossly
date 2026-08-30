require('dotenv').config();
process.on('uncaughtException', (e) => { console.error('UNCAUGHT EXCEPTION:', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e && e.stack || e); });
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { attachUser, requireAuth, requireAdmin, requirePaid } = require('./src/middleware/auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Canonical host redirect, kept first so it runs ahead of every other
// middleware and route. www.nobossly.com and nobossly.com were both live and
// separately crawlable — Seobility flags this directly ("This website uses
// both www and non-www URLs. This can result in duplicate content and
// impact your rankings."), the same issue found and fixed on EnRoute Jobs.
// Apex is canonical here too — sitemap.xml's own base URL below already
// uses it. req.hostname reads the raw Host header (no trust-proxy config
// needed for that), so this holds regardless of what's in front of the app.
app.use((req, res, next) => {
  if (req.hostname === 'www.nobossly.com') {
    return res.redirect(301, `https://nobossly.com${req.originalUrl}`);
  }
  next();
});

const billing = require('./src/routes/billing');
app.post('/billing/webhook', express.raw({ type: '*/*' }), billing.webhook);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Views need the current path to highlight the active dashboard section, and
// every page needs a self-referencing canonical. There was none anywhere, so
// for as long as www and apex were both live every page was indexable at two
// hostnames, and the faceted guides listing (?q=, ?cat=, ?loc=) multiplied
// that again into a large duplicate URL space with no consolidating signal.
//
// Canonical is built on the apex host from the clean path. Only `page` is
// carried through, so paginated listings self-canonicalize while filter
// combinations collapse onto the unfiltered listing — Google's documented
// handling for faceted navigation. Deliberately no noindex alongside this:
// a noindex on a URL that canonicalizes to a page we want indexed is a
// conflicting signal and Google may apply it to the canonical target.
const CANONICAL_HOST = 'https://nobossly.com';
const CANONICAL_KEEP = ['page'];
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  const clean = req.path.length > 1 ? (req.path.replace(/\/+$/, '') || '/') : '/';
  const keep = new URLSearchParams();
  for (const k of CANONICAL_KEEP) {
    const v = req.query[k];
    if (typeof v === 'string' && /^[0-9]+$/.test(v) && v !== '1') keep.set(k, v);
  }
  const qs = keep.toString();
  res.locals.canonicalUrl = CANONICAL_HOST + clean + (qs ? '?' + qs : '');
  next();
});

// Turbo Drive submits forms over fetch and expects the redirect that follows to
// be a 303, so the browser re-requests the destination as a GET. Express sends
// 302 by default; upgrade non-GET redirects centrally rather than editing every
// route. Explicit res.redirect(status, url) calls are left alone.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const redirect = res.redirect.bind(res);
  res.redirect = function (...args) {
    if (args.length === 1 && typeof args[0] === 'string') return redirect(303, args[0]);
    return redirect(...args);
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, cacheControl: true, maxAge: '5m' }));
app.use(require('./src/middleware/ogPrerender')); // crawler OG tags for /blog/:slug + /guides/:slug — must precede route handlers
app.use(attachUser);
app.use(require('./src/settings').attachSettings);

// First-time social (Google/LinkedIn/GitHub) sign-ups must choose a username
// before using the rest of the app. Skip the chooser itself, auth, and logout.
app.use((req, res, next) => {
  if (!req.user || !req.profile || !req.profile.needs_username) return next();
  const p = req.path;
  if (p === '/choose-username' || p === '/logout' || p === '/debug' || p.startsWith('/auth/')) return next();
  return res.redirect('/choose-username');
});

app.use('/', require('./src/routes/auth'));
app.use('/questionnaire', requireAuth, require('./src/routes/questionnaire'));
app.use('/compass', requireAuth, require('./src/routes/compass')); // Founder Compass + draft-your-idea advisor
app.use('/ideas', requireAuth, require('./src/routes/ideas'));
app.use('/blueprint', requireAuth, require('./src/routes/blueprint'));
app.use('/jobs', requireAuth, require('./src/routes/jobs')); // background generation job polling
app.use('/dashboard', requireAuth, require('./src/routes/dashboard'));
app.use('/tasks', requireAuth, require('./src/routes/tasks'));
app.use('/challenges', requireAuth, require('./src/routes/challenges'));
app.use('/community', require('./src/routes/community'));
app.use('/wins', require('./src/routes/wins')); // public wins wall + member submissions + admin review
app.use('/milestones', requireAuth, require('./src/routes/milestones'));
app.use('/collaborations', requireAuth, require('./src/routes/collaborations'));
app.use('/messages', requireAuth, require('./src/routes/messages'));
app.use('/notifications', requireAuth, require('./src/routes/notifications'));
app.use('/members', requireAuth, require('./src/routes/members'));
app.use('/account', requireAuth, require('./src/routes/account'));
app.use('/budget', requireAuth, require('./src/routes/budget'));
app.use('/', billing.router); // /pricing + /billing/*
app.use('/', require('./src/routes/social')); // reports, blocks, follows, friends, groups
app.use('/upload', requireAuth, require('./src/routes/uploads'));
app.get('/profile', requireAuth, (req, res) => res.redirect('/members/' + req.profile.username));
app.use('/admin', requireAdmin, require('./src/routes/admin'));
app.use('/', require('./src/routes/publiccms'));

app.get('/', (req, res) => {
  if (res.locals.user) return res.redirect('/dashboard');
  res.render('home', { title: 'The Real-Life Founder Game', bodyTheme: 'theme-dark', metaDescription: 'NoBossly turns starting a business into a game you play in real life: draw your Founder Compass, choose your own idea, and climb ten levels where every level-up is a real achievement — first feedback, first sale, first $1k month.' });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /dashboard\nDisallow: /tasks\nDisallow: /messages\nSitemap: https://nobossly.com/sitemap.xml\n');
});

app.get('/sitemap.xml', async (req, res, next) => {
  try {
    const { anonClient } = require('./src/supabase');
    const sb = anonClient();
    const [{ data: posts }, { data: pages }, { data: threads }, { data: guides }] = await Promise.all([
      sb.from('cms_contents').select('slug, updated_at').eq('type', 'blog').eq('status', 'published').limit(500),
      sb.from('cms_contents').select('slug, updated_at').in('type', ['page', 'custom']).eq('status', 'published').limit(200),
      sb.from('forum_threads').select('id, updated_at').order('created_at', { ascending: false }).limit(1000),
      sb.from('cms_guides').select('slug, updated_at').eq('status', 'published').limit(500)
    ]);
    const base = 'https://nobossly.com';
    const urls = [
      { loc: base + '/', pri: '1.0' },
      { loc: base + '/community', pri: '0.8' },
      { loc: base + '/blog', pri: '0.8' },
      { loc: base + '/pricing', pri: '0.8' },
      { loc: base + '/guides', pri: '0.8' },
      { loc: base + '/locations', pri: '0.8' },
      { loc: base + '/wins', pri: '0.7' },
      { loc: base + '/help', pri: '0.6' },
      ...(pages || []).map(p => ({ loc: base + '/' + p.slug, mod: p.updated_at, pri: '0.5' })),
      ...(posts || []).map(p => ({ loc: base + '/blog/' + p.slug, mod: p.updated_at, pri: '0.7' })),
      ...(guides || []).map(g => ({ loc: base + '/guides/' + g.slug, mod: g.updated_at, pri: '0.7' })),
      ...(threads || []).map(t => ({ loc: base + '/community/t/' + t.id, mod: t.updated_at, pri: '0.6' }))
    ];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + urls.map(u => '<url><loc>' + u.loc + '</loc>' + (u.mod ? '<lastmod>' + new Date(u.mod).toISOString().slice(0, 10) + '</lastmod>' : '') + '<priority>' + u.pri + '</priority></url>').join('\n')
      + '\n</urlset>';
    res.type('application/xml').send(xml);
  } catch (e) { next(e); }
});

app.get('/debug', async (req, res) => {
  const steps = [];
  const log = m => { steps.push(m); console.log('DEBUG:', m); };
  try {
    log('node ' + process.version);
    log('env SUPABASE_URL set: ' + !!process.env.SUPABASE_URL + ', ANON set: ' + !!process.env.SUPABASE_ANON_KEY);
    log('env STRIPE_SECRET_KEY set: ' + !!process.env.STRIPE_SECRET_KEY + ' (prefix ' + String(process.env.STRIPE_SECRET_KEY || '').slice(0, 7) + '), SUB_SYNC_SECRET set: ' + !!process.env.SUB_SYNC_SECRET + ', SITE_URL: ' + (process.env.SITE_URL || '(unset)'));
    const { createClient } = require('@supabase/supabase-js');
    log('supabase-js loaded v' + require('@supabase/supabase-js/package.json').version);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    log('createClient OK');
    try {
      const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/health', { headers: { apikey: process.env.SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(8000) });
      log('raw fetch health: HTTP ' + r.status);
    } catch (e) { log('raw fetch FAILED: ' + (e && e.message) + ' cause: ' + (e && e.cause && e.cause.message)); }
    try {
      const { data, error } = await sb.auth.getUser('not-a-real-token');
      log('auth.getUser returned, error: ' + (error ? error.message : 'none'));
    } catch (e) { log('auth.getUser THREW: ' + (e && e.message)); }
    res.json({ ok: true, steps });
  } catch (e) {
    log('FATAL in debug: ' + (e && e.stack || e));
    res.status(500).json({ ok: false, steps });
  }
});

// Task deadline reminders: sweep every 10 minutes
const { anonClient } = require('./src/supabase');
setInterval(() => {
  anonClient().rpc('process_task_reminders').then(
    r => { if (r.data) console.log('task reminders sent:', r.data); },
    () => {}
  );
}, 10 * 60 * 1000);

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: err.userMessage || 'Something went wrong. Please try again.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`NoBossly running on port ${port}`));
