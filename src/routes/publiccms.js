const router = require('express').Router();
const { anonClient } = require('../supabase');

const client = req => req.sb || anonClient();

const PER_PAGE = 12;

const cleanQ = s => String(s || '').replace(/[,()%*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

const toPage = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 1; };

const cleanSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);

function buildPager(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out = [1];
  if (page > 3) out.push(null);
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) out.push(i);
  if (page < pages - 2) out.push(null);
  out.push(pages);
  return out;
}

async function listPosts(req, { table, type, q, page }) {
  const sb = client(req);
  const isBlog = table === 'cms_contents';
  const cols = 'slug, title, excerpt, published_at' + (isBlog ? ', featured_image, view_count, author_id' : '');

  const scope = base => {
    let qy = base.eq('status', 'published');
    if (type) qy = qy.eq('type', type);
    if (q) qy = qy.or(`title.ilike.%${q}%,excerpt.ilike.%${q}%`);
    return qy;
  };

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

async function authorMap(req, posts) {
  const ids = [...new Set(posts.map(p => p.author_id).filter(Boolean))];
  if (!ids.length) return {};
  const { data } = await client(req).from('profiles').select('id, display_name, username').in('id', ids);
  const map = {};
  (data || []).forEach(a => map[a.id] = a.display_name || a.username);
  return map;
}

const BLOG_LIST = { table: 'cms_contents', type: 'blog', base: '/blog/', listUrl: '/blog', emptyIcon: '\uD83D\uDCF0', emptyMsg: 'No posts yet.', showMeta: true, showImage: true };
const GUIDE_LIST = { table: 'cms_guides', type: null, base: '/guides/', listUrl: '/guides', emptyIcon: '\uD83D\uDCD8', emptyMsg: 'No guides yet \u2014 check back soon.', showMeta: false };

async function listContext(req, cfg) {
  const q = cleanQ(req.query.q);
  const result = await listPosts(req, { table: cfg.table, type: cfg.type, q, page: toPage(req.query.page) });
  const amap = cfg.showMeta ? await authorMap(req, result.posts) : {};
  return { ...result, q, amap, baseParams: { q }, showImage: cfg.showImage !== false, base: cfg.base, listUrl: cfg.listUrl, emptyIcon: cfg.emptyIcon, emptyMsg: cfg.emptyMsg, showMeta: cfg.showMeta };
}

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
    emptyIcon: GUIDE_LIST.emptyIcon, emptyMsg: GUIDE_LIST.emptyMsg, showMeta: false, showImage: false
  };
}

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

const stripLeadH1 = html => String(html || '').replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '');

// For a guide tagged at country level, "Keep reading" is scoped to neighboring countries
// first, then other countries on the same continent (see similar_location_guides in the
// DB). State guides and blog posts don't have that geography, so they fall back to the
// simple "most recent" pool, same as before.
async function loadSidebarFor(req, post, table) {
  const sb = client(req);
  let config = { show_similar: true, html_top: null, html_middle: null, html_bottom: null };
  if (post.sidebar_id) {
    const { data: s } = await sb.from('sidebars').select('*').eq('id', post.sidebar_id).maybeSingle();
    if (s) config = s;
  }
  let similar = [];
  if (config.show_similar) {
    if (table === 'cms_guides') {
      const { data: related } = await sb.rpc('similar_location_guides', { p_guide_id: post.id, p_limit: 4 });
      similar = related || [];
    }
    if (!similar.length) {
      const simCols = table === 'cms_guides'
        ? 'slug, title, excerpt, published_at'
        : 'slug, title, excerpt, featured_image, published_at';
      let qy = sb.from(table).select(simCols).eq('status', 'published').neq('id', post.id).order('published_at', { ascending: false }).limit(4);
      if (table === 'cms_contents') qy = qy.eq('type', 'blog');
      const { data } = await qy;
      similar = data || [];
    }
  }
  return { config, similar, base: table === 'cms_guides' ? '/guides/' : '/blog/' };
}

