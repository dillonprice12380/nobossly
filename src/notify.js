// Social fan-out + link preview helpers
function notifySocial(sb, actorId, message, entityType, entityId) {
  return sb.rpc('notify_social', { actor: actorId, nmessage: message, netype: entityType || null, neid: entityId || null })
    .then(() => {}, () => {});
}

// Fetch Open Graph preview for a URL (best effort, 4s timeout)
const ogCache = new Map();
async function fetchOg(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (ogCache.has(url)) return ogCache.get(url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; NoBosslyBot/1.0)', accept: 'text/html' } });
    clearTimeout(t);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const html = (await res.text()).slice(0, 200000);
    const meta = (prop) => {
      const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
      const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i');
      const m = html.match(re) || html.match(re2);
      return m ? m[1] : null;
    };
    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const out = {
      url,
      title: (meta('og:title') || (titleTag && titleTag[1]) || u.hostname).trim().slice(0, 160),
      image: meta('og:image') || meta('twitter:image') || null,
      domain: u.hostname.replace(/^www\./, '')
    };
    if (out.image && out.image.startsWith('/')) out.image = u.origin + out.image;
    if (ogCache.size > 500) ogCache.clear();
    ogCache.set(url, out);
    return out;
  } catch (_) { return null; }
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;
function firstUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0].replace(/[).,;!?]+$/, '') : null;
}

module.exports = { notifySocial, fetchOg, firstUrl };
