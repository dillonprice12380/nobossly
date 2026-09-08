// One ladder per path.
//
// There used to be a single ten-rung ladder with per-gate exceptions bolted on
// — "except creator", "only brick_mortar". That worked, but it left every path
// climbing toward the same nine words: Ideator, Explorer, Builder, Hustler,
// Operator, Owner, Maker, Launcher, Operator Pro, Legend. None of them is what
// a plumber calls the moment their van gets sign-written, or what a creator
// calls their first sponsored post.
//
// So each path now has its own ten rungs, named in its own vernacular, with its
// own gates. Three things are deliberately held constant across all nine:
//
//   THE XP FLOORS. Identical everywhere, so the leaderboard, verified_level and
//   any cross-path comparison still mean something, and so no path is a faster
//   route to Level 10 than another.
//
//   THE TEN STAGES. Rung 5 is the first money on every path; rung 9 is the day
//   the job ends. The words change, what they cost does not.
//
//   THE COUNT OF GATES. Every rung asks for the same number of real things.
//
// STAGES below is the spine — the meaning of each rung, which is what stops
// nine ladders drifting into nine different games.

const STAGES = [
  { level: 1,  xp: 0,    means: 'Arrived. A Compass drawn and a direction taken.' },
  { level: 2,  xp: 100,  means: 'Validated. The idea passes your own fit test and three real people have responded to it.' },
  { level: 3,  xp: 300,  means: 'Shipped. Something you made is in the world and the first sprint is done.' },
  { level: 4,  xp: 600,  means: 'Faced the market. Enough conversations and enough asking to know what the answer sounds like.' },
  { level: 5,  xp: 1000, means: 'First money. A stranger paid you, and you are set up to receive it.' },
  { level: 6,  xp: 1500, means: 'Not a fluke. A hundred dollars, proof from the people who paid, and the money kept separate.' },
  { level: 7,  xp: 2200, means: 'Repeatable. Enough customers that it is a pattern, and one part of it runs without you.' },
  { level: 8,  xp: 3000, means: 'Income. The first month this reads as a wage rather than a hobby.' },
  { level: 9,  xp: 4000, means: 'Out. Two of: a profitable month, an accelerator finished, the job handed back.' },
  { level: 10, xp: 6000, means: 'Sustained, and written down for whoever comes next.' }
];

// Gates every path shares, by rung. A path names its own where its version of
// the same act has its own word; otherwise it takes these.
const c = title => ({ type: 'challenge', title });
const m = title => ({ type: 'milestone', title });

const SPINE = {
  1:  [],
  2:  [m('Compass Questions Answered'), m('Passes Your Own Test'), m('Three Real Signals'),
       c('Get 3 Feedback Sessions'), c('Validate your idea')],
  3:  [m('Blueprint Built'), c('Ship Something'), m('Sprint 1 Completed')],
  4:  [c('5 Customer Conversations'), c('Do 25 outreach touches')],
  5:  [c('Make your first sale'), m('Registered my business')],
  6:  [c('Earn Your First $100'), m('Opened a business bank account'), c('Collect 5 testimonials')],
  7:  [c('Reach 10 paying customers'), c('Automate one process')],
  8:  [c('Hit a $1k month'), m('Write your one-page plan')],
  9:  [m('Completed an accelerator program'), m('Had my first profitable month'), m('Went full-time on my business')],
  10: [m('Three $1k months in a row'), c('Document your playbook')]
};

// Rung 9 is the only one that does not demand everything it lists.
const MIN_AT = { 9: 2 };

