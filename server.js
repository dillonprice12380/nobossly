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
// middleware and route.
app.use((req, res, next) => {
  if (req.hostname === 'www.nobossly.com') {
    return res.redirect(301, `https://nobossly.com${req.originalUrl}`);
  }
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

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
  if (p === '/forgot' || p === '/reset' || p === '/reset/session') return next();
  return res.redirect('/choose-username');
});

app.use('/', require('./src/routes/auth'));
// Onboarding: pick a path, land straight in the product. Replaces the old
// AI-driven questionnaire + Compass.
app.use('/choose-path', requireAuth, require('./src/routes/choose_path'));
app.use('/jobs', requireAuth, require('./src/routes/jobs')); // background generation job polling
app.use('/dashboard', requireAuth, require('./src/routes/dashboard'));
app.use('/tasks', requireAuth, require('./src/routes/tasks'));
// The quest board and the trophy case. Both answer to their old names too:
// /challenges and /milestones are in the wild — in notifications already sent,
// in anything anyone bookmarked — and they are mounted rather than redirected
// so that a POST to an old URL still works instead of silently becoming a GET.
app.use('/quests', requireAuth, require('./src/routes/challenges'));
app.use('/challenges', requireAuth, require('./src/routes/challenges'));   // former name
app.use('/feed', requireAuth, require('./src/routes/feed')); // what the people you follow have been doing
app.use('/community', require('./src/routes/community'));
app.use('/reviews', requireAuth, require('./src/routes/reviews')); // peer review queue — the on-platform route to "Get 3 Feedback Sessions"
app.use('/wins', require('./src/routes/wins')); // public wins wall + member submissions + admin review
app.use('/trophies', requireAuth, require('./src/routes/milestones'));
app.use('/milestones', requireAuth, require('./src/routes/milestones'));   // former name
app.use('/collaborations', requireAuth, require('./src/routes/collaborations'));
app.use('/messages', requireAuth, require('./src/routes/messages'));
app.use('/notifications', requireAuth, require('./src/routes/notifications'));
app.use('/members', requireAuth, require('./src/routes/members'));
app.use('/account', requireAuth, require('./src/routes/account'));
app.use('/budget', requireAuth, require('./src/routes/budget'));
app.use('/', require('./src/routes/social')); // reports, blocks, follows, friends, groups
app.use('/upload', requireAuth, require('./src/routes/uploads'));
app.get('/profile', requireAuth, (req, res) => res.redirect('/members/' + req.profile.username));
app.use('/admin/sounds', requireAdmin, require('./src/routes/admin_sounds')); // game soundbite uploads — before /admin so its own routes win
app.use('/admin', requireAdmin, require('./src/routes/admin'));

app.use('/paths', require('./src/routes/paths_public')); // public path landing pages — before the CMS catch-all
app.use('/', require('./src/routes/publiccms'));

app.get('/', (req, res) => {
  if (res.locals.user) return res.redirect('/dashboard');
  res.render('home', { title: 'Work Your Way Out of the 9 to 5', bodyTheme: 'theme-dark', paths: require('./src/paths').MARKETED, metaDescription: 'NoBossly is a free community for people working their way out of the 9 to 5: pick one of nine paths, take on real-world challenges, run sprints, and follow other members climbing the same ladder — trading feedback, testimonials and advice as you go.' });
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
      // The path landing pages are the main organic entry points — someone
      // searching "how to start a bookkeeping business" should land on the
      // local service page, not the generic homepage.
      { loc: base + '/paths', pri: '0.9' },
      ...require('./src/paths').MARKETED.map(p => ({ loc: base + '/paths/' + p.slug, pri: '0.9' })),
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

// Admin-only: this reports which secrets are configured.
app.get('/debug', requireAdmin, async (req, res) => {
  const steps = [];
  const log = m => { steps.push(m); console.log('DEBUG:', m); };
  try {
    log('node ' + process.version);
    log('env SUPABASE_URL set: ' + !!process.env.SUPABASE_URL + ', ANON set: ' + !!process.env.SUPABASE_ANON_KEY);
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

// Re-engagement email sweep: finish-your-questionnaire and come-back nudges.
const mailer = require('./src/mailer');
const sweepEmail = () => mailer.runSweep().then(
  r => { if (r && (r.resume || r.comeback)) console.log('re-engagement emails sent:', r); },
  e => console.error('email sweep', e && e.message)
);
setTimeout(sweepEmail, 2 * 60 * 1000);
setInterval(sweepEmail, 12 * 60 * 60 * 1000);

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => {
  const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
  console.error('[' + ref + ']', req.method, req.originalUrl, err);
  try {
    (req.sb || require('./src/supabase').anonClient())
      .rpc('log_app_error', {
        p_ref: ref, p_path: req.originalUrl, p_method: req.method,
        p_message: String((err && err.message) || err).slice(0, 2000),
        p_stack: String((err && err.stack) || '').slice(0, 8000)
      }).then(() => {}, () => {});
  } catch (_) { /* never let the logger throw */ }
  res.status(500).render('error', {
    title: 'Error',
    message: err.userMessage || 'Something went wrong. Please try again.',
    ref
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`NoBossly running on port ${port}`));
