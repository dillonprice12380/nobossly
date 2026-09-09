// Where a form is allowed to send you afterwards.
//
// Routes across the social surface redirected to `req.body.back || referer`, so
// the destination came straight from the request:
//
//     <form method="post" action="https://nobossly.com/follow/…">
//       <input type="hidden" name="back" value="https://evil.example/login">
//
// — a real NoBossly URL, a real action, and then the member lands on somebody
// else's sign-in page still believing they are on the site they came from.
//
// A back link only ever means "the page you were just on", so it only ever
// needs to be a path on this site. The two inputs are not equally trustworthy
// and are not treated alike: `back` is written by our own templates, so it must
// be a rooted relative path and nothing else; a referer is a whole URL written
// by the browser, so its host has to be ours before its path is worth anything.
//
// Rejected either way: an absolute URL in `back`, a protocol-relative //host (a
// URL that borrows the current scheme), a backslash (some browsers read \\host
// as //host), a newline, and anything not rooted at /.
function relativePath(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw.startsWith('/')) return null;                       // a scheme, or relative
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;  // borrows the host
  if (/[\\\r\n]/.test(raw)) return null;
  return raw.slice(0, 500);
}

function refererPath(req) {
  const raw = req.get && req.get('referer');
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  const host = req.get('host');
  if (!host || url.host.toLowerCase() !== String(host).toLowerCase()) return null;
  return relativePath(url.pathname + url.search);
}

function safeBack(req, fallback) {
  return relativePath(req.body && req.body.back) || refererPath(req) || fallback;
}

module.exports = { safeBack, relativePath, refererPath };
