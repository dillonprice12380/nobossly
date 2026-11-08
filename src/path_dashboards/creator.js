// 🎬 Content creator (docs/path-dashboards.md). The audience is the number
// before money arrives, so the north star follows the subpath: followers for
// short-form and live, subscribers for YouTube and newsletters, downloads for
// podcasts, visits for blogs.
const { registry } = require('../engines');

registry.defineMetric({ key: 'creator_followers', label: 'Followers', unit: 'count', period: 'month',
  help: 'Across the platform you focus on. Log the number on the same day each month.' });
registry.defineMetric({ key: 'creator_subscribers', label: 'Subscribers', unit: 'count', period: 'month',
  help: 'Channel or list subscribers on the same day each month.' });
registry.defineMetric({ key: 'creator_downloads', label: 'Downloads per episode', unit: 'count', period: 'month',
  help: 'Average downloads per episode in its first 30 days — the number sponsors ask for.' });
registry.defineMetric({ key: 'creator_visits', label: 'Monthly visits', unit: 'count', period: 'month',
  help: 'Visits to the blog in the month, from your analytics.' });
registry.defineMetric({ key: 'creator_income', label: 'Creator income', unit: 'money', period: 'month', fromIncome: 'all',
  help: 'Everything the audience earned you this month: sponsors, affiliate, products, memberships, ads.' });
registry.defineMetric({ key: 'creator_published', label: 'Pieces published', unit: 'count', period: 'week',
  help: 'What actually went out this week. Consistency is the honest number before money arrives.' });
registry.defineMetric({ key: 'creator_open_rate', label: 'Open rate', unit: 'percent', period: 'month',
  help: 'Average open rate of the issues you sent this month.' });
registry.defineMetric({ key: 'creator_live_hours', label: 'Hours streamed', unit: 'count', period: 'week' });

registry.defineBoard({
  key: 'creator_content', label: 'Content pipeline', emoji: '🎬', itemLabel: 'piece',
  help: 'Every idea starts in the first column — that is your idea bank. Move it along as it gets made, and give it a publish date to see it on the calendar.',
  stages: [
    { key: 'idea', label: 'Idea' },
    { key: 'scripted', label: 'Scripted' },
    { key: 'recorded', label: 'Recorded' },
    { key: 'edited', label: 'Edited' },
    { key: 'published', label: 'Published', done: true }
  ],
  dueLabel: 'Publish date',
  fields: [
    { key: 'format', label: 'Format', type: 'select', options: ['Short video', 'Long video', 'Post', 'Carousel', 'Episode', 'Issue', 'Article', 'Stream'] },
    { key: 'hook', label: 'Hook', type: 'longtext', placeholder: 'The first line or three seconds' },
    { key: 'link', label: 'Link once live', type: 'url' }
  ]
});

registry.defineBoard({
  key: 'creator_deals', label: 'Brand deals', emoji: '🤝', itemLabel: 'deal',
  help: 'Every brand you pitch or that pitches you, through to paid. The value is what they pay you.',
  stages: [
    { key: 'pitched', label: 'Pitched' },
    { key: 'negotiating', label: 'Negotiating' },
    { key: 'contracted', label: 'Contracted' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'paid', label: 'Paid', done: true }
  ],
  valueLabel: 'Fee', valueKind: 'money', dueLabel: 'Deliver by',
  fields: [
    { key: 'deliverables', label: 'Deliverables', type: 'longtext', placeholder: 'e.g. 1 integrated video, 2 stories, link in bio for 30 days' },
    { key: 'usage', label: 'Usage rights', type: 'text', placeholder: 'e.g. organic only, 90 days' }
  ]
});

