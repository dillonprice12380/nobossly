const router = require('express').Router();

// ---------- Block editor rendering ----------
const escHtml = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inlineMd = t => escHtml(t)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>')
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
function blocksToHtml(blocks) {
  return (blocks || []).map(b => {
    switch (b.type) {
      case 'h1': return '<h1>' + inlineMd(b.text) + '</h1>';
      case 'h2': return '<h2>' + inlineMd(b.text) + '</h2>';
      case 'h3': return '<h3>' + inlineMd(b.text) + '</h3>';
      case 'p': return '<p>' + inlineMd(b.text).replace(/\n/g, '<br>') + '</p>';
      case 'ul': return '<ul>' + String(b.text || '').split('\n').filter(x => x.trim()).map(li => '<li>' + inlineMd(li.replace(/^[-*]\s*/, '')) + '</li>').join('') + '</ul>';
      case 'ol': return '<ol>' + String(b.text || '').split('\n').filter(x => x.trim()).map(li => '<li>' + inlineMd(li.replace(/^\d+[.)]\s*/, '')) + '</li>').join('') + '</ol>';
      case 'img': return b.src ? '<figure><img src="' + escHtml(b.src) + '" alt="' + escHtml(b.alt) + '" loading="lazy">' + (b.caption ? '<figcaption class="muted small">' + inlineMd(b.caption) + '</figcaption>' : '') + '</figure>' : '';
      case 'html': return b.html || '';
      case 'advanced': return (b.css ? '<style>' + b.css + '</style>' : '') + (b.html || '') + (b.js ? '<script>' + b.js + '</script>' : '');
      default: return '';
    }
  }).join('\n');
}
const RESERVED_SLUGS = ['dashboard','tasks','challenges','milestones','community','collaborations','messages','notifications','members','admin','ideas','blueprint','questionnaire','login','signup','logout','blog','auth','debug','sitemap','robots','p','css','js','api','account','pricing','billing','profile','guides','help','resources','groups','report','follow','unfollow','friends','sidebars'];


const slugify = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || ('item-' + Date.now());

// Dashboard
router.get('/', async (req, res, next) => {
  try {
    const count = t => req.sb.from(t).select('id', { count: 'exact', head: true });
    const [users, threads, contents, ideas] = await Promise.all([count('profiles'), count('forum_threads'), count('cms_contents'), count('generated_ideas')]);
    res.render('admin/home', { title: 'Admin', stats: {
      users: users.count || 0, threads: threads.count || 0, contents: contents.count || 0, ideas: ideas.count || 0
    } });
  } catch (e) { next(e); }
});

// Users
router.get('/users', async (req, res, next) => {
  try {
    const search = (req.query.q || '').trim();
    let qy = req.sb.from('profiles').select('id, username, display_name, xp_total, current_level, subscription_tier, subscription_status, is_lifetime, is_admin, account_status, created_at, onboarding_completed').order('created_at', { ascending: false }).limit(100);
    if (search) qy = qy.or(`username.ilike.%${search}%,display_name.ilike.%${search}%`);
    const { data: users } = await qy;
    res.render('admin/users', { title: 'Users', users: users || [], search });
  } catch (e) { next(e); }
});

