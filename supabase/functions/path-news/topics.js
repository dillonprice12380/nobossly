// What each path is told about (tuned 2026-11-04), and where it comes from.
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
//   not       optional pattern that rules a headline out, even from anyFrom
//             feeds (big chains' earnings, betas, sports coaches...)
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
  android_dev:  { name: 'Android Developers Blog', url: 'https://android-developers.googleblog.com/feeds/posts/default' },
  practicalecom:{ name: 'Practical Ecommerce', url: 'https://www.practicalecommerce.com/feed' },
  seroundtable: { name: 'Search Engine Roundtable', url: 'https://www.seroundtable.com/index.xml' },
  sej:          { name: 'Search Engine Journal', url: 'https://www.searchenginejournal.com/feed/' },
  ninetofivegoogle:{ name: '9to5Google', url: 'https://9to5google.com/feed/' }
};

const SOCIAL = ['smt', 'smexaminer', 'tc_social', 'verge', 'engadget'];
const BIZ = ['smallbiztrends', 'cnbc_smallbiz', 'entrepreneur', 'inc', 'fastcompany'];
const SHOP = ['modernretail', 'dc360', 'retaildive', 'smallbiztrends', 'paymentsdive', 'practicalecom'];
const SEARCH = ['seroundtable', 'sej'];
const CONTRACTORS = { label: 'Contractor rules', feeds: ['hrdive', 'cpa', 'accountingtoday', 'smallbiztrends'], must: 'independent contractor|worker classification|misclassif|gig worker|1099 worker|freelance worker' };

// Amazon news for sellers, not Amazon the shop, Prime Video or Alexa.
const AMAZON = {
  label: 'Amazon sellers', feeds: SHOP,
  must: 'amazon (seller|sellers|fba|marketplace|fees?|storefront|ads|advertising|prime day|returns?|fulfil+ment|haul|business|brand registry|logistics|shipping)|fulfil+ment by amazon|\\bfba\\b|third-party sellers|seller (fees|central)',
  not: 'prime video|kindle|alexa|\\baws\\b|doordash|instacart|earnings|jassy'
};

// Chains, deals and earnings: the news a corner café or shop can't use.
const CHAINS = "mcdonald|red robin|tgi friday|applebee|\\bihop\\b|dine brands|outback|popeyes|taco bell|\\bkfc\\b|\\byum\\b|cheesecake factory|raising cane|chipotle|burger king|wendy|wingstop|starbucks|jersey mike|chili'?s|brinker|little caesars|\\bsonic\\b|church'?s|bojangles|domino|pizza hut|subway|dunkin|panera|shake shack|sweetgreen|\\bcava\\b|darden|olive garden|denny|cracker barrel|jack in the box|arby|dutch bros|7 brew|piada|shrimp basket|\\bmty\\b|foodtastic|walmart|target|costco|kroger|old navy|gap inc|j\\.?c\\.? ?penney|bed bath|at home|boot barn|carter'?s";
const CORPORATE = 'same-store sales|\\bcomps\\b|franchisee|earnings|quarter|\\bq[1-4]\\b|stock|shareholder|\\bceo\\b|\\bcmo\\b|\\bcfo\\b|chief (product|executive|financial|marketing)|takeover|bid to acquire|poison pill|board members|bankrupt';

