const sanitizeHtml = require('sanitize-html');
const { fetchOg } = require('./notify');

function sanitizeForumHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'pre', 'code', 'div', 'span'],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt', 'loading'],
      div: ['class'], span: ['class']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedClasses: { div: ['link-card', 'link-card-body'], span: ['link-card-domain'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener', target: '_blank' }),
      img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' })
    }
  }).slice(0, 60000);
}

function linkCardHtml(og) {
  const esc = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<a class="link-card" href="' + esc(og.url) + '" rel="nofollow noopener" target="_blank">' +
    (og.image ? '<img src="' + esc(og.image) + '" alt="" loading="lazy">' : '') +
    '<span class="link-card-body"><strong>' + esc(og.title) + '</strong><span class="link-card-domain">' + esc(og.domain) + '</span></span></a>';
}

// Replace paragraphs that contain ONLY a bare URL with an OG preview card
async function addLinkCards(html) {
  const re = /<p>\s*(https?:\/\/[^\s<>"']+)\s*<\/p>/gi;
  const matches = [...String(html || '').matchAll(re)].slice(0, 5);
  let out = html;
  for (const m of matches) {
    const og = await fetchOg(m[1]);
    if (og) out = out.replace(m[0], linkCardHtml(og));
    else out = out.replace(m[0], '<p><a href="' + m[1] + '" rel="nofollow noopener" target="_blank">' + m[1] + '</a></p>');
  }
  return out;
}

module.exports = { sanitizeForumHtml, addLinkCards, linkCardHtml };