router.post('/users/:id', async (req, res, next) => {
  try {
    const patch = {};
    if (req.body.action === 'toggle_admin') {
      const { data: u } = await req.sb.from('profiles').select('is_admin').eq('id', req.params.id).maybeSingle();
      patch.is_admin = !(u && u.is_admin);
    }
    if (req.body.action === 'toggle_status') {
      const { data: u } = await req.sb.from('profiles').select('account_status').eq('id', req.params.id).maybeSingle();
      patch.account_status = (u && u.account_status === 'suspended') ? 'active' : 'suspended';
    }
    if (req.body.action === 'set_tier' && req.body.tier) patch.subscription_tier = req.body.tier;
    if (req.body.action === 'grant_plan') {
      const t = req.body.tier || 'free';
      const now = new Date();
      if (t === 'free') {
        Object.assign(patch, { subscription_tier: null, subscription_status: null, subscription_period_end: null, is_lifetime: false });
      } else if (t === 'lifetime') {
        Object.assign(patch, { subscription_tier: 'lifetime', subscription_status: 'active', subscription_period_end: null, is_lifetime: true });
      } else if (['month', 'quarter', 'year'].includes(t)) {
        const months = t === 'month' ? 1 : t === 'quarter' ? 3 : 12;
        const end = new Date(now); end.setMonth(end.getMonth() + months);
        Object.assign(patch, { subscription_tier: t, subscription_status: 'active', subscription_period_end: end.toISOString(), is_lifetime: false });
      }
    }
    if (Object.keys(patch).length) {
      const { error } = await req.sb.from('profiles').update(patch).eq('id', req.params.id);
      if (error) return res.status(400).render('error', { title: 'Update failed', message: 'Could not update user: ' + error.message });
    }
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

async function loadSidebars(sb) {
  const { data } = await sb.from('sidebars').select('id, name').order('name');
  return data || [];
}

// Content (CMS)
router.get('/content', async (req, res, next) => {
  try {
    const type = req.query.type || '';
    let qy = req.sb.from('cms_contents').select('id, type, custom_type, slug, title, status, published_at, updated_at').order('updated_at', { ascending: false }).limit(200);
    if (type) qy = qy.eq('type', type);
    const { data: items } = await qy;
    res.render('admin/content', { title: 'Content', items: items || [], type });
  } catch (e) { next(e); }
});

router.get('/content/new', async (req, res, next) => {
  try {
    res.render('admin/content_edit', { title: 'New content', item: { type: req.query.type || 'blog', status: 'draft' }, isNew: true, sidebars: await loadSidebars(req.sb) });
  } catch (e) { next(e); }
});

router.get('/content/:id/edit', async (req, res, next) => {
  try {
    const { data: item } = await req.sb.from('cms_contents').select('*').eq('id', req.params.id).maybeSingle();
    if (!item) return res.redirect('/admin/content');
    res.render('admin/content_edit', { title: 'Edit: ' + item.title, item, isNew: false, sidebars: await loadSidebars(req.sb) });
  } catch (e) { next(e); }
});

router.post('/content/save', async (req, res, next) => {
  try {
    const b = req.body;
    const rawMode = b.mode === 'raw';
    let blocks = null;
    if (!rawMode) { try { blocks = b.blocks ? JSON.parse(b.blocks) : null; } catch (_) { blocks = null; } }
    const slug = slugify(b.slug || b.title);
    if (b.type !== 'blog' && RESERVED_SLUGS.includes(slug)) {
      return res.status(400).render('error', { title: 'Reserved slug', message: '"' + slug + '" is reserved by the app. Please pick a different slug.' });
    }
    const row = {
      type: ['blog', 'page', 'custom'].includes(b.type) ? b.type : 'blog',
      custom_type: b.type === 'custom' ? (b.custom_type || 'custom') : null,
      slug,
      title: (b.title || 'Untitled').trim(),
      excerpt: b.excerpt || '',
      body: rawMode ? (b.body || '') : (blocks && blocks.length ? blocksToHtml(blocks) : (b.body || '')),
      blocks: rawMode ? null : blocks,
      featured_image: b.featured_image || null,
      status: b.status === 'published' ? 'published' : 'draft',
      seo_title: b.seo_title || null,
      seo_description: b.seo_description || null,
      sidebar_id: b.sidebar_id || null,
      updated_at: new Date().toISOString()
    };
    if (row.status === 'published' && !b.was_published) row.published_at = new Date().toISOString();
    if (b.id) {
      const { error } = await req.sb.from('cms_contents').update(row).eq('id', b.id);
      if (error) throw error;
      res.redirect('/admin/content/' + b.id + '/edit');
    } else {
      row.author_id = req.user.id;
      const { data, error } = await req.sb.from('cms_contents').insert(row).select('id').maybeSingle();
      if (error) throw error;
      res.redirect('/admin/content/' + data.id + '/edit');
    }
  } catch (e) { next(e); }
});

router.post('/content/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('cms_contents').delete().eq('id', req.params.id);
    res.redirect('/admin/content');
  } catch (e) { next(e); }
});

// Pricing
router.get('/pricing', async (req, res, next) => {
  try {
    const { data: tiers } = await req.sb.from('pricing_tiers').select('*').order('sort');
    res.render('admin/pricing', { title: 'Pricing & Stripe', tiers: tiers || [], stripeConfigured: !!process.env.STRIPE_SECRET_KEY, saved: req.query.saved });
  } catch (e) { next(e); }
});

router.post('/pricing/:key', async (req, res, next) => {
  try {
    const b = req.body;
    const { error } = await req.sb.from('pricing_tiers').update({
      name: (b.name || '').slice(0, 60),
      tagline: (b.tagline || '').slice(0, 120),
      price_cents: Math.max(0, Math.round(parseFloat(b.price || '0') * 100)),
      stripe_price_id: (b.stripe_price_id || '').trim() || null,
      is_active: b.is_active === 'on'
    }).eq('key', req.params.key);
    if (error) throw error;
    res.redirect('/admin/pricing?saved=1');
  } catch (e) { next(e); }
});


// ---------- Guides (separate cms_guides table, same editor) ----------
router.get('/guides', async (req, res, next) => {
  try {
    const { data: items } = await req.sb.from('cms_guides').select('id, slug, title, status, published_at, updated_at').order('updated_at', { ascending: false }).limit(200);
    res.render('admin/guides', { title: 'Guides', items: items || [] });
  } catch (e) { next(e); }
});

router.get('/guides/new', async (req, res) => {
  res.render('admin/content_edit', { title: 'New guide', item: { type: 'guide', status: 'draft' }, isNew: true, formAction: '/admin/guides/save', backLink: '/admin/guides', kind: 'guide', sidebars: await loadSidebars(req.sb) });
});

router.get('/guides/:id/edit', async (req, res, next) => {
  try {
    const { data: item } = await req.sb.from('cms_guides').select('*').eq('id', req.params.id).maybeSingle();
    if (!item) return res.redirect('/admin/guides');
    item.type = 'guide';
    res.render('admin/content_edit', { title: 'Edit: ' + item.title, item, isNew: false, formAction: '/admin/guides/save', backLink: '/admin/guides', kind: 'guide', sidebars: await loadSidebars(req.sb) });
  } catch (e) { next(e); }
});

router.post('/guides/save', async (req, res, next) => {
  try {
    const b = req.body;
    const rawMode = b.mode === 'raw';
    let blocks = null;
    if (!rawMode) { try { blocks = b.blocks ? JSON.parse(b.blocks) : null; } catch (_) { blocks = null; } }
    const row = {
      slug: slugify(b.slug || b.title),
      title: (b.title || 'Untitled').trim(),
      excerpt: b.excerpt || '',
      body: rawMode ? (b.body || '') : (blocks && blocks.length ? blocksToHtml(blocks) : (b.body || '')),
      blocks: rawMode ? null : blocks,
      featured_image: b.featured_image || null,
      status: b.status === 'published' ? 'published' : 'draft',
      seo_title: b.seo_title || null,
      seo_description: b.seo_description || null,
      sidebar_id: b.sidebar_id || null,
      updated_at: new Date().toISOString()
    };
    if (row.status === 'published' && !b.was_published) row.published_at = new Date().toISOString();
    if (b.id) {
      const { error } = await req.sb.from('cms_guides').update(row).eq('id', b.id);
      if (error) throw error;
      res.redirect('/admin/guides/' + b.id + '/edit');
    } else {
      row.author_id = req.user.id;
      const { data, error } = await req.sb.from('cms_guides').insert(row).select('id').maybeSingle();
      if (error) throw error;
      res.redirect('/admin/guides/' + data.id + '/edit');
    }
  } catch (e) { next(e); }
});

router.post('/guides/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('cms_guides').delete().eq('id', req.params.id);
    res.redirect('/admin/guides');
  } catch (e) { next(e); }
});

