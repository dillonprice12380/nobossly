// What each path is told about (2026-11-03), and where it comes from.
//
// Google News blocks requests from Supabase's servers, so the job reads
// publishers' own RSS feeds instead (FEEDS; each one checked from Supabase).
// Every feed is read once per run; a headline goes to a topic when it comes
// from one of the topic's feeds and its title matches the topic's `must`.
//
//   key       stable id, stored with each headline
//   label     shown to members ("Instagram")
//   feeds     FEEDS keys whose headlines must match `must`
//   anyFrom   FEEDS keys whose headlines all belong (single-subject feeds)
//   must      case-insensitive pattern a headline title must match
//   subpaths  optional: only for members on these subpaths (members who have
//             not picked a subpath see every topic of their path)
//
// path 'all' is shown to every member, whatever their path.
export const FEEDS = {
  smt:          { name: 'Social Media Today', url: 'https://www.socialmediatoday.com/feeds/news/' },
  smexaminer:   { name: 'Social Media Examiner', url: 'https://www.socialmediaexaminer.com/feed/' },
  tc_social:    { name: 'TechCrunch', url: 'https://techcrunch.com/category/social/feed/' },
  tc_apps:      { name: 'TechCrunch', url: 'https://techcrunch.com/category/apps/feed/' },
  verge:        { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  engadget:     { name: 'Engadget', url: 'https://www.engadget.com/rss.xml' },
  youtube_blog: { name: 'YouTube Official Blog', url: 'https://blog.youtube/rss/' },
  meta_news:    { name: 'Meta Newsroom', url: 'https://about.fb.com/feed/' },
  tubefilter:   { name: 'Tubefilter', url: 'https://www.tubefilter.com/feed/' },
  podnews:      { name: 'Podnews', url: 'https://podnews.net/rss' },
  niemanlab:    { name: 'Nieman Lab', url: 'https://www.niemanlab.org/feed/' },
  marketingdive:{ name: 'Marketing Dive', url: 'https://www.marketingdive.com/feeds/news/' },
  retaildive:   { name: 'Retail Dive', url: 'https://www.retaildive.com/feeds/news/' },
  restaurantdive:{ name: 'Restaurant Dive', url: 'https://www.restaurantdive.com/feeds/news/' },
  nrn:          { name: "Nation's Restaurant News", url: 'https://www.nrn.com/rss.xml' },
  supplychaindive:{ name: 'Supply Chain Dive', url: 'https://www.supplychaindive.com/feeds/news/' },
  hrdive:       { name: 'HR Dive', url: 'https://www.hrdive.com/feeds/news/' },
  paymentsdive: { name: 'Payments Dive', url: 'https://www.paymentsdive.com/feeds/news/' },
  modernretail: { name: 'Modern Retail', url: 'https://www.modernretail.co/feed/' },
  dc360:        { name: 'Digital Commerce 360', url: 'https://www.digitalcommerce360.com/feed/' },
  smallbiztrends:{ name: 'Small Business Trends', url: 'https://smallbiztrends.com/feed' },
  cnbc_smallbiz:{ name: 'CNBC', url: 'https://www.cnbc.com/id/44877279/device/rss/rss.html' },
  entrepreneur: { name: 'Entrepreneur', url: 'https://feeds.feedburner.com/entrepreneur/latest' },
  inc:          { name: 'Inc.', url: 'https://www.inc.com/rss' },
  fastcompany:  { name: 'Fast Company', url: 'https://www.fastcompany.com/latest/rss' },
  accountingtoday:{ name: 'Accounting Today', url: 'https://www.accountingtoday.com/feed?rss=true' },
  cpa:          { name: 'CPA Practice Advisor', url: 'https://www.cpapracticeadvisor.com/feed/' },
  ninetofivemac:{ name: '9to5Mac', url: 'https://9to5mac.com/feed/' },
  apple_dev:    { name: 'Apple Developer', url: 'https://developer.apple.com/news/rss/news.rss' },
  android_dev:  { name: 'Android Developers Blog', url: 'https://android-developers.googleblog.com/feeds/posts/default' }
};

const SOCIAL = ['smt', 'smexaminer', 'tc_social', 'verge', 'engadget'];
const BIZ = ['smallbiztrends', 'cnbc_smallbiz', 'entrepreneur', 'inc', 'fastcompany'];
const SHOP = ['modernretail', 'dc360', 'retaildive', 'smallbiztrends', 'paymentsdive'];
const CONTRACTORS = { label: 'Contractor rules', feeds: ['hrdive', 'cpa', 'accountingtoday', 'smallbiztrends'], must: 'independent contractor|worker classification|misclassif|gig worker|1099 worker|freelance worker' };

export const TOPICS = {
  all: [
    { key: 'all_tax', label: 'Self-employment tax', feeds: ['cpa', 'accountingtoday', 'smallbiztrends', 'cnbc_smallbiz'], must: '\\birs\\b|estimated tax|1099|self-employ|tax deadline|tax filing|tax season|deduction' },
    { key: 'all_sba', label: 'Small business policy', feeds: ['smallbiztrends', 'cnbc_smallbiz', 'inc', 'entrepreneur'], must: '\\bsba\\b|small business administration|small business (loan|grant|tax|rule|owners)' }
  ],
  creator: [
    { key: 'creator_instagram', label: 'Instagram', feeds: SOCIAL.concat(['meta_news']), must: 'instagram|\\bthreads\\b|\\breels\\b', subpaths: ['social', 'other'] },
    { key: 'creator_tiktok', label: 'TikTok', feeds: SOCIAL.concat(['tubefilter']), must: 'tiktok', subpaths: ['social', 'streaming', 'other'] },
    { key: 'creator_youtube', label: 'YouTube', feeds: SOCIAL.concat(['tubefilter']), anyFrom: ['youtube_blog'], must: 'youtube', subpaths: ['youtube', 'streaming', 'podcast', 'other'] },
    { key: 'creator_podcast', label: 'Podcasting', feeds: SOCIAL.concat(['tubefilter']), anyFrom: ['podnews'], must: 'podcast', subpaths: ['podcast'] },
    { key: 'creator_newsletter', label: 'Newsletters', feeds: ['niemanlab', 'smt', 'tc_social', 'verge', 'marketingdive'], must: 'substack|beehiiv|newsletter|convertkit|\\bghost\\b|patreon', subpaths: ['newsletter', 'blog'] },
    { key: 'creator_twitch', label: 'Streaming', feeds: ['tubefilter', 'verge', 'engadget', 'tc_social'], must: 'twitch|\\bkick\\b|livestream|streamer', subpaths: ['streaming'] },
    { key: 'creator_economy', label: 'Creator economy', feeds: ['tubefilter', 'marketingdive', 'smt', 'smexaminer'], must: 'creator|influencer|brand deal|sponsorship|\\bftc\\b' }
  ],
  freelancer: [
    { key: 'fl_platforms', label: 'Freelance platforms', feeds: BIZ.concat(['tc_apps', 'verge']), must: 'upwork|fiverr|toptal|freelancer\\.com' },
    Object.assign({ key: 'fl_contractors' }, CONTRACTORS),
    { key: 'fl_freelance', label: 'Freelance work', feeds: BIZ.concat(['hrdive']), must: 'freelanc' },
    { key: 'fl_ai_design', label: 'AI and creative tools', feeds: ['verge', 'tc_apps', 'engadget', 'fastcompany'], must: 'adobe|canva|figma|photoshop|premiere', subpaths: ['design', 'video', 'marketing'] }
  ],
  consultant: [
    { key: 'con_linkedin', label: 'LinkedIn', feeds: SOCIAL.concat(['marketingdive']), must: 'linkedin' },
    { key: 'con_coaching', label: 'Coaching and consulting', feeds: BIZ.concat(['hrdive']), must: 'coach|consult' },
    Object.assign({ key: 'con_contractors' }, CONTRACTORS)
  ],
  local_service: [
    { key: 'loc_google', label: 'Google search and reviews', feeds: SOCIAL.concat(['smallbiztrends']), must: 'google (maps|business|reviews|local)|local search|online reviews' },
    { key: 'loc_leads', label: 'Lead platforms', feeds: BIZ.concat(['tc_apps', 'verge']), must: '\\bangi\\b|thumbtack|nextdoor|\\byelp\\b|taskrabbit' },
    { key: 'loc_rules', label: 'Licensing and wages', feeds: ['hrdive', 'smallbiztrends', 'cnbc_smallbiz'], must: 'licens|minimum wage|overtime' },
    { key: 'loc_trades', label: 'The trades', feeds: BIZ, must: 'plumb|electrician|\\bhvac\\b|landscap|cleaning business|contractors?\\b|home services', subpaths: ['trades', 'cleaning', 'garden'] }
  ],
  brick_mortar: [
    { key: 'bm_restaurants', label: 'Restaurants and cafés', anyFrom: ['restaurantdive', 'nrn'], subpaths: ['food', 'bar'] },
    { key: 'bm_retail', label: 'Independent retail', anyFrom: ['modernretail'], feeds: ['retaildive', 'smallbiztrends'], must: 'small business|independent|store|retailer', subpaths: ['retail', 'salon', 'fitness', 'other'] },
    { key: 'bm_rent', label: 'Commercial rent', feeds: ['retaildive', 'restaurantdive', 'smallbiztrends', 'cnbc_smallbiz'], must: '\\brent\\b|lease|commercial real estate|landlord' },
    { key: 'bm_wages', label: 'Wages and staffing', feeds: ['hrdive', 'restaurantdive', 'nrn', 'retaildive'], must: 'wage|\\btips?\\b|overtime|staffing|labor shortage' }
  ],
  online_store: [
    { key: 'shop_shopify', label: 'Shopify', feeds: SHOP.concat(['tc_apps', 'verge']), must: 'shopify' },
    { key: 'shop_etsy', label: 'Etsy', feeds: SHOP.concat(['tc_apps', 'verge']), must: 'etsy', subpaths: ['handmade', 'print', 'digital', 'other'] },
    { key: 'shop_amazon', label: 'Amazon sellers', feeds: SHOP, must: 'amazon' },
    { key: 'shop_tariffs', label: 'Tariffs and shipping', feeds: SHOP.concat(['supplychaindive']), must: 'tariff|de minimis|\\busps\\b|\\bups\\b|fedex|shipping|postal' },
    { key: 'shop_tiktokshop', label: 'TikTok Shop', feeds: SHOP.concat(['smt', 'tc_social']), must: 'tiktok shop' }
  ],
  physical_product: [
    { key: 'prod_tariffs', label: 'Tariffs and sourcing', feeds: ['supplychaindive', 'modernretail', 'cnbc_smallbiz', 'smallbiztrends'], must: 'tariff|supply chain|manufactur|import|sourcing' },
    { key: 'prod_amazon', label: 'Amazon sellers', feeds: SHOP, must: 'amazon' },
    { key: 'prod_crowdfunding', label: 'Crowdfunding', feeds: ['tc_apps', 'verge', 'engadget', 'smallbiztrends'], must: 'kickstarter|indiegogo|crowdfund' },
    { key: 'prod_safety', label: 'Product safety rules', feeds: ['supplychaindive', 'retaildive', 'modernretail'], must: 'recall|\\bcpsc\\b|\\bfda\\b|product safety' }
  ],
  software: [
    { key: 'sw_appstores', label: 'App stores', feeds: ['ninetofivemac', 'tc_apps', 'verge', 'engadget'], anyFrom: ['apple_dev', 'android_dev'], must: 'app store|google play|developer' },
    { key: 'sw_ai', label: 'AI platforms', feeds: ['tc_apps', 'verge', 'engadget', 'fastcompany'], must: 'openai|anthropic|gemini|chatgpt|claude|\\bllm\\b', subpaths: ['ai', 'saas', 'consumer', 'other'] },
    { key: 'sw_payments', label: 'Payments', feeds: ['paymentsdive', 'tc_apps', 'verge'], must: 'stripe|paddle|lemon squeezy|paypal|square' },
    { key: 'sw_browsers', label: 'Browser extensions', feeds: ['verge', 'engadget', 'tc_apps', 'ninetofivemac'], must: 'chrome|extension|browser', subpaths: ['extension'] },
    { key: 'sw_indie', label: 'Indie software', feeds: ['tc_apps', 'inc', 'fastcompany', 'entrepreneur'], must: 'indie|bootstrap|solo founder|\\bsaas\\b' }
  ],
  exploring: [
    { key: 'ex_sidehustle', label: 'Side businesses', feeds: BIZ, must: 'side hustle|side business|side gig|start a business|small business idea' },
    { key: 'ex_selfemployed', label: 'Working for yourself', feeds: BIZ, must: 'self-employ|solopreneur|solo entrepreneur|entrepreneur|freelanc' }
  ]
};

export const PATHS = Object.keys(TOPICS).filter((p) => p !== 'all');
