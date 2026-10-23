// Starter tasks, by path. A new member's task board and sprint form are empty,
// and an empty box is the hardest thing to start from — so each path offers a
// handful of first moves the member can add with one click. They are small on
// purpose: each should fit in an evening after work.

const COMMON = [
  'Write one sentence: who I help and what I do for them',
  'Block two evenings this week for the business',
  'Post an introduction in the community'
];

const BY_PATH = {
  creator: [
    'Pick one platform to focus on for the next 30 days',
    'List 10 post ideas my audience would actually save',
    'Publish my first post this week',
    'Study 3 creators one step ahead of me — what do they post?',
    'Set up a simple link-in-bio page'
  ],
  freelancer: [
    'Define one service with a clear price',
    'Gather 3 work samples into a simple portfolio',
    'Message 5 people who might need this service',
    'Write a one-paragraph pitch I can paste into messages',
    'Draft a simple client agreement'
  ],
  consultant: [
    'Write the outcome I sell in one sentence',
    'List 10 people who have the problem I solve',
    'Book 3 conversations about their biggest headache',
    'Price one offer by the outcome, not the hour',
    'Write a one-page description of the offer'
  ],
  local_service: [
    'Check what licenses or permits my trade needs locally',
    'Set up a Google Business Profile',
    'Ask 5 neighbours or friends who they call for this job',
    'Write a simple price list for my 3 most common jobs',
    'Get a separate phone number or email for jobs'
  ],
  brick_mortar: [
    'Visit 3 similar businesses and note what they charge',
    'Count foot traffic at one possible location for an hour',
    'Test the idea at a market or pop-up before signing a lease',
    'Write down my startup costs, line by line',
    'Talk to 5 people who would be customers'
  ],
  online_store: [
    'Choose one product to start with',
    'Work out the true cost per unit, shipping included',
    'Look at 3 competing stores — price, photos, reviews',
    'Take proper photos of the first product',
    'Write a product page that answers the top 3 questions'
  ],
  physical_product: [
    'Sketch the product and list what it is made of',
    'Make one by hand and show it to 5 people',
    'Ask 3 manufacturers for a quote',
    'Work out the price that leaves a healthy margin',
    'Find out what safety or labelling rules apply'
  ],
  software: [
    'Write the one problem the product solves',
    'Talk to 5 people who have that problem',
    'Sketch the smallest version that solves it',
    'Build a landing page and collect sign-ups',
    'Ship something usable to one person'
  ],
  exploring: [
    'List 10 things people already ask me for help with',
    'Pick the 3 that could make money and write why',
    'Talk to one person who already does each of them',
    'Read one guide for the path that fits best',
    'Choose a path to try for the next 30 days'
  ]
};

function forPath(path) {
  return (BY_PATH[path] || BY_PATH.exploring).concat(COMMON).slice(0, 7);
}

module.exports = { forPath, BY_PATH, COMMON };