async function locationsContext(req) {
  const sb = client(req);
  const [{ data: allLocs }, { data: cat }] = await Promise.all([
    sb.from('guide_locations').select('id, slug, name, kind, parent_id').order('name'),
    sb.from('guide_categories').select('id').eq('slug', 'start-a-business').maybeSingle()
  ]);

  let guideByLocation = {};
  if (cat) {
    const { data: catGuides } = await sb.from('cms_guide_categories').select('guide_id').eq('category_id', cat.id);
    const guideIds = (catGuides || []).map(r => r.guide_id);
    if (guideIds.length) {
      const [{ data: guides }, { data: links }] = await Promise.all([
        sb.from('cms_guides').select('id, slug, title, excerpt').in('id', guideIds).eq('status', 'published'),
        sb.from('cms_guide_locations').select('guide_id, location_id').in('guide_id', guideIds)
      ]);
      const guideById = {};
      (guides || []).forEach(g => { guideById[g.id] = g; });
      (links || []).forEach(l => {
        const g = guideById[l.guide_id];
        if (g) guideByLocation[l.location_id] = g;
      });
    }
  }

  const locs = allLocs || [];
  const byId = {};
  locs.forEach(l => { byId[l.id] = l; });

  const globalRoot = locs.find(l => l.kind === 'global');
  const globalId = globalRoot ? globalRoot.id : null;

  const continentRows = locs.filter(l => l.kind === 'region' && l.parent_id === globalId);
  const continentById = {};
  continentRows.forEach(ct => { continentById[ct.id] = ct; });

  const findAncestor = (loc, matches) => {
    let cur = loc, depth = 0;
    while (cur && !matches(cur) && depth < 6) { cur = byId[cur.parent_id]; depth++; }
    return cur && matches(cur) ? cur : null;
  };

  const countries = locs.filter(l => l.kind === 'country').map(c => {
    const continent = findAncestor(c, n => !!continentById[n.id]);
    return {
      slug: c.slug, name: c.name, guide: guideByLocation[c.id] || null, states: [],
      continentSlug: continent ? continent.slug : null
    };
  });
  const countryBySlug = {};
  countries.forEach(c => { countryBySlug[c.slug] = c; });

  locs.filter(l => l.kind === 'state').forEach(s => {
    const country = findAncestor(s, n => n.kind === 'country');
    if (!country || !countryBySlug[country.slug]) return;
    countryBySlug[country.slug].states.push({ slug: s.slug, name: s.name, guide: guideByLocation[s.id] || null });
  });
  countries.forEach(c => c.states.sort((a, b) => a.name.localeCompare(b.name)));

  const visibleCountries = countries.filter(c => c.states.length || c.guide);

  const continents = continentRows.map(ct => ({
    slug: ct.slug,
    name: ct.name,
    countries: visibleCountries.filter(c => c.continentSlug === ct.slug).sort((a, b) => a.name.localeCompare(b.name))
  })).filter(g => g.countries.length);
  continents.sort((a, b) => a.name.localeCompare(b.name));

  const totalCountries = continents.reduce((sum, ct) => sum + ct.countries.length, 0);

  return { continents, totalCountries };
}

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
    post.body = stripLeadH1(html);
    const sidebar = await loadSidebarFor(req, post, 'cms_guides');
    const shareUrl = 'https://nobossly.com/guides/' + post.slug;
    res.render('guide_post', { title: post.seo_title || post.title, post, toc, sidebar, shareUrl, metaDescription: post.seo_description || post.excerpt || '' });
  } catch (e) { next(e); }
});

// Location hub: "Start a Business by Location" (grouped by continent, US as a
// state-by-state accordion under North America; more countries over time)
router.get('/locations', async (req, res, next) => {
  try {
    const ctx = await locationsContext(req);
    res.render('locations', { title: 'Start a Business by Location', ...ctx, metaDescription: 'Country- and state-specific guides to registering, licensing, and launching your business, wherever you are.' });
  } catch (e) { next(e); }
});

// Help center
router.get('/help', (req, res) => {
  res.render('help', { title: 'Help Center', metaDescription: 'Answers to common questions about NoBossly \u2014 idea generation, sprints, plans, billing, and your account.' });
});

// How it works
router.get('/how-it-works', (req, res) => {
  res.render('how_it_works', {
    title: 'How It Works',
    metaDescription: 'Learn how NoBossly turns your skills and passions into a real business \u2014 AI-matched ideas, launch blueprints, 7-day sprints, milestones, challenges, and a founder community.'
  });
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