// Sidebars
router.get('/sidebars', async (req, res, next) => {
  try {
    const { data: items } = await req.sb.from('sidebars').select('*').order('created_at', { ascending: false });
    res.render('admin/sidebars', { title: 'Sidebars', items: items || [] });
  } catch (e) { next(e); }
});

router.get('/sidebars/new', (req, res) => {
  res.render('admin/sidebar_edit', { title: 'New sidebar', item: { show_similar: true }, isNew: true });
});

router.get('/sidebars/:id/edit', async (req, res, next) => {
  try {
    const { data: item } = await req.sb.from('sidebars').select('*').eq('id', req.params.id).maybeSingle();
    if (!item) return res.redirect('/admin/sidebars');
    res.render('admin/sidebar_edit', { title: 'Edit sidebar', item, isNew: false });
  } catch (e) { next(e); }
});

router.post('/sidebars/save', async (req, res, next) => {
  try {
    const b = req.body;
    const row = {
      name: (b.name || 'Sidebar').trim().slice(0, 80),
      show_similar: b.show_similar === 'on',
      html_top: b.html_top || null,
      html_middle: b.html_middle || null,
      html_bottom: b.html_bottom || null,
      updated_at: new Date().toISOString()
    };
    if (b.id) {
      await req.sb.from('sidebars').update(row).eq('id', b.id);
    } else {
      await req.sb.from('sidebars').insert(row);
    }
    res.redirect('/admin/sidebars');
  } catch (e) { next(e); }
});

router.post('/sidebars/:id/delete', async (req, res, next) => {
  try {
    await req.sb.from('sidebars').delete().eq('id', req.params.id);
    res.redirect('/admin/sidebars');
  } catch (e) { next(e); }
});