export const TOPICS = {
  all: [
    { key: 'all_tax', label: 'Self-employment tax', feeds: ['cpa', 'accountingtoday', 'smallbiztrends', 'cnbc_smallbiz', 'entrepreneur', 'inc'],
      must: 'estimated tax|1099|self-employ|tax (deadline|filing|season|break|credit|write-?off|deduction|tip)s?|write-?off|deduct|small[- ]business tax|tax (cut|law|bill|rule|change)s? for (small|business|owner|founder|freelanc)|no tax on tips|irs (letter|notice|penalt|deadline|rule|guidance)',
      not: 'tax gap|democrats|republicans|senator|wealth tax|billionaire|pcaob|auditor|fraud blotter|property tax|private credit|\\bdoj\\b' },
    { key: 'all_sba', label: 'Small business policy', feeds: ['smallbiztrends', 'cnbc_smallbiz', 'inc', 'entrepreneur', 'accountingtoday'],
      must: '\\bsba\\b|small business administration|small[- ]business(es)? (loan|grant|tax|rule|owner|lending|relief|credit|employee|hiring|insurance)|main street|health (insurance )?premiums',
      not: 'senator|democrats|republicans' }
  ],
  creator: [
    { key: 'creator_instagram', label: 'Instagram', feeds: SOCIAL.concat(['meta_news', 'sej']), must: 'instagram|\\bthreads\\b|\\breels\\b', subpaths: ['social', 'other'] },
    { key: 'creator_tiktok', label: 'TikTok', feeds: SOCIAL.concat(['tubefilter', 'sej']), must: 'tiktok', not: 'child safety|lawsuit|documentary', subpaths: ['social', 'streaming', 'other'] },
    { key: 'creator_youtube', label: 'YouTube', feeds: SOCIAL.concat(['tubefilter', 'podnews']), anyFrom: ['youtube_blog'], must: 'youtube',
      not: 'victoria.?s secret|coachella|fashion show|acotar|emmy', subpaths: ['youtube', 'streaming', 'podcast', 'other'] },
    { key: 'creator_podcast', label: 'Podcasting', feeds: SOCIAL.concat(['tubefilter']), anyFrom: ['podnews'], must: 'podcast',
      not: 'festival|\\bfest\\b|awards?\\b|longlist|speakers|keynotes?|full schedule|celebrates|in lego|diplomatic', subpaths: ['podcast'] },
    { key: 'creator_newsletter', label: 'Newsletters', feeds: ['niemanlab', 'smt', 'tc_social', 'verge', 'marketingdive', 'podnews'], must: 'substack|beehiiv|newsletter|convertkit|kit\\.com|\\bghost\\b|patreon|paid (subscribers|memberships)', subpaths: ['newsletter', 'blog'] },
    { key: 'creator_twitch', label: 'Streaming', feeds: ['tubefilter', 'verge', 'engadget', 'tc_social'], must: 'twitch|\\bkick\\b|livestream|streamer', subpaths: ['streaming'] },
    { key: 'creator_economy', label: 'Creator economy', anyFrom: ['tubefilter'], feeds: ['marketingdive', 'smt', 'smexaminer', 'niemanlab', 'meta_news'],
      must: 'creators?\\b|influencer|brand deals?|sponsorship|\\bftc\\b',
      not: 'have you heard\\?|kids pay attention|in theaters|in court' }
  ],
  freelancer: [
    { key: 'fl_platforms', label: 'Freelance platforms', feeds: BIZ.concat(['tc_apps', 'verge', 'hrdive']), must: 'upwork|fiverr|toptal|freelancer\\.com|contra\\b|freelance (platform|marketplace)|gig (platform|app)s?' },
    Object.assign({ key: 'fl_contractors' }, CONTRACTORS),
    { key: 'fl_freelance', label: 'Freelance work', feeds: BIZ.concat(['hrdive', 'accountingtoday', 'cpa']),
      must: 'freelanc|solopreneur|independent (work|professional)s?|gig (economy|work)|fractional|(raise|set) your rates|clients? (pay|trust)|what clients|late payments?|invoic' },
    { key: 'fl_ai_design', label: 'AI and creative tools', feeds: ['verge', 'tc_apps', 'engadget', 'fastcompany', 'inc', 'smallbiztrends', 'ninetofivemac', 'smexaminer'],
      must: 'adobe|canva|figma|photoshop|lightroom|premiere (pro|rush|mobile)|affinity|capcut|davinci|final cut|midjourney|\\bsora\\b|\\bveo\\b|claude design|ai (video|image|design)',
      subpaths: ['design', 'video', 'marketing'] },
    { key: 'fl_marketing', label: 'Search and ads', feeds: SEARCH,
      must: 'google ads|\\bseo\\b|\\bgeo\\b|ai mode|ai overviews?|search console|core update|ranking|content|chatgpt|pmax|meta ads|tiktok (search )?ads',
      subpaths: ['marketing', 'writing'] }
  ],
  consultant: [
    { key: 'con_linkedin', label: 'LinkedIn', feeds: SOCIAL.concat(['marketingdive', 'sej']), must: 'linkedin' },
    { key: 'con_coaching', label: 'Coaching and consulting', feeds: BIZ.concat(['hrdive', 'cpa']),
      must: 'coach(ing|es)?\\b|consult(ant|ants|ing|ancy)\\b|advisory|selling advice|thought leader|expertise|what clients|clients? trust',
      not: '\\bnba\\b|\\bnfl\\b|\\bnhl\\b|\\bmlb\\b|basketball|football|baseball|soccer|hockey|championship|head coach|athlet|accounting firm|\\bcpa firm|acquires|audit' },
    Object.assign({ key: 'con_contractors' }, CONTRACTORS)
  ],
  local_service: [
    { key: 'loc_google', label: 'Google search and reviews', feeds: SOCIAL.concat(['smallbiztrends', 'ninetofivegoogle'], SEARCH),
      must: 'google (maps|business|reviews?|local|local services|guaranteed)|business profile|local (search|seo|pack|ads|services)|map pack|online reviews|fake reviews|reviews? (policy|spam|removal)' },
    { key: 'loc_leads', label: 'Lead platforms', feeds: BIZ.concat(['tc_apps', 'verge', 'seroundtable']), must: '\\bangi\\b|thumbtack|nextdoor|\\byelp\\b|taskrabbit|homeadvisor|porch\\b|local services ads' },
    { key: 'loc_rules', label: 'Licensing and wages', feeds: ['hrdive', 'smallbiztrends', 'cnbc_smallbiz', 'accountingtoday'],
      must: 'licens(e|ing) (rule|law|requirement|board)|occupational licens|minimum wage|overtime|\\bflsa\\b|first employee|hiring (your|their) first|paid (sick|leave)|non-?competes?',
      not: 'license agreement|software licens' },
    { key: 'loc_trades', label: 'The trades', feeds: BIZ.concat(['hrdive']),
      must: 'plumb|electrician|\\bhvac\\b|landscap|lawn|cleaning (business|service|compan)|contractors?\\b|home (services|repair|improvement)|handyman|skilled trades|tradespeople|trade schools?|blue-?collar|roofing|pest control|auto (repair|shop)|mechanic|dog (groom|walk)|pet (groom|care)|salon',
      not: 'independent contractor|defense contractor|government contractor',
      subpaths: ['trades', 'cleaning', 'garden', 'auto', 'pets', 'beauty', 'other'] }
  ],
  brick_mortar: [
    { key: 'bm_restaurants', label: 'Restaurants and cafés', anyFrom: ['restaurantdive', 'nrn'],
      not: CHAINS + '|' + CORPORATE + '|menu tracker|trending this week|new on the menu|cult-favorite|plus .* restaurant news|named .*(chef|ceo|president)',
      subpaths: ['food', 'bar'] },
    { key: 'bm_retail', label: 'Independent retail', feeds: ['retaildive', 'smallbiztrends', 'inc', 'cnbc_smallbiz', 'modernretail'],
      must: 'small business(es)?|independent (shop|store|retail|bookstore|business)|shop small|small business saturday|local (shop|store|retail|business)|main street|small retailers|holiday shop+ers|store experience|foot traffic|shoplifting|retail theft',
      not: CHAINS + '|' + CORPORATE, subpaths: ['retail', 'salon', 'fitness', 'other'] },
    { key: 'bm_rent', label: 'Commercial rent', feeds: ['retaildive', 'restaurantdive', 'smallbiztrends', 'cnbc_smallbiz', 'nrn'], must: '\\brent\\b|lease|commercial real estate|landlord|storefront vacanc|\\bmalls?\\b' },
    { key: 'bm_wages', label: 'Wages and staffing', feeds: ['hrdive', 'restaurantdive', 'nrn', 'retaildive', 'accountingtoday'],
      must: 'wage|\\btips?\\b|tip credit|overtime|staffing|labor (shortage|costs?)|hiring|scheduling|\\bflsa\\b|paid leave|health (insurance )?premiums|employee engagement',
      not: CHAINS + '|' + CORPORATE },
    { key: 'bm_costs', label: 'Costs, fees and tech', feeds: ['restaurantdive', 'nrn', 'paymentsdive', 'smallbiztrends', 'retaildive'],
      must: '\\btoast\\b|\\bsquare\\b|clover|\\bpos\\b|card fees|swipe fees|interchange|hidden fees|junk fees|delivery (fees|apps)|doordash|uber eats|grubhub|food costs|beef prices|egg prices|coffee prices|menu prices|tariff',
      not: CHAINS + '|' + CORPORATE }
  ],
  online_store: [
    { key: 'shop_shopify', label: 'Shopify', feeds: SHOP.concat(['tc_apps', 'verge', 'sej']), must: 'shopify' },
    { key: 'shop_etsy', label: 'Etsy', feeds: SHOP.concat(['tc_apps', 'verge']), must: 'etsy', subpaths: ['handmade', 'print', 'digital', 'other'] },
    Object.assign({ key: 'shop_amazon' }, AMAZON),
    { key: 'shop_tariffs', label: 'Tariffs and shipping', feeds: SHOP.concat(['supplychaindive', 'cnbc_smallbiz']),
      must: 'tariff|de minimis|duties|customs|postal rates?|stamp prices?|shipping (rates?|costs?|surcharges?|fees)|(usps|ups|fedex|dhl) (rates?|prices?|surcharges?|fees?|increases?|hikes?|can bill|will bill|changes?)|surcharges?|ground advantage',
      not: 'rfid|network 2\\.0|\\bearnings\\b|\\bceo\\b|intermodal|warehouse' },
    { key: 'shop_tiktokshop', label: 'TikTok Shop', feeds: SHOP.concat(['smt', 'tc_social', 'sej']), must: 'tiktok shop|social commerce|live shopping' },
    { key: 'shop_growth', label: 'Running your store', anyFrom: ['practicalecom'], feeds: SEARCH.concat(['modernretail']),
      must: 'ecommerce|e-commerce|online store|\\bbfcm\\b|black friday|cyber monday|ai shopping|shopping (ads|feed)|product (feed|listing|page)s?|merchant center|google shopping|checkout|cart abandon|holiday (shop+ers|sales|marketing)',
      not: CHAINS + '|' + CORPORATE }
  ],
  physical_product: [
    { key: 'prod_tariffs', label: 'Tariffs and sourcing', feeds: ['supplychaindive', 'modernretail', 'cnbc_smallbiz', 'smallbiztrends', 'practicalecom'],
      must: 'tariff|de minimis|duties|customs|import (costs?|fees|rules)|sourcing|suppliers?\\b|small manufacturers?|contract manufactur|co-?packer|freight rates?|shipping (rates?|costs?)',
      not: '\\bearnings\\b|\\bceo\\b|3m\\b|walmart|intermodal' },
    Object.assign({ key: 'prod_amazon' }, AMAZON),
    { key: 'prod_crowdfunding', label: 'Crowdfunding and launches', feeds: ['tc_apps', 'verge', 'engadget', 'smallbiztrends', 'podnews', 'inc', 'entrepreneur', 'modernretail', 'practicalecom'],
      must: 'kickstarter|indiegogo|crowdfund|pre-?orders?|product launch|launches at (target|walmart|costco|whole foods)|retail (launch|distribution)|into \\d+ (states|stores)|scaled to \\d+|new brand|private brands?|wholesale|without (any )?venture capital' },
    { key: 'prod_safety', label: 'Product safety rules', feeds: ['supplychaindive', 'retaildive', 'modernretail', 'inc', 'cnbc_smallbiz'], must: 'recall|\\bcpsc\\b|\\bfda\\b|product safety|counterfeit|labell?ing rules?|prop(osition)? 65' }
  ],
  software: [
    { key: 'sw_appstores', label: 'App stores', feeds: ['ninetofivemac', 'tc_apps', 'verge', 'engadget', 'ninetofivegoogle'], anyFrom: ['apple_dev', 'android_dev'],
      must: 'app store|google play|play store|app review|in-app purchase|age ratings?|sideload|alternative app|developer (fees|program|terms|policy|rules|account|tools)|developers can|for developers|commission',
      not: '\\bbetas?\\b|hello developer|design awards?|wwdc\\d* survey|today @ wwdc|app deals|freebies|\\brc\\b|release candidate|spyware|scotus|supreme court|\\bdeals\\b' },
    { key: 'sw_ai', label: 'AI platforms', feeds: ['tc_apps', 'verge', 'engadget', 'fastcompany', 'ninetofivemac', 'ninetofivegoogle'],
      must: 'openai|anthropic|gemini|chatgpt|claude|\\bllm\\b|ai agents?|\\bapi\\b|copilot|app skills|siri ai',
      not: 'bubble|billionaire|heist|lawsuit|stock|election|earnings|profit|margins',
      subpaths: ['ai', 'saas', 'consumer', 'other'] },
    { key: 'sw_payments', label: 'Payments', feeds: ['paymentsdive', 'tc_apps', 'verge', 'ninetofivemac'],
      must: 'stripe|paddle|lemon squeezy|paypal|\\bsquare\\b|merchant (fees|tools|of record)|chargebacks?|payment (processor|links?)|subscriptions? (pricing|billing|plan)|billing|agentic (commerce|payments)|agents (won.t )?pay|apple pay|google (pay|wallet)',
      not: 'amex nabs|risk chief|sports|stadium' },
    { key: 'sw_browsers', label: 'Browser extensions', feeds: ['verge', 'engadget', 'tc_apps', 'ninetofivemac', 'ninetofivegoogle'],
      must: 'chrome (web store|extension)|extensions?\\b|browser|safari|firefox|\\bedge\\b|chrome', subpaths: ['extension'] },
    { key: 'sw_indie', label: 'Indie software', feeds: ['tc_apps', 'inc', 'fastcompany', 'entrepreneur', 'ninetofivemac', 'ninetofivegoogle', 'podnews'],
      must: 'indie (app|dev|developer|hacker|maker|software)|indie app spotlight|bootstrap|solo founder|one-person|\\bsaas\\b|micro-saas|without (any )?venture capital|side project|buys the indie|acquires .* app\\b|app (is )?shutting down' }
  ],
  exploring: [
    { key: 'ex_sidehustle', label: 'Side businesses', feeds: BIZ,
      must: 'side hustle|side business|side gig|start(ing)? (a|your) business|business ideas?|first business|quit (my|your|his|her|their) job|left (google|amazon|meta|apple|microsoft|his|her|their|a) (job)?|corporate job|9-to-5|nine-to-five|own your income|household product|the best idea for' },
    { key: 'ex_selfemployed', label: 'Working for yourself', feeds: ['entrepreneur', 'inc', 'cnbc_smallbiz', 'smallbiztrends'],
      must: 'self-employ|solopreneur|solo entrepreneur|freelanc|work(ing)? for yourself|be your own boss|\\bfounders?\\b|cofounder|without (any )?venture capital|bootstrapp|built (a|her|his|their) (business|brand|company)|small business owners?' }
  ]
};

export const PATHS = Object.keys(TOPICS).filter((p) => p !== 'all');
