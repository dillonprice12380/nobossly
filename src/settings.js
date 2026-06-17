const { anonClient } = require('./supabase');

let cache = { at: 0, data: {} };

async function getSocialLinks() {
  if (Date.now() - cache.at < 60000) return cache.data;
  try {
    const sb = anonClient();
    const { data } = await sb.from('site_settings').select('key, value').like('key', 'social_%');
    const out = {};
    (data || []).forEach(r => {
      let v = r.value;
      if (typeof v === 'string') v = v.replace(/^"|"$/g, '');
      out[r.key.replace('social_', '')] = v && /^https?:\/\//.test(v) ? v : '';
    });
    cache = { at: Date.now(), data: out };
  } catch (_) { /* keep stale */ }
  return cache.data;
}

async function attachSettings(req, res, next) {
  res.locals.social = await getSocialLinks();
  next();
}

module.exports = { attachSettings };