// A path is ten titles plus whatever gates it replaces. `gates` overrides the
// spine for that rung entirely, so what a rung asks is always readable in one
// place rather than assembled from exceptions.
const LADDERS = {
  creator: {
    label: 'Content creator',
    rungs: [
      ['Lurker', '👀'], ['Poster', '📝'], ['Publisher', '📣'], ['Regular', '🔁'],
      ['Paid Creator', '💸'], ['Sponsored', '🤝'], ['Showrunner', '🎛️'],
      ['Headliner', '🌟'], ['Full-Time Creator', '🎬'], ['Institution', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('Publish 12 pieces in 30 days'), m('Sprint 1 Completed')],
      4: [c('5 Customer Conversations'), c('Pitch 25 brands or collaborators')],
      5: [c('Make your first sale'), m('Set up how you get paid')],
      6: [c('Earn Your First $100'), m('Separate your business money'), c('Collect 5 pieces of audience proof')]
    }
  },
  freelancer: {
    label: 'Freelancer',
    rungs: [
      ['Moonlighter', '🌙'], ['Open for Work', '📂'], ['Portfolio Ready', '🗂️'], ['Pitching', '📨'],
      ['Hired', '✍️'], ['Repeat Hire', '🔂'], ['Booked', '📅'],
      ['In Demand', '🔥'], ['Independent', '🕊️'], ['Studio of One', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('Publish a portfolio that wins work'), m('Sprint 1 Completed')]
    }
  },
  consultant: {
    label: 'Coach or consultant',
    rungs: [
      ['Quiet Expert', '🤫'], ['Positioned', '🎯'], ['Packaged', '🎁'], ['In the Room', '🚪'],
      ['First Engagement', '🤝'], ['Trusted Adviser', '🧭'], ['Practice Owner', '🏛️'],
      ['Sought Out', '📈'], ['Independent Consultant', '🕊️'], ['The Authority', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('Price one offer by the outcome'), m('Sprint 1 Completed')],
      10: [m('$1K MRR'), c('Document your playbook')]
    }
  },
  local_service: {
    label: 'Local service',
    rungs: [
      ['Odd Jobber', '🧰'], ['Kitted Out', '🚿'], ['Signwritten', '🚚'], ['Quoting', '📋'],
      ['First Invoice', '🧾'], ['Regulars', '🔁'], ['Booked Out', '📅'],
      ['Full Round', '🗺️'], ['Own Boss', '🕊️'], ['The One They Call', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('Get your Google Business Profile live and verified'), m('Sprint 1 Completed')],
      4: [c('5 Customer Conversations'), c('Quote 10 jobs in two weeks')]
    }
  },
  brick_mortar: {
    label: 'Brick and mortar',
    rungs: [
      ['Daydreamer', '💭'], ['Scouting', '🔎'], ['Pop-Up', '⛺'], ['Pitching the Concept', '🗣️'],
      ['First Till Ring', '🔔'], ['Keyholder', '🔑'], ['Open Regular Hours', '🕰️'],
      ['Rent Covered', '🏦'], ['Owner-Operator', '🕊️'], ['Local Landmark', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('Test the concept without the lease'), m('Sprint 1 Completed')],
      4: [c('5 Customer Conversations'), c('Count footfall at three sites')],
      7: [c('Serve 100 paying customers'), c('Automate one process')],
      8: [c("Cover a month's rent from takings"), m('Built a pitch deck')],
      10: [m('Three months of covering rent and paying yourself'), c('Document your playbook')]
    }
  },
  online_store: {
    label: 'Online store',
    rungs: [
      ['Browser', '🛒'], ['Sourced', '📦'], ['Listed', '🏷️'], ['Driving Traffic', '📡'],
      ['First Order', '🔔'], ['Shipping Weekly', '📮'], ['Repeat Buyers', '🔁'],
      ['Real Storefront', '🏬'], ['Full-Time Shop', '🕊️'], ['Brand', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('List your first product properly'), m('Sprint 1 Completed')],
      4: [c('5 Customer Conversations'), c('Work out your true unit margin')],
      7: [c('Reach 50 paying customers'), c('Automate one process')]
    }
  },
  physical_product: {
    label: 'Physical product',
    rungs: [
      ['Sketcher', '✏️'], ['Prototyper', '🔩'], ['Sampled', '📐'], ['Showing It Round', '🧳'],
      ['First Unit Sold', '🔔'], ['Small Batch', '📦'], ['Production Run', '🏭'],
      ['On Shelves', '🏬'], ['Full-Time Maker', '🕊️'], ['A Product People Name', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('Make one by hand and sell it'), m('Sprint 1 Completed')],
      4: [c('5 Customer Conversations'), c('Get three manufacturing quotes')],
      8: [c('Hit a $1k month'), m('Built a pitch deck')]
    }
  },
  software: {
    label: 'Software or app',
    rungs: [
      ['Tinkerer', '🔧'], ['Specced', '📄'], ['Shipped v1', '🚀'], ['Talking to Users', '🎧'],
      ['First Paying User', '💳'], ['Charging Properly', '💰'], ['Ten Payers', '🔟'],
      ['Real Revenue', '📈'], ['Full-Time on It', '🕊️'], ['Depended On', '👑']
    ],
    gates: {
      3: [m('Blueprint Built'), c('Ship something usable in 30 days'), m('Sprint 1 Completed')],
      4: [c('5 Customer Conversations'), c('Watch 5 people use it without helping')],
      8: [c('Hit a $1k month'), m('Built a pitch deck')],
      10: [m('$1K MRR'), c('Document your playbook')]
    }
  },
  exploring: {
    label: 'Still figuring it out',
    rungs: [
      ['Curious', '🧭'], ['Narrowed', '🎯'], ['Committed', '🤞'], ['Testing', '🧪'],
      ['First Sale', '🔔'], ['In Business', '🏁'], ['Repeatable', '🔁'],
      ['Earning', '📈'], ['Out of the Job', '🕊️'], ['Legend', '👑']
    ],
    gates: {
      4: [c('5 Customer Conversations'), c('Interview 5 people in a field you are curious about')],
      5: [c('Make your first sale'), m('Set up how you get paid')],
      6: [c('Earn Your First $100'), m('Separate your business money'), c('Collect 5 testimonials')]
    }
  }
};

