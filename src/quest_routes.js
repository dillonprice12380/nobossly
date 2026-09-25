// Where a quest is actually done.
//
// auto_kind -> where the member creates that fact. 'ideas', 'idea_fit_pct',
// 'signals', 'ideas_cut' and 'blueprints' pointed at the Compass, which no
// longer exists — the milestones that used those kinds were removed from
// every ladder (see src/ladders.js), so those entries are gone here too
// rather than pointing at a dead page.
const BY_AUTO_KIND = {
  questionnaire:   { href: '/choose-path',   cta: 'Pick a path' },
  sprints_started: { href: '/dashboard',     cta: 'Start one' },
  sprints_done:    { href: '/dashboard',     cta: 'Open sprint' },
  tasks:           { href: '/tasks',         cta: 'Open board' },
  checkins:        { href: '/dashboard',     cta: 'Check in' },
  streak:          { href: '/dashboard',     cta: 'Check in' },
  followers:       { href: '/members',       cta: 'Find members' },
  challenges:      { href: '/quests',        cta: 'Take one on' },
  posts:           { href: '/community',     cta: 'Post' },
  profile:         { href: '/members/me/edit', cta: 'Fill it in' }
};

// Quests are accepted on /quests, with one exception: the peer-review
// queue is a whole route built to earn this specific quest, and the generic
// link pointed away from it.
const CHALLENGE_ROUTES = {
  'Get 3 Feedback Sessions': { href: '/reviews', cta: 'Get reviews' }
};

const CLAIM = { href: '/trophies', cta: 'Log it' };
const CHALLENGE = { href: '/quests', cta: 'Take it on' };

// `def` is the predefined_milestones row for a milestone gate, when one was
// loaded. Without it the old behaviour is the fallback, so a missing row
// degrades to a working link rather than a broken one.
function destinationFor(gate, def) {
  if (!gate) return CHALLENGE;
  if (gate.type === 'challenge') {
    return CHALLENGE_ROUTES[gate.title] || CHALLENGE;
  }
  if (def && def.auto_kind && BY_AUTO_KIND[def.auto_kind]) return BY_AUTO_KIND[def.auto_kind];
  return CLAIM;
}

module.exports = { destinationFor, BY_AUTO_KIND, CHALLENGE_ROUTES };
