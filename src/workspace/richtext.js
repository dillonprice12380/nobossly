// Rich text for worksheet boxes (the canvases): bold, italic, underline,
// strikethrough, bullet and numbered lists, text colour and highlight.
//
// The editor (public/js/richtext.js) produces HTML in the browser; nothing it
// sends is trusted. Every value is cleaned here, on save AND again on display,
// down to a short list of tags and two style properties with plain colour
// values. No links, images, scripts, classes, ids or event handlers survive.

const sanitizeHtml = require('sanitize-html');

const MAX_HTML = 12000;      // stored length, after cleaning
const MAX_TEXT = 3000;       // visible characters

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

const OPTIONS = {
  allowedTags: ['p', 'br', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'ul', 'ol', 'li', 'span'],
  allowedAttributes: { span: ['style'], p: ['style'], li: ['style'], div: ['style'] },
  allowedStyles: { '*': { color: [COLOR], 'background-color': [COLOR] } },
  transformTags: {
    // Older browsers' execCommand writes <font color>; keep the colour, lose the tag.
    font: (tag, attribs) => ({ tagName: 'span', attribs: attribs.color && COLOR.test(attribs.color) ? { style: 'color:' + attribs.color } : {} }),
    b: 'strong', i: 'em', strike: 's', div: 'p'
  },
  disallowedTagsMode: 'discard',
  allowedSchemes: [],
  parser: { lowerCaseTags: true }
};

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Visible text of some HTML, for "is it empty?" and length limits.
const textOf = html => sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} })
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// Older saves stored a box as a list of lines; show those as a bullet list.
function fromLegacy(value) {
  if (Array.isArray(value)) return value.length ? '<ul>' + value.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul>' : '';
  if (value == null) return '';
  const s = String(value);
  return /<[a-z][\s\S]*>/i.test(s) ? s : s.split('\n').map(l => l.trim()).filter(Boolean).map(l => '<p>' + esc(l) + '</p>').join('');
}

// Longer documents (a course lesson, a listing's description) may also carry
// links: http(s) and mailto only, opened in a new tab without the referrer.
const WITH_LINKS = Object.assign({}, OPTIONS, {
  allowedTags: OPTIONS.allowedTags.concat(['a']),
  allowedAttributes: Object.assign({}, OPTIONS.allowedAttributes, { a: ['href'] }),
  allowedSchemes: ['https', 'http', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  transformTags: Object.assign({}, OPTIONS.transformTags, {
    a: (tag, attribs) => ({ tagName: 'a', attribs: { href: attribs.href || '', rel: 'noopener noreferrer nofollow', target: '_blank' } })
  })
});
WITH_LINKS.allowedAttributes.a = ['href', 'rel', 'target'];

// Clean HTML for storage or display. Returns '' when nothing visible is left.
// opts: { maxText, maxHtml, links } for longer documents.
function clean(value, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const maxText = o.maxText || MAX_TEXT, maxHtml = o.maxHtml || MAX_HTML;
  let html = sanitizeHtml(fromLegacy(value), o.links ? WITH_LINKS : OPTIONS)
    .replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/gi, '')   // empty paragraphs
    .trim();
  if (!textOf(html)) return '';
  if (html.length > maxHtml || textOf(html).length > maxText) {
    // Too long: keep the words, drop the formatting, rather than cutting a tag in half.
    html = '<p>' + esc(textOf(html).slice(0, maxText)) + '</p>';
  }
  return html;
}

module.exports = { clean, textOf, fromLegacy, MAX_TEXT };