// The fallback for anyone who has not chosen a path yet — the old universal
// wording, kept so a half-onboarded member never sees an empty ladder.
const DEFAULT_RUNGS = [
  ['Ideator', '🌱'], ['Explorer', '🔍'], ['Builder', '🔨'], ['Hustler', '⚡'],
  ['Operator', '⚙️'], ['Owner', '🚀'], ['Maker', '🛠️'],
  ['Launcher', '🎯'], ['Operator Pro', '💎'], ['Legend', '👑']
];

const SLUGS = Object.keys(LADDERS);
const DEFAULT_PATH = 'default';

// One path's ten rungs, resolved: spine gates unless the path names its own.
function ladderFor(slug) {
  const def = LADDERS[slug];
  const rungs = def ? def.rungs : DEFAULT_RUNGS;
  return STAGES.map((s, i) => ({
    path: def ? slug : DEFAULT_PATH,
    level: s.level,
    title: rungs[i][0],
    emoji: rungs[i][1],
    xp_required: s.xp,
    means: s.means,
    min: MIN_AT[s.level] || null,
    gates: (def && def.gates && def.gates[s.level]) || SPINE[s.level] || []
  }));
}

const all = () => SLUGS.concat([DEFAULT_PATH]).map(ladderFor);

// Every distinct quest any ladder gates on, so a test can prove each one exists
// and is awardable before a member is ever asked for it.
function allGates() {
  const seen = new Map();
  for (const rungs of all()) {
    for (const r of rungs) for (const g of r.gates) seen.set(g.type + ':' + g.title, g);
  }
  return [...seen.values()];
}

// The rung a member is on, and the one above it.
const rungAt = (path, level) => ladderFor(path).find(r => r.level === level) || null;

// What a level-up actually says. Ninety bespoke unlock lines would rot; the
// rung's own title plus its stage meaning is true on every path and cannot
// drift from the gates, because both come from here.
const unlockText = rung => rung ? rung.title + ' unlocked: ' + rung.means : '';

const gateKey = g => g.type + ':' + String(g.title).trim().toLowerCase();

// Has this member cleared the rung? `have` is the set of quest keys from
// achievedQuests. min is clamped to what the rung actually lists, so a rung can
// never ask for two of one.
function meetsRung(rung, have) {
  const gates = (rung && rung.gates) || [];
  if (!gates.length) return true;
  const hits = gates.filter(g => have.has(gateKey(g))).length;
  const need = rung.min && rung.min > 0 ? Math.min(rung.min, gates.length) : gates.length;
  return hits >= need;
}

// Gates that belong to somebody else's ladder. The quest board and the trophy
// case filter by level only, so without this a creator browses "Count footfall
// at three sites" beside their own. Anything already accepted or earned stays
// visible — a board that removes work someone is part-way through is worse than
// one showing a stray card.
function foreignGateTitles(path, type) {
  const mine = new Set(ladderFor(path).flatMap(r => r.gates).filter(g => g.type === type)
    .map(g => String(g.title).trim().toLowerCase()));
  return new Set(allGates().filter(g => g.type === type)
    .map(g => String(g.title).trim().toLowerCase())
    .filter(t => !mine.has(t)));
}

module.exports = { STAGES, SPINE, LADDERS, DEFAULT_RUNGS, SLUGS, DEFAULT_PATH, MIN_AT,
                   ladderFor, all, allGates, rungAt, unlockText, gateKey, meetsRung, foreignGateTitles };
