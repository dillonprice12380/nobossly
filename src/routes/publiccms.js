const router = require('express').Router();
const { anonClient } = require('../supabase');

const client = req => req.sb || anonClient();

// ---- TOC: add ids to h2/h3 in body html, return [{level, id, text}] ----
const headSlug = t => String(t || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
function buildToc(html) {
  const toc = [];
  const seen = {};
  const out = String(html || '').replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (m, lvl, attrs, inner) => {
    let id = headSlug(inner) || 'section';
    if (seen[id]) id = id + '-' + (++seen[id]); else seen[id] = 1;
    toc.push({ level: Number(lvl), id, text: inner.replace(/<[^>]+>/g, '') });
    return '<h' + lvl + attrs + ' id="' + id + '">' + inner + '</h' + lvl + '>';
  });
  return { html: out, toc };
}

// ---- sidebar loader: explicit sidebar or default similar-posts ----
async function loadSidebarFor(req, post, table) {
  const sb = client(req);
  let config = { show_similar: true, html_top: null, html_middle: null, html_bottom: null };
  if (post.sidebar_id) {
    const { data: s } = await sb.from('sidebars').select('*').eq('id', post.sidebar_id).maybeSingle();
    if (s) config = s;
  }
  let similar = [];
  if (config.show_similar) {
    let qy = sb.from(table).select('slug, title, excerpt, featured_image, published_at').eq('status', 'published').neq('id', post.id).order('published_at', { ascending: false }).limit(4);
    if (table === 'cms_contents') qy = qy.eq('type', 'blog');
    const { data } = await qy;
    similar = data || [];
  }
  return { config, similar, base: table === 'cms_guides' ? '/guides/' : '/blog/' };
}

router.get('/blog', async (req, res, next) => {
  try {
    const { data: posts } = await client(req).from('cms_contents').select('slug, title, excerpt, published_at, featured_image, view_count, author_id')
      .eq('type', 'blog').eq('status', 'published').order('published_at', { ascending: false }).limit(50);
    const authorIds = [...new Set((posts || []).map(p => p.author_id).filter(Boolean))];
    const { data: authors } = authorIds.length ? await client(req).from('profiles').select('id, display_name, username').in('id', authorIds) : { data: [] };
    const amap = {}; (authors || []).forEach(a => amap[a.id] = a.display_name || a.username);
    res.render('blog_list', { title: 'Blog', posts: posts || [], amap, metaDescription: 'Insights, playbooks, and founder stories from NoBossly.' });
  } catch (e) { next(e); }
});

router.get('/blog/:slug', async (req, res, next) => {
  try {
    const { data: post } = await client(req).from('cms_contents').select('*')
      .eq('type', 'blog').eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (!post) return res.status(404).render('error', { title: 'Not found', message: 'Post not found.' });
    const { html, toc } = buildToc(post.body);
    post.body = html;
    client(req).rpc('increment_blog_views', { post_slug: post.slug }).then(() => {}, () => {});
    let authorName = null;
    if (post.author_id) {
      const { data: a } = await client(req).from('profiles').select('display_name, username').eq('id', post.author_id).maybeSingle();
      if (a) authorName = a.display_name || a.username;
    }
    const sidebar = await loadSidebarFor(req, post, 'cms_contents');
    const shareUrl = 'https://nobossly.com/blog/' + post.slug;
    res.render('blog_post', { title: post.seo_title || post.title, post, toc, sidebar, authorName, shareUrl, metaDescription: post.seo_description || post.excerpt || '' });
  } catch (e) { next(e); }
});

// Legacy /p/:slug -> /:slug

// Guides
router.get('/guides', async (req, res, next) => {
  try {
    const { data: posts } = await client(req).from('cms_guides')
      .select('slug, title, excerpt, featured_image, published_at')
      .eq('status', 'published').order('published_at', { ascending: false }).limit(100);
    res.render('guides_list', { title: 'Guides', posts: posts || [], metaDescription: 'Practical guides for starting and growing your business with NoBossly.' });
  } catch (e) { next(e); }
});

router.get('/guides/:slug', async (req, res, next) => {
  try {
    const { data: post } = await client(req).from('cms_guides').select('*')
      .eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (!post) return res.status(404).render('error', { title: 'Not found', message: 'Guide not found.' });
    post.type = 'guide';
    const { html, toc } = buildToc(post.body);
    post.body = html;
    const sidebar = await loadSidebarFor(req, post, 'cms_guides');
    const shareUrl = 'https://nobossly.com/guides/' + post.slug;
    res.render('guide_post', { title: post.seo_title || post.title, post, toc, sidebar, shareUrl, metaDescription: post.seo_description || post.excerpt || '' });
  } catch (e) { next(e); }
});

// Help center
router.get('/help', (req, res) => {
  res.render('help', { title: 'Help Center', metaDescription: 'Answers to common questions about NoBossly — idea generation, sprints, plans, billing, and your account.' });
});

router.get('/p/:slug', (req, res) => res.redirect(301, '/' + req.params.slug));

// Pages live at /:slug (mounted last; falls through to 404 when no page matches)
router.get('/:slug', async (req, res, next) => {
  try {
    if (!/^[a-z0-9-]+$/.test(req.params.slug)) return next();
    const { data: page } = await client(req).from('cms_contents').select('*')
      .in('type', ['page', 'custom']).eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (!page) return next();
    res.render('blog_post', { title: page.seo_title || page.title, post: page, toc: [], sidebar: null, metaDescription: page.seo_description || page.excerpt || '' });
  } catch (e) { next(e); }
});

module.exports = router;
