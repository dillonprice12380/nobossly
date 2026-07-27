const router = require('express').Router();
const { anonClient } = require('../supabase');

const client = req => req.sb || anonClient();

const PER_PAGE = 12;

// Strip characters that would break PostgREST's `or=(...)` filter grammar, and the
// LIKE wildcards that would otherwise let a stray "%" match every row.
// Dots and hyphens are safe to keep: PostgREST only splits on the first two dots.
const cleanQ = s => String(s || '').replace(/[,()%*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

const toPage = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 1; };

// Taxonomy slugs come from our own tables; anything else is dropped outright.
const cleanSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);

// Page numbers to render, with nulls standing in for ellipses.
function buildPager(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out = [1];
  if (page > 3) out.push(null);
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) out.push(i);
  if (page < pages - 2) out.push(null);
  out.push(pages);
  return out;
}

// Shared list query for cms_contents (blog) and cms_guides.
async function listPosts(req, { table, type, q, page }) {
  const sb = client(req);
  const isBlog = table === 'cms_contents';
  const cols = 'slug, title, excerpt, featured_image, published_at' + (isBlog ? ', view_count, author_id' : '');

  const scope = base => {
    let qy = base.eq('status', 'published');
    if (type) qy = qy.eq('type', type);
    if (q) qy = qy.or(`title.ilike.%${q}%,excerpt.ilike.%${q}%`);
    return qy;
  };

  // Count first so the page can be clamped before fetching a range that may not exist.
  const { count } = await scope(sb.from(table).select('slug', { count: 'exact', head: true }));
  const total = count || 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(page, pages);
  const from = (current - 1) * PER_PAGE;

  const { data: posts } = await scope(sb.from(table).select(cols))
    .order('published_at', { ascending: false })
    .range(from, from + PER_PAGE - 1);

  return { posts: posts || [], total, pages, page: current, pager: buildPager(current, pages) };
}

// Display names for blog post authors.
async function authorMap(req, posts) {
  const ids = [...new Set(posts.map(p => p.author_id).filter(Boolean))];
  if (!ids.length) return {};
  const { data } = await client(req).from('profiles').select('id, display_name, username').in('id', ids);
  const map = {};
  (data || []).forEach(a => map[a.id] = a.display_name || a.username);
  return map;
}

const BLOG_LIST = { table: 'cms_contents', type: 'blog', base: '/blog/', listUrl: '/blog', emptyIcon: '📰', emptyMsg: 'No posts yet.', showMeta: true };
const GUIDE_LIST = { table: 'cms_guides', type: null, base: '/guides/', listUrl: '/guides', emptyIcon: '📘', emptyMsg: 'No guides yet — check back soon.', showMeta: false };

// Builds the full render context for views/partials/post_list.ejs.
async function listContext(req, cfg) {
  const q = cleanQ(req.query.q);
  const result = await listPosts(req, { table: cfg.table, type: cfg.type, q, page: toPage(req.query.page) });
  const amap = cfg.showMeta ? await authorMap(req, result.posts) : {};
  return { ...result, q, amap, baseParams: { q }, base: cfg.base, listUrl: cfg.listUrl, emptyIcon: cfg.emptyIcon, emptyMsg: cfg.emptyMsg, showMeta: cfg.showMeta };
}

// Guides go through SQL functions rather than PostgREST: category and location
// filtering needs a join plus the location ancestor walk (a guide tagged
// "United States" must still surface when filtering by California), which is
// far clearer expressed in one query than assembled from embedded filters.
async function guidesContext(req) {
  const sb = client(req);
  const q = cleanQ(req.query.q);
  const cat = cleanSlug(req.query.cat);
  const loc = cleanSlug(req.query.loc);
  const args = { p_q: q, p_cat: cat, p_loc: loc };

  const [countRes, facetRes] = await Promise.all([
    sb.rpc('count_guides', args),
    sb.rpc('guide_facets', args)
  ]);

  const total = Number(countRes.data || 0);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(toPage(req.query.page), pages);

  const { data: rows } = await sb.rpc('list_guides', { ...args, p_limit: PER_PAGE, p_offset: (page - 1) * PER_PAGE });

  const facetRows = facetRes.data || [];
  const facets = {
    categories: facetRows.filter(f => f.facet === 'category').map(f => ({ slug: f.slug, name: f.name, n: Number(f.n) })),
    locations: facetRows.filter(f => f.facet === 'location').map(f => ({ slug: f.slug, name: f.name, kind: f.kind, n: Number(f.n) }))
  };

  return {
    posts: rows || [], total, pages, page, pager: buildPager(page, pages),
    q, cat, loc, facets, amap: {}, baseParams: { q, cat, loc },
    base: GUIDE_LIST.base, listUrl: GUIDE_LIST.listUrl,
    emptyIcon: GUIDE_LIST.emptyIcon, emptyMsg: GUIDE_LIST.emptyMsg, showMeta: false
  };
}

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

// AJAX endpoints for live search. Mounted above /blog/:slug and /guides/:slug so a
// path segment can never be mistaken for a slug. They render the same partial the
// full page uses, so card markup has exactly one definition.
router.get('/api/blog/search', async (req, res, next) => {
  try { res.render('partials/post_list', await listContext(req, BLOG_LIST)); } catch (e) { next(e); }
});

router.get('/api/guides/search', async (req, res, next) => {
  try { res.render('partials/post_list', await guidesContext(req)); } catch (e) { next(e); }
});

router.get('/blog', async (req, res, next) => {
  try {
    const ctx = await listContext(req, BLOG_LIST);
    res.render('blog_list', { title: 'Blog', ...ctx, metaDescription: 'Insights, playbooks, and founder stories from NoBossly.' });
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
    const ctx = await guidesContext(req);
    res.render('guides_list', { title: 'Guides', ...ctx, metaDescription: 'Practical guides for starting and growing your business with NoBossly.' });
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
