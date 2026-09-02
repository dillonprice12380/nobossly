// Every paid gate used to be a bare `res.redirect('/pricing?upgrade=1')`. The
// founder lost their place and got a price list instead of an answer to the
// question they actually asked, which was "what is behind this button?".
//
// gate() renders that answer in place: what the feature does, what it would
// have done for them just now, and a way back to where they were.

const FEATURES = {
  ai_challenges: {
    title: 'AI-tailored challenges',
    blurb: 'Reads your active blueprint and writes a set of challenges built around your actual business — your customers, your channel, your bottleneck — instead of the shared quest board.',
    gets: ['A fresh set of up to 10 challenges tailored to your blueprint',
           'Regenerate whenever your blueprint changes',
           'Everything on the shared quest board stays free either way'],
    back: { href: '/challenges', label: 'Back to challenges' }
  },
  ai_milestones: {
    title: 'AI-tailored goals',
    blurb: 'Turns your blueprint into a personal goal ladder you tick off yourself — separate from the trophies, which you keep earning free by playing.',
    gets: ['Up to 10 personal goals written from your blueprint',
           'Regenerate as the business moves',
           'Your trophy case stays free and keeps unlocking'],
    back: { href: '/milestones', label: 'Back to milestones' }
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
    back: { href: '/ideas', label: 'Back to my ideas' }
  },
  demand_evidence: {
    title: 'Live demand evidence',
    blurb: 'Searches the live web for real signals that people want what your idea sells — the posts, the complaints, the money already changing hands.',
    gets: ['Real demand signals gathered for any idea', 'Refresh as the market moves', 'Runs automatically on your top idea'],
    back: { href: '/ideas', label: 'Back to my ideas' }
  },
  disperse_tasks: {
    title: 'Blueprint → task board',
    blurb: 'Breaks your blueprint\'s Week-1 actions into dated tasks on your board so the first week plans itself.',
    gets: ['Week-1 actions dispersed with staggered deadlines', 'The same for every new blueprint', 'Manual task entry stays free'],
    back: { href: '/ideas', label: 'Back to my ideas' }
  },
  groups: {
    title: 'Starting a group',
    blurb: 'Anyone can join and post in groups. Creating and running one is a paid feature.',
    gets: ['Start your own group', 'Moderate members and posts', 'Joining and posting stays free'],
    back: { href: '/groups', label: 'Back to groups' }
  },
  collaborations: {
    title: 'Collaboration projects',
    blurb: 'Post a project, recruit other founders on the platform, and run it with a shared board.',
    gets: ['Post collaboration projects', 'Review and accept collaborators', 'Browsing collaborations stays free'],
    back: { href: '/collaborations', label: 'Back to collaborations' }
  }
};

// Renders the in-place explanation. `key` picks the copy; anything unknown falls
// back to a generic panel rather than throwing on a page the founder is reading.
function gate(res, key, backHref) {
  const f = FEATURES[key] || {
    title: 'A paid feature',
    blurb: 'This one is part of the Founder plan.',
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
    error: (f.title ? f.title + ' is part of the Founder plan. ' : '') + (f.blurb || ''),
    redirect: '/pricing?upgrade=1'
  });
}

module.exports = { gate, gateJson, FEATURES };
