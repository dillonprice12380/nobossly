// Every paid gate used to be a bare `res.redirect('/pricing?upgrade=1')`. The
// member lost their place and got a price list instead of an answer to the
// question they actually asked, which was "what is behind this button?".
//
// gate() renders that answer in place: what the feature does, what it would
// have done for them just now, and a way back to where they were.

const FEATURES = {
  ai_challenges: {
    title: 'AI-tailored quests',
    blurb: 'Reads your active blueprint and writes a set of quests built around your actual business — your customers, your channel, your bottleneck — instead of the shared quest board.',
    gets: ['A fresh set of up to 10 quests tailored to your blueprint',
           'Regenerate whenever your blueprint changes',
           'Everything on the shared quest board stays free either way'],
    back: { href: '/quests', label: 'Back to quests' }
  },
  ai_milestones: {
    title: 'AI-tailored goals',
    blurb: 'Turns your blueprint into a personal goal ladder you tick off yourself — separate from the trophies, which you keep earning free by playing.',
    gets: ['Up to 10 personal goals written from your blueprint',
           'Regenerate as the business moves',
           'Your trophy case stays free and keeps unlocking'],
    back: { href: '/trophies', label: 'Back to trophies' }
  },
  ai_budget: {
    title: 'AI startup budget',
    blurb: 'Drafts a lean starting budget from your blueprint, then reads your real spending against it each month.',
    gets: ['A tailored starter budget across up to 12 categories',
           'Monthly insights on where the money is actually going',
           'Manual budgets and expense tracking stay free'],
    back: { href: '/budget', label: 'Back to budget' }
  },
  extra_blueprint: {
    title: 'More than one blueprint',
    blurb: 'The free plan builds one full launch blueprint. Paid lifts the cap so you can blueprint every idea worth taking seriously and compare them side by side.',
    gets: ['Unlimited launch blueprints', 'Live demand evidence on any idea', 'Week-1 actions dispersed straight to your task board'],
    back: { href: '/compass', label: 'Back to your Compass' }
  },
  demand_evidence: {
    title: 'Live demand evidence',
    blurb: 'Searches the live web for real signals that people want what your idea sells — the posts, the complaints, the money already changing hands.',
    gets: ['Real demand signals gathered for any idea', 'Refresh as the market moves', 'Runs automatically on your top idea'],
    back: { href: '/compass', label: 'Back to your Compass' }
  },
  disperse_tasks: {
    title: 'Blueprint → task board',
    blurb: 'Breaks your blueprint\'s Week-1 actions into dated tasks on your board so the first week plans itself.',
    gets: ['Week-1 actions dispersed with staggered deadlines', 'The same for every new blueprint', 'Manual task entry stays free'],
    back: { href: '/compass', label: 'Back to your Compass' }
  },
  weekly_plan: {
    title: 'This week\u2019s plan',
    blurb: 'Every Monday, the coach reads where you are on your ladder \u2014 the exact quest blocking your next rung \u2014 the hours you said you have after work, and what you actually finished last week. Then it writes three things for this week. Not a template: three specific actions, dated, sized to your evenings.',
    gets: ['Three actions a week, aimed at the rung you are actually on',
           'Written against what you finished last week, not what you were asked to do',
           'Sized to the hours and the money you told us you have',
           'Your ladder, your quests and the whole community stay free either way'],
    back: { href: '/coach', label: 'Back to the coach' }
  },
  proof_review: {
    title: 'Proof review',
    blurb: 'Before you claim a rung, the coach reads what you wrote as proof and tells you whether it actually clears the gate \u2014 and what would make it beyond doubt. The Wins wall is public; this is what keeps a rung meaning something.',
    gets: ['An honest read on whether your proof clears the gate',
           'What is missing, specifically',
           'A stronger way to say it on the Wins wall'],
    back: { href: '/coach', label: 'Back to the coach' }
  },
  out_of_credits: {
    title: 'You have used this month\u2019s free AI',
    blurb: 'Every AI call on NoBossly draws on a monthly allowance \u2014 drawing a Compass, stress-testing an idea, a coach reply. The free allowance refills on the 1st. The Escape plan lifts the ceiling far enough that you will not meet it.',
    gets: ['A ceiling high enough you will not think about it again',
           'The weekly plan, the coach, and proof review',
           'Your ladder, your quests, the forum and the Wins wall stay free either way'],
    back: { href: '/dashboard', label: 'Back to dashboard' }
  },
  groups: {
    title: 'Starting a group',
    blurb: 'Anyone can join and post in groups. Creating and running one is a paid feature.',
    gets: ['Start your own group', 'Moderate members and posts', 'Joining and posting stays free'],
    back: { href: '/groups', label: 'Back to groups' }
  },
  collaborations: {
    title: 'Collaboration projects',
    blurb: 'Post a project, recruit other members on the platform, and run it with a shared board.',
    gets: ['Post collaboration projects', 'Review and accept collaborators', 'Browsing collaborations stays free'],
    back: { href: '/collaborations', label: 'Back to collaborations' }
  }
};

// Renders the in-place explanation. `key` picks the copy; anything unknown falls
// back to a generic panel rather than throwing on a page someone is reading.
function gate(res, key, backHref) {
  const f = FEATURES[key] || {
    title: 'A paid feature',
    blurb: 'This one is part of the Escape plan.',
    gets: ['Everything in the free plan, uncapped'],
    back: { href: '/dashboard', label: 'Back to dashboard' }
  };
  const back = backHref ? { href: backHref, label: 'Go back' } : f.back;
  return res.status(402).render('upgrade', { title: f.title, feature: f, back });
}

// For endpoints that answer JSON (the background generation jobs), where a
// rendered page would break the client.
function gateJson(res, key) {
  const f = FEATURES[key] || {};
  return res.json({
    error: (f.title ? f.title + ' is part of the Escape plan. ' : '') + (f.blurb || ''),
    redirect: '/pricing?upgrade=1'
  });
}

// The refusal a member meets when the AI rail says no. A free member gets the
// upgrade panel, because the ceiling really is the reason. A paying member who
// has burned 400 credits in a month is almost certainly a script, and selling
// them a plan they already have would be nonsense — they get the plain limit.
function gateCredits(res, c, backHref) {
  if (c && c.plan === 'paid') {
    return res.status(429).render('error', {
      title: 'Fair-use ceiling',
      message: 'That is a lot of AI in one month \u2014 you have reached the fair-use ceiling on your plan. '
             + 'It refills on the 1st. If you are genuinely working at this pace, reply to any NoBossly email and we will raise it.'
    });
  }
  return gate(res, 'out_of_credits', backHref);
}

module.exports = { gate, gateJson, gateCredits, FEATURES };
