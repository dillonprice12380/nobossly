// Serves crawler-friendly OG/Twitter meta for blog posts and guides.
// Real browsers fall through to the normal EJS-rendered pages.
const { anonClient } = require('../supabase');

const SITE_URL = 'https://nobossly.com';
// No dedicated OG image asset exists yet; fall back to the brand logo.
const DEFAULT_IMAGE = 'https://res.cloudinary.com/dkxa3rup0/image/upload/v1779381926/nobossly-logo_a5ew2x.png';
const CRAWLERS = /facebookexternalhit|facebot|Twitterbot|LinkedInBot|WhatsApp|Slackbot|TelegramBot|Discordbot|Pinterest\//i;

const ROUTES = [
  { re: /^\/blog\/([^/]+)\/?$/, table: 'cms_contents', base: '/blog/' },
  { re: /^\/guides\/([^/]+)\/?$/, table: 'cms_guides', base: '/guides/' }
];

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = async function ogPrerender(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (!CRAWLERS.test(ua)) return next();

  let route = null, slug = null;
  for (const r of ROUTES) {
    const m = req.path.match(r.re);
    if (m) { route = r; slug = m[1]; break; }
  }
  if (!route) return next();

  try {
    const { data: post } = await anonClient()
      .from(route.table)
      .select('title, excerpt, featured_image, seo_title, seo_description, slug')
      .eq('slug', slug)
      .eq('status', 'published')
      .maybeSingle();

    if (!post) return next();

    const title = esc(post.seo_title || post.title);
    const desc  = esc(post.seo_description || post.excerpt);
    const image = post.featured_image || DEFAULT_IMAGE;
    const url   = `${SITE_URL}${route.base}${slug}`;

    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <meta name="description" content="${desc}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${image}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="NoBossly">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${image}">
  <meta http-equiv="refresh" content="0;url=${url}">
</head>
<body>
  <script>window.location.replace("${url}");</script>
  <p>Loading <a href="${url}">${title}</a>...</p>
</body>
</html>`);
  } catch (err) {
    console.error('[ogPrerender]', err);
    return next();
  }
};
