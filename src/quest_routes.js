// Where a quest is actually done.
//
// The Ladder names what is blocking your next rung, and until now every one of
// those quests linked to the same two pages: /quests or /trophies,
// decided by a single ternary on the gate's type. For a challenge that is
// usually right — you take quests on on the quest board. For a trophy it was
// usually wrong.
//
// Twelve of the seventeen milestone gates are self-claimed, and /milestones is
// genuinely where you claim them: the proof form is on that page. But five are
// awarded automatically by sweepMilestones() from something you did somewhere
// else entirely. Clicking "Go" on "Passes Your Own Test" took you to a list
// where the row sits un-ticked with no button, and nothing said the actual
// answer is "go back to your idea and revise it until your own fit test
// passes".
//
// So the destination is derived from the SAME field the engine awards on —
// predefined_milestones.auto_kind — rather than from a second list that would
// drift away from it. Add an auto milestone and it inherits the right
// destination; add a new auto_kind and this map is the one place to say where
// that fact is created.

// auto_kind -> where the member creates that fact. Every kind computeMetrics()
// knows how to count appears here, not only the five that currently gate a rung.
const BY_AUTO_KIND = {
  questionnaire:   { href: '/questionnaire', cta: 'Answer' },
  ideas:           { href: '/compass',       cta: 'Draft it' },
  idea_fit_pct:    { href: '/compass',       cta: 'Revise it' },
  signals:         { href: '/compass',       cta: 'Add evidence' },
  ideas_cut:       { href: '/compass',       cta: 'Review' },
  blueprints:      { href: '/compass',       cta: 'Build one' },
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
  // Self-claimed, or unknown: /milestones is right — the proof form is there.
  return CLAIM;
}

module.exports = { destinationFor, BY_AUTO_KIND, CHALLENGE_ROUTES };
