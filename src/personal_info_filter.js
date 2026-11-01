// Keeps contact details out of member-written text. NoBossly is 18+ and
// public by default; an email, a phone number or a street address posted in a
// forum thread or a group is something nobody can take back. Members connect
// through NoBossly messages instead.
//
// Links and social handles are allowed: members share their business sites.
//
// The same patterns run in the database (contains_personal_info() in
// migrations/2026-11-01_personal_info_filter.sql), so a write that skips the
// app and goes straight to the API with a member's token is caught too. Keep
// the two in step; test/personal-info.js checks the cases both must agree on.

const MESSAGE = 'Please remove emails, phone numbers and street addresses. Use NoBossly messages to connect.';

const DIGIT_WORDS = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
const TLDS = '(?:com|net|org|io|co|edu|gov|us|uk|ca|me|info|biz|app|dev)';
// Words that turn "3 hours on the road" or "took 2 years to drive" into
// ordinary sentences rather than addresses.
const NOT_IN_A_STREET_NAME = '(?:on|the|in|to|a|an|of|down|up|my|your|our|their|at|for|from|with|by|this|that|and|or|hours?|days?|weeks?|months?|years?|miles?|minutes?|times?)';

const PATTERNS = [
  // name@site.com
  ['email', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
  // name (at) site (dot) com, name at gmail dot com, name [at] site [dot] co
  ['email', new RegExp(`[a-z0-9._%+-]+\\s*[([{]?\\s*(?:at|@)\\s*[)\\]}]?\\s*[a-z0-9-]+\\s*[([{]?\\s*(?:dot|\\.)\\s*[)\\]}]?\\s*${TLDS}\\b`, 'i')],
  // (555) 123-4567, 555.123.4567, +1 555 123 4567
  ['phone', /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/],
  // +44 20 7946 0958 and other international numbers written with a plus
  ['phone', /\+\d[\d\s().-]{8,}\d/],
  // 5551234567 and longer runs
  ['phone', /\b\d{10,15}\b/],
  // five five five one two three four
  ['phone', new RegExp(`\\b${DIGIT_WORDS}(?:[\\s,.-]+${DIGIT_WORDS}){6,}\\b`, 'i')],
  // 120 Main Street, 12 Oak Ln, 4500 Martin Luther King Jr Blvd
  ['address', new RegExp(`\\b\\d{1,6}\\s+(?:(?!${NOT_IN_A_STREET_NAME}\\b)[a-z0-9.'-]+\\s+){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln)\\b`, 'i')],
  // PO Box 123, P.O. Box 123
  ['address', /\bp\.?\s*o\.?\s*box\s*\d+/i],
  // Apt 4B, Suite 200, Ste. 12, Unit #3. "Unit" alone needs the # — course
  // talk ("unit 3 of the course") is far more common than an address.
  ['address', /\b(?:apt|apartment|suite|ste)\.?\s*#?\s*\d+[a-z]?\b|\bunit\s*#\s*\d+[a-z]?\b/i]
];

// Which kind of contact detail the text contains, or null.
function describe(text) {
  const s = String(text == null ? '' : text);
  if (!s) return null;
  const hit = PATTERNS.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

const containsPersonalInfo = text => describe(text) !== null;

// The first field that fails, across every field a form submits.
function check(...texts) {
  for (const t of texts) { const kind = describe(t); if (kind) return kind; }
  return null;
}

// Records a refused write so admins can see who keeps trying (3+ in a day is
// the review threshold). Stores what kind of detail and where — never the text.
function recordHit(req, kind, where) {
  if (!req || !req.sb || !req.user) return;
  const { quiet } = require('./db');
  req.sb.from('filter_hits').insert({ user_id: req.user.id, kind, context: String(where).slice(0, 40) })
    .then(...quiet('filter_hits.insert'));
}

// The one way a route turns a write down: record it, and send the member back
// with the message the shared header shows.
function refuse(req, res, to, kind, where) {
  recordHit(req, kind, where);
  return res.redirect(to + (to.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent(MESSAGE));
}

module.exports = { MESSAGE, PATTERNS, describe, containsPersonalInfo, check, recordHit, refuse };
