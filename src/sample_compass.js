// A worked example of a Founder Compass, shown to signed-out visitors.
//
// The Compass is the best thing the product makes and it used to be invisible
// until a founder had answered the whole questionnaire — so nobody chose to
// start on the strength of it, because nobody could see it. This is one
// illustrative Compass for an invented founder, clearly labelled as an example
// wherever it renders. It is static copy, never a real member's data.

module.exports = {
  founder_path: 'exploring',
  founder: {
    name: 'Maya',
    summary: 'Dental hygienist, 12 years in practice. Ten hours a week, $800 to start, wants $2k a month on the side without leaving the job she likes.'
  },
  data: {
    archetype: {
      name: 'The Trusted Insider',
      emoji: '🛡️',
      tagline: 'You already have the credibility other founders spend three years trying to buy.',
      description: 'You win by selling into a room you are already standing in — people who know your work, in an industry whose language you speak natively. Your typical failure is the opposite one: you underprice your access because it feels ordinary to you, and you wait for permission that is never coming.'
    },
    loadout: {
      strengths: ['Clinical expertise', 'Patient communication', 'Practice workflow', 'Teaching one-to-one', 'Meticulous follow-through'],
      advantages: ['12 years of in-industry credibility', 'A referral network of practising hygienists', 'You know exactly what practice owners complain about'],
      constraints: ['10 hours a week, evenings only', '$800 launch budget — no runway for a slow build', 'Keeping the day job is non-negotiable', 'No appetite for on-camera content'],
      honest_notes: [
        'Your $2k/month goal at 10 hours a week means roughly $50/hour of real billable time. Anything priced hourly under that number cannot get you there — plan for a productized offer, not freelancing.',
        'You listed "no video" as a deal breaker. That closes off the fastest audience-building channel in your space, so your distribution has to come from the network you already have. That is workable, but it has to be deliberate.'
      ]
    },
    territories: [
      {
        name: 'Compliance and onboarding for small dental practices',
        temperature: 'hot',
        why_you: 'Practice owners are chronically behind on documentation and training, and they trust clinicians far more than consultants. You can speak to the actual workflow rather than the paperwork abstraction.',
        example_plays: ['A fixed-fee OSHA/HIPAA onboarding pack per new hire', 'Quarterly compliance review retainer', 'A done-for-you new-hygienist ramp-up checklist'],
        watch_out: 'Regulation varies by state — pick one state and go deep before you generalize, or you will drown in edge cases.'
      },
      {
        name: 'Continuing-education content for hygienists',
        temperature: 'warm',
        why_you: 'You teach one-to-one already and you know precisely where newer hygienists get stuck. Accredited CE has real, recurring, mandated demand.',
        example_plays: ['A single accredited CE course sold per seat', 'A cohort-based exam prep group', 'Study notes sold to training programs'],
        watch_out: 'Accreditation takes months and costs money you do not yet have. Sell the unaccredited version first and use the revenue to fund accreditation.'
      },
      {
        name: 'Placement and locum matching for hygienists',
        temperature: 'steady',
        why_you: 'You hold the network on both sides — practices that need cover, and hygienists who want extra shifts. That is the entire product.',
        example_plays: ['A paid placement fee per filled shift', 'A private job board for your region', 'A vetted stand-in roster for local practices'],
        watch_out: 'Marketplaces need both sides at once and are brutal part-time. Start by manually matching ten shifts before you build anything.'
      }
    ],
    fit_test: [
      { criterion: 'Can it be delivered in evenings, asynchronously?', why: 'You have 10 hours a week and a day job with fixed daytime clinic hours.',
        check: 'boolean', metric: null, op: null, value: null },
      { criterion: 'Does it start for under $800?', why: 'That is your entire launch budget and you named no runway behind it.',
        check: 'numeric', metric: 'startup_cost', op: 'lte', value: 800 },
      { criterion: 'Is it earning inside 10 weeks?', why: 'You have no runway, so an idea that pays nothing for six months is one you will abandon.',
        check: 'numeric', metric: 'time_to_revenue', op: 'lte', value: 10 },
      { criterion: 'Can it sell without you appearing on camera?', why: 'You named video as a deal breaker, so distribution has to route around it.',
        check: 'boolean', metric: null, op: null, value: null },
      { criterion: 'Does your clinical credibility actually matter to the buyer?', why: 'It is your single largest advantage — an idea that wastes it is starting from zero.',
        check: 'judgment', metric: null, op: null, value: null }
    ],
    avoid_list: [
      { territory: 'A dental-themed e-commerce or product line', reason: 'Inventory eats your $800 immediately and your credibility does nothing for you against Amazon pricing.' },
      { territory: 'General health coaching', reason: 'It abandons the specific industry standing that is your whole edge, and puts you in the most crowded, most video-driven market there is.' },
      { territory: 'Opening your own practice', reason: 'Right goal, wrong decade — it contradicts every constraint you listed, from the budget to the day job.' }
    ],
    toolkit: [
      { name: 'Stripe Payment Links', purpose: 'Take money before you build anything', cost: 'freemium' },
      { name: 'Notion', purpose: 'Deliver the first version of a documentation product', cost: 'freemium' },
      { name: 'Google Forms', purpose: 'Run your first ten validation conversations', cost: 'free' },
      { name: 'Calendly', purpose: 'Book evening calls around clinic hours', cost: 'freemium' },
      { name: 'Loom', purpose: 'Async training delivery without going on camera live', cost: 'freemium' }
    ]
  }
};
