// What each path is told about (2026-11-03). Each topic is one Google News
// search (no key needed; the same feed Route by Design uses for travel news).
//
//   key       stable id, stored with each headline
//   label     shown to members ("Instagram")
//   q         the Google News search
//   must      a headline must match this (case-insensitive) or it is dropped,
//             because searches also return loosely related stories
//   subpaths  optional: only for members on these subpaths (members who have
//             not picked a subpath see every topic of their path)
//
// path 'all' is shown to every member, whatever their path.
export const TOPICS = {
  all: [
    { key: 'all_tax', label: 'Self-employment tax', q: '(IRS OR "estimated taxes" OR "1099-K" OR "self-employment tax") (freelancers OR "small business" OR "side hustle" OR self-employed OR gig)', must: 'irs|tax|1099' },
    { key: 'all_sba', label: 'Small business policy', q: '("Small Business Administration" OR SBA) (loans OR rule OR program OR grants)', must: 'sba|small business' }
  ],
  creator: [
    { key: 'creator_instagram', label: 'Instagram', q: 'Instagram (creators OR algorithm OR Reels OR "long-form" OR monetization OR feature OR update)', must: 'instagram', subpaths: ['social', 'other'] },
    { key: 'creator_tiktok', label: 'TikTok', q: 'TikTok (creators OR "creator fund" OR "creator rewards" OR "TikTok Shop" OR ban OR algorithm)', must: 'tiktok', subpaths: ['social', 'streaming', 'other'] },
    { key: 'creator_youtube', label: 'YouTube', q: 'YouTube (creators OR "Partner Program" OR monetization OR Shorts OR policy OR algorithm)', must: 'youtube', subpaths: ['youtube', 'streaming', 'podcast', 'other'] },
    { key: 'creator_podcast', label: 'Podcasting', q: '(Spotify OR "Apple Podcasts" OR YouTube) podcasters (monetization OR video OR policy OR payouts)', must: 'podcast', subpaths: ['podcast'] },
    { key: 'creator_newsletter', label: 'Newsletters', q: '(Substack OR beehiiv OR Kit OR ConvertKit OR Ghost) (newsletter OR writers OR creators)', must: 'substack|beehiiv|newsletter|convertkit|ghost', subpaths: ['newsletter', 'blog'] },
    { key: 'creator_twitch', label: 'Streaming', q: '(Twitch OR Kick OR "YouTube Live") (streamers OR creators OR policy OR payouts)', must: 'twitch|kick|stream', subpaths: ['streaming'] },
    { key: 'creator_economy', label: 'Creator economy', q: '"creator economy" OR "brand deals" OR "influencer marketing" OR "FTC" influencers', must: 'creator|influencer|brand deal' }
  ],
  freelancer: [
    { key: 'fl_platforms', label: 'Freelance platforms', q: '(Upwork OR Fiverr OR "Contra" OR Toptal) (fees OR freelancers OR policy OR changes)', must: 'upwork|fiverr|contra|toptal' },
    { key: 'fl_contractors', label: 'Contractor rules', q: '("independent contractor" OR "worker classification" OR "gig workers") (rule OR law OR Labor Department)', must: 'contractor|classification|gig' },
    { key: 'fl_freelance', label: 'Freelance work', q: 'freelancers (rates OR demand OR AI OR market OR survey)', must: 'freelanc' },
    { key: 'fl_ai_design', label: 'AI and creative work', q: '(Adobe OR Canva OR Figma) (AI OR pricing OR feature) designers', must: 'adobe|canva|figma', subpaths: ['design', 'video', 'marketing'] }
  ],
  consultant: [
    { key: 'con_linkedin', label: 'LinkedIn', q: 'LinkedIn (algorithm OR creators OR feature OR "Premium" OR changes)', must: 'linkedin' },
    { key: 'con_coaching', label: 'Coaching and consulting', q: '(coaching OR consultants OR "consulting industry") (demand OR market OR AI OR regulation)', must: 'coach|consult' },
    { key: 'con_contractors', label: 'Contractor rules', q: '("independent contractor" OR "worker classification") (rule OR law OR Labor Department)', must: 'contractor|classification' }
  ],
  local_service: [
    { key: 'loc_google', label: 'Google Business Profile', q: '"Google Business Profile" OR "Google Maps" (reviews OR local businesses OR update)', must: 'google' },
    { key: 'loc_leads', label: 'Lead platforms', q: '(Angi OR Thumbtack OR Nextdoor OR Yelp OR Taskrabbit) (fees OR pros OR businesses OR changes)', must: 'angi|thumbtack|nextdoor|yelp|taskrabbit' },
    { key: 'loc_licensing', label: 'Licensing and rules', q: '(contractor license OR "occupational licensing" OR "minimum wage") small business', must: 'licens|minimum wage' },
    { key: 'loc_trades', label: 'The trades', q: '(plumbers OR electricians OR HVAC OR landscapers OR "cleaning business") (shortage OR prices OR demand)', must: 'plumb|electric|hvac|landscap|clean', subpaths: ['trades', 'cleaning', 'garden'] }
  ],
  brick_mortar: [
    { key: 'bm_restaurants', label: 'Restaurants and cafés', q: '(restaurants OR cafes) ("small business" OR independent) (costs OR prices OR rules OR "minimum wage" OR tips)', must: 'restaurant|caf', subpaths: ['food', 'bar'] },
    { key: 'bm_retail', label: 'Independent retail', q: '("independent retailers" OR "small retailers" OR "main street") (sales OR tariffs OR costs)', must: 'retail|main street|store' },
    { key: 'bm_rent', label: 'Commercial rent', q: '"commercial rent" OR "commercial real estate" small business', must: 'commercial|rent|lease' },
    { key: 'bm_wages', label: 'Wages and staffing', q: '("minimum wage" OR "tip credit" OR "overtime rule") increase 2026 OR 2027', must: 'wage|tip|overtime' }
  ],
  online_store: [
    { key: 'shop_shopify', label: 'Shopify', q: 'Shopify (merchants OR fees OR feature OR update OR AI)', must: 'shopify' },
    { key: 'shop_etsy', label: 'Etsy', q: 'Etsy (sellers OR fees OR policy OR changes)', must: 'etsy', subpaths: ['handmade', 'print', 'digital', 'other'] },
    { key: 'shop_amazon', label: 'Amazon sellers', q: '"Amazon sellers" OR "Amazon FBA" (fees OR policy OR changes)', must: 'amazon' },
    { key: 'shop_tariffs', label: 'Tariffs and shipping', q: '(tariffs OR "de minimis" OR USPS OR UPS) (small businesses OR online sellers OR shipping rates)', must: 'tariff|de minimis|usps|ups|shipping' },
    { key: 'shop_tiktokshop', label: 'TikTok Shop', q: '"TikTok Shop" sellers', must: 'tiktok shop' }
  ],
  physical_product: [
    { key: 'prod_tariffs', label: 'Tariffs and sourcing', q: '(tariffs OR "supply chain" OR manufacturing) (small businesses OR importers OR "product makers")', must: 'tariff|supply chain|manufactur|import' },
    { key: 'prod_amazon', label: 'Amazon sellers', q: '"Amazon sellers" OR "Amazon FBA" (fees OR policy OR changes)', must: 'amazon' },
    { key: 'prod_crowdfunding', label: 'Crowdfunding', q: '(Kickstarter OR Indiegogo OR crowdfunding) (creators OR campaign OR changes)', must: 'kickstarter|indiegogo|crowdfund' },
    { key: 'prod_safety', label: 'Product safety rules', q: '("Consumer Product Safety Commission" OR CPSC OR FDA) (rule OR recall OR small businesses)', must: 'cpsc|consumer product safety|fda' }
  ],
  software: [
    { key: 'sw_appstores', label: 'App stores', q: '("App Store" OR "Google Play") (developers OR fees OR policy OR rules)', must: 'app store|google play|apple|google' },
    { key: 'sw_ai', label: 'AI platforms', q: '(OpenAI OR Anthropic OR "Google Gemini") (developers OR API OR pricing OR launch)', must: 'openai|anthropic|gemini|ai' , subpaths: ['ai', 'saas', 'consumer', 'other'] },
    { key: 'sw_payments', label: 'Payments', q: '(Stripe OR Paddle OR "Lemon Squeezy") (fees OR developers OR startups OR launch)', must: 'stripe|paddle|lemon squeezy' },
    { key: 'sw_browsers', label: 'Browser extensions', q: '("Chrome Web Store" OR "browser extension") (policy OR developers OR Manifest)', must: 'chrome|extension', subpaths: ['extension'] },
    { key: 'sw_indie', label: 'Indie software', q: '("indie hackers" OR bootstrapped OR "solo founders") SaaS', must: 'indie|bootstrap|solo|saas' }
  ],
  exploring: [
    { key: 'ex_sidehustle', label: 'Side businesses', q: '("side hustle" OR "side business" OR "small business ideas") (trend OR survey OR income)', must: 'side|small business' },
    { key: 'ex_selfemployed', label: 'Working for yourself', q: '(self-employed OR "solo entrepreneurs" OR solopreneurs) (survey OR trend OR rise)', must: 'self-employ|solo|entrepreneur' }
  ]
};

export const PATHS = Object.keys(TOPICS).filter((p) => p !== 'all');