// Reports moderation
router.get('/reports', async (req, res, next) => {
  try {
    const { data: reports } = await req.sb.from('reports').select('*').order('created_at', { ascending: false }).limit(200);
    const rows = reports || [];
    const reporterIds = [...new Set(rows.map(r => r.reporter_id))];
    const { data: reporters } = reporterIds.length ? await req.sb.from('profiles').select('id, username, display_name').in('id', reporterIds) : { data: [] };
    const pmap = {}; (reporters || []).forEach(p => pmap[p.id] = p);
    // enrich targets with preview + link
    const byType = t => rows.filter(r => r.target_type === t).map(r => r.target_id);
    const [threads, replies, users, msgs] = await Promise.all([
      byType('forum_thread').length ? req.sb.from('forum_threads').select('id, title').in('id', byType('forum_thread')) : { data: [] },
      byType('forum_reply').length ? req.sb.from('forum_replies').select('id, body, thread_id').in('id', byType('forum_reply')) : { data: [] },
      byType('user').length ? req.sb.from('profiles').select('id, username, display_name').in('id', byType('user')) : { data: [] },
      byType('message').length ? req.sb.from('messages').select('id, content, conversation_id').in('id', byType('message')) : { data: [] }
    ]);
    const tmap = {}; (threads.data || []).forEach(t => tmap[t.id] = t);
    const rmap = {}; (replies.data || []).forEach(t => rmap[t.id] = t);
    const umap = {}; (users.data || []).forEach(t => umap[t.id] = t);
    const mmap = {}; (msgs.data || []).forEach(t => mmap[t.id] = t);
    rows.forEach(r => {
      if (r.target_type === 'forum_thread' && tmap[r.target_id]) { r.preview = tmap[r.target_id].title; r.link = '/community/t/' + r.target_id; }
      if (r.target_type === 'forum_reply' && rmap[r.target_id]) { r.preview = (rmap[r.target_id].body || '').slice(0, 200); r.link = '/community/t/' + rmap[r.target_id].thread_id; }
      if (r.target_type === 'user' && umap[r.target_id]) { r.preview = '@' + (umap[r.target_id].username || ''); r.link = '/members/' + (umap[r.target_id].username || ''); }
      if (r.target_type === 'message' && mmap[r.target_id]) { r.preview = (mmap[r.target_id].content || '').slice(0, 200); }
    });
    res.render('admin/reports', { title: 'Reports', reports: rows, pmap });
  } catch (e) { next(e); }
});

router.post('/reports/:id', async (req, res, next) => {
  try {
    const status = ['resolved', 'dismissed'].includes(req.body.status) ? req.body.status : 'open';
    await req.sb.from('reports').update({ status, resolved_at: status === 'open' ? null : new Date().toISOString() }).eq('id', req.params.id);
    res.redirect('/admin/reports');
  } catch (e) { next(e); }
});

// SEO / site settings
router.get('/seo', async (req, res, next) => {
  try {
    const { data: settings } = await req.sb.from('site_settings').select('*').neq('key', 'ai_credits_new_user').order('key');
    res.render('admin/seo', { title: 'SEO & Settings', settings: settings || [] });
  } catch (e) { next(e); }
});

router.post('/seo', async (req, res, next) => {
  try {
    const updates = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (!k.startsWith('setting__')) continue;
      const key = k.slice(9);
      let val;
      if (v === 'true' || v === 'false') val = v === 'true';
      else if (v !== '' && !isNaN(Number(v))) val = Number(v);
      else val = String(v);
      updates.push(req.sb.from('site_settings').update({ value: JSON.stringify(val), updated_at: new Date().toISOString() }).eq('key', key));
    }
    await Promise.all(updates);
    res.redirect('/admin/seo');
  } catch (e) { next(e); }
});

// Forum moderation
router.get('/forum', async (req, res, next) => {
  try {
    const { data: threads } = await req.sb.from('forum_threads').select('id, title, reply_count, view_count, is_pinned, is_locked, created_at, user_id').order('created_at', { ascending: false }).limit(100);
    const userIds = [...new Set((threads || []).map(t => t.user_id))];
    const { data: profiles } = userIds.length ? await req.sb.from('profiles').select('id, display_name, username').in('id', userIds) : { data: [] };
    const pmap = {}; (profiles || []).forEach(p => pmap[p.id] = p);
    res.render('admin/forum', { title: 'Forum moderation', threads: threads || [], pmap });
  } catch (e) { next(e); }
});

router.post('/forum/:id', async (req, res, next) => {
  try {
    if (req.body.action === 'delete') await req.sb.from('forum_threads').delete().eq('id', req.params.id);
    if (req.body.action === 'toggle_pin') {
      const { data: t } = await req.sb.from('forum_threads').select('is_pinned').eq('id', req.params.id).maybeSingle();
      if (t) await req.sb.from('forum_threads').update({ is_pinned: !t.is_pinned }).eq('id', req.params.id);
    }
    if (req.body.action === 'toggle_lock') {
      const { data: t } = await req.sb.from('forum_threads').select('is_locked').eq('id', req.params.id).maybeSingle();
      if (t) await req.sb.from('forum_threads').update({ is_locked: !t.is_locked }).eq('id', req.params.id);
    }
    res.redirect('/admin/forum');
  } catch (e) { next(e); }
});

module.exports = router;
