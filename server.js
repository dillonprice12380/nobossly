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
const billing = require('./src/routes/billing');
app.post('/billing/webhook', express.raw({ type: '*/*' }), billing.webhook);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, cacheControl: true, maxAge: '5m' }));
app.use(require('./src/middleware/ogPrerender')); // crawler OG tags for /blog/:slug + /guides/:slug — must precede route handlers
app.use(attachUser);
app.use(require('./src/settings').attachSettings);

app.use('/', require('./src/routes/auth'));
app.use('/questionnaire', requireAuth, require('./src/routes/questionnaire'));
app.use('/ideas', requireAuth, require('./src/routes/ideas'));
app.use('/blueprint', requireAuth, requirePaid, require('./src/routes/blueprint'));
app.use('/dashboard', requireAuth, require('./src/routes/dashboard'));
app.use('/tasks', requireAuth, require('./src/routes/tasks'));
app.use('/challenges', requireAuth, requirePaid, require('./src/routes/challenges'));
app.use('/community', require('./src/routes/community'));
app.use('/milestones', requireAuth, requirePaid, require('./src/routes/milestones'));
app.use('/collaborations', requireAuth, requirePaid, require('./src/routes/collaborations'));
app.use('/messages', requireAuth, require('./src/routes/messages'));
app.use('/notifications', requireAuth, require('./src/routes/notifications'));
app.use('/members', requireAuth, require('./src/routes/members'));
app.use('/account', requireAuth, require('./src/routes/account'));
app.use('/budget', requireAuth, requirePaid, require('./src/routes/budget'));
app.use('/', billing.router); // /pricing + /billing/*
app.use('/', require('./src/routes/social')); // reports, blocks, follows, friends, groups
app.use('/upload', requireAuth, require('./src/routes/uploads'));
app.get('/profile', requireAuth, (req, res) => res.redirect('/members/' + req.profile.username));
app.use('/admin', requireAdmin, require('./src/routes/admin'));
app.use('/', require('./src/routes/publiccms'));

app.get('/', (req, res) => {
  if (res.locals.user) return res.redirect('/dashboard');
  res.render('home', { title: 'AI-Powered Business Builder', bodyTheme: 'theme-dark', metaDescription: 'NoBossly matches you with AI-generated business ideas, builds your launch blueprint, and keeps you accountable with sprints, challenges, and a founder community.' });
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