registry.defineChecklist({
  key: 'creator_setup', label: 'Channel setup',
  help: 'The basics that make a new visitor follow instead of scroll past.',
  items: [
    { key: 'one_platform', label: 'Pick one main platform for the next 90 days' },
    { key: 'handle', label: 'Same handle on every platform you might use', help: 'Claim it now even where you will not post yet.' },
    { key: 'bio', label: 'Bio that says who it is for and what they get' },
    { key: 'link_page', label: 'One link page (your Proof Page works)', link: '/tools/proof' },
    { key: 'cadence', label: 'Write down your posting cadence and stick to it for four weeks' },
    { key: 'batch', label: 'Batch-make a week of content in one sitting' },
    { key: 'business_email', label: 'A separate email address for brand enquiries' }
  ]
});

registry.defineChecklist({
  key: 'creator_money', label: 'Getting paid',
  help: 'Monetisation thresholds change often — check each platform\'s current rules before you plan around them.',
  items: [
    { key: 'yt_partner', label: 'Check YouTube Partner Program requirements', link: 'https://support.google.com/youtube/answer/72851' },
    { key: 'tiktok_rewards', label: 'Check the current monetisation rules on your other platforms', help: 'Usually under Creator tools or Monetisation in the app.' },
    { key: 'affiliate', label: 'Join one affiliate programme for something you already use' },
    { key: 'own_product', label: 'Decide what your own product could be (guide, template, course, membership)' },
    { key: 'payouts', label: 'Set up payouts to a separate bank account' },
    { key: 'tax_aside', label: 'Put tax aside from every payment', link: '/tools/tax' }
  ]
});

registry.defineChecklist({
  key: 'creator_sponsors', label: 'First sponsor',
  items: [
    { key: 'media_kit', label: 'Make a media kit: audience numbers, who they are, past work, rates', link: '/tools/proof' },
    { key: 'rate', label: 'Set a starting rate you would say yes to without wincing', link: '/tools/pricing' },
    { key: 'list_brands', label: 'List 25 brands your audience already buys from' },
    { key: 'pitch', label: 'Write a short pitch: why your audience, one idea, your rate' },
    { key: 'track', label: 'Track every pitch on the brand deals board', link: '/workspace/boards/creator_deals' },
    { key: 'contract', label: 'Get deliverables, usage rights and payment date in writing' }
  ]
});

registry.defineChecklist({
  key: 'creator_disclosure', label: 'Disclosure rules',
  help: 'Paid or gifted posts have to say so, clearly, where people will see it.',
  items: [
    { key: 'read_ftc', label: 'Read the FTC guide for influencers (US)', link: 'https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers' },
    { key: 'read_asa', label: 'UK: read the ASA influencer guide', link: 'https://www.asa.org.uk/resource/influencers-guide.html' },
    { key: 'label', label: 'Use the platform\'s paid-partnership label on sponsored posts' },
    { key: 'say_it', label: 'Say it in the video or first line too, not only in hashtags' },
    { key: 'affiliate_note', label: 'Add an affiliate disclosure wherever you share affiliate links' }
  ]
});

const AUDIENCE = {
  social: 'creator_followers', streaming: 'creator_followers',
  youtube: 'creator_subscribers', newsletter: 'creator_subscribers',
  podcast: 'creator_downloads', blog: 'creator_visits'
};

module.exports = {
  slug: 'creator',
  intro: 'Make things people come back for, then turn that attention into income.',
  stages: [
    { answer: 'Not started — no audience yet' },
    { answer: 'Posting occasionally' },
    { answer: 'Posting consistently, no income' },
    { answer: 'Earning something' },
    { answer: 'This is my main income' }
  ],
  northStar: ({ subpath }) => AUDIENCE[subpath] || 'creator_followers',
  supporting: ({ subpath }) => ['creator_income', 'creator_published']
    .concat(subpath === 'newsletter' ? ['creator_open_rate'] : [])
    .concat(subpath === 'streaming' ? ['creator_live_hours'] : []),
  boards: () => ['creator_content', 'creator_deals'],
  checklists: () => ['creator_setup', 'creator_money', 'creator_sponsors', 'creator_disclosure']
};
