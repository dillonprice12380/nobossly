-- The ladder gates were written for one kind of business and applied to all nine.
--
-- A content creator does not register a company to take a sponsorship. A plumber
-- at $1k months will never build a pitch deck. A shop clears "reach 10 paying
-- customers" before lunch on its first day, and a shop's $1k month is a disaster
-- rather than a milestone — its rent alone is $1,500.
--
-- Each gate can now carry `only` or `except` (see questApplies in src/xp.js), so
-- a rung asks each path for the thing that means the same on that path. Two
-- rules hold this together:
--
--   Substitute, never skip. The site promises the same ten-level ladder to
--   everyone; a path that reaches Level 10 on fewer real accomplishments makes
--   that a lie. Every swap below is a like-for-like replacement.
--
--   Same XP as what it replaces. The XP floors are what pace the climb, so a
--   substitute worth less would quietly make that path's ladder longer through
--   no fault of the member's.

-- ---------------------------------------------------------------- substitutes
insert into challenges (slug, title, description, emoji, challenge_type, xp_reward, requires_proof, is_active, min_level, max_level)
values
  ('audience-proof-5', 'Collect 5 pieces of audience proof',
   'Five messages, comments or emails from people your work actually helped. A creator has no clients to write testimonials — the audience is the proof.',
   '💬', 'one_time', 200, true, true, 4, 8),
  ('serve-100-customers', 'Serve 100 paying customers',
   'A hundred people through the door who paid. Ten is under an hour of trade for a shop; a hundred is a fortnight of real business.',
   '🏪', 'one_time', 500, true, true, 5, 8),
  ('reach-50-customers', 'Reach 50 paying customers',
   'Fifty orders — roughly one month at the order volume a $1k month takes for a store.',
   '🛒', 'one_time', 500, true, true, 5, 8),
  ('cover-a-months-rent', 'Cover a month''s rent from takings',
   'One month where the till covered the lease. For a place with rent to pay this is the first month that means anything — a $1k month would not touch it.',
   '🔑', 'one_time', 800, true, true, 6, 9)
on conflict (slug) do update set
  title = excluded.title, description = excluded.description, emoji = excluded.emoji,
  challenge_type = excluded.challenge_type, xp_reward = excluded.xp_reward,
  requires_proof = excluded.requires_proof, is_active = excluded.is_active,
  min_level = excluded.min_level, max_level = excluded.max_level;

insert into predefined_milestones (slug, title, description, category, xp_reward, is_claimable, auto_kind, is_active, position)
values
  ('set-up-how-you-get-paid', 'Set up how you get paid',
   'A payment route in your own name — platform payouts, an invoice, a card reader — and you know how the income gets declared. What registering a company does for other paths, without needing one.',
   'foundation', 400, true, null, true, 110),
  ('separate-your-business-money', 'Separate your business money',
   'The money this earns lives somewhere of its own, even if that is a second personal account. You can answer "what did this actually make?" without unpicking your grocery shopping.',
   'foundation', 300, true, null, true, 111),
  ('write-your-one-page-plan', 'Write your one-page plan',
   'The offer, the numbers, and the next ninety days on one page. A pitch deck is for a room full of investors; most paths never face one, but everybody needs to be able to explain the business.',
   'foundation', 300, true, null, true, 112),
  ('three-1k-months', 'Three $1k months in a row',
   'Three consecutive months over $1,000. Recurring revenue is the wrong unit for work sold job by job — this is the same rigour in the right one.',
   'revenue', 900, true, null, true, 113),
  ('three-months-rent-and-wages', 'Three months of covering rent and paying yourself',
   'Three months where the takings cleared the lease AND left you wages. For a place with fixed costs, this is what sustained actually means.',
   'revenue', 900, true, null, true, 114)
on conflict (slug) do update set
  title = excluded.title, description = excluded.description, category = excluded.category,
  xp_reward = excluded.xp_reward, is_claimable = excluded.is_claimable,
  is_active = excluded.is_active, position = excluded.position;

-- ------------------------------------------------------------------- the gates
-- Level 5 — a creator or someone still exploring takes a first sale without a
-- registered company; what they need is a way to be paid and to declare it.
update founder_levels set requirements = '{"quests":[
  {"type":"challenge","title":"Make your first sale"},
  {"type":"milestone","title":"Registered my business","except":["creator","exploring"]},
  {"type":"milestone","title":"Set up how you get paid","only":["creator","exploring"]}
]}'::jsonb where level = 5;

-- Level 6 — business banking follows from a registration they do not have, and
-- testimonials need clients a creator does not have either.
update founder_levels set requirements = '{"quests":[
  {"type":"challenge","title":"Earn Your First $100"},
  {"type":"milestone","title":"Opened a business bank account","except":["creator","exploring"]},
  {"type":"milestone","title":"Separate your business money","only":["creator","exploring"]},
  {"type":"challenge","title":"Collect 5 testimonials","except":["creator"]},
  {"type":"challenge","title":"Collect 5 pieces of audience proof","only":["creator"]}
]}'::jsonb where level = 6;

-- Level 7 — ten paying customers is a real milestone for a consultancy and a
-- first morning for a café.
update founder_levels set requirements = '{"quests":[
  {"type":"challenge","title":"Reach 10 paying customers","except":["brick_mortar","online_store"]},
  {"type":"challenge","title":"Serve 100 paying customers","only":["brick_mortar"]},
  {"type":"challenge","title":"Reach 50 paying customers","only":["online_store"]},
  {"type":"challenge","title":"Automate one process"}
]}'::jsonb where level = 7;

-- Level 8 — the pitch deck stays where someone plausibly raises money; everyone
-- else writes the one-pager. A $1k month does not touch a lease.
update founder_levels set requirements = '{"quests":[
  {"type":"challenge","title":"Hit a $1k month","except":["brick_mortar"]},
  {"type":"challenge","title":"Cover a month''s rent from takings","only":["brick_mortar"]},
  {"type":"milestone","title":"Built a pitch deck","only":["software","physical_product","brick_mortar"]},
  {"type":"milestone","title":"Write your one-page plan","except":["software","physical_product","brick_mortar"]}
]}'::jsonb where level = 8;

-- Level 10 — MRR is subscription revenue. It is the right unit for software and
-- for retainer consulting, and the wrong one for everything sold job by job.
update founder_levels set requirements = '{"quests":[
  {"type":"milestone","title":"$1K MRR","only":["software","consultant"]},
  {"type":"milestone","title":"Three $1k months in a row","except":["software","consultant","brick_mortar"]},
  {"type":"milestone","title":"Three months of covering rent and paying yourself","only":["brick_mortar"]},
  {"type":"challenge","title":"Document your playbook"}
]}'::jsonb where level = 10;

-- Two unlock lines became false for the paths that now substitute. Reworded to
-- be true on every path rather than made path-aware, which would be machinery
-- for two sentences.
update founder_levels set unlock_text =
  'Operator unlocked: FIRST SALE. A real customer, real money, and you are properly set up to receive it. Your First Dollar card is ready to share.'
  where level = 5;
update founder_levels set unlock_text =
  'Founder unlocked: the first sale was not luck. $100 earned, proof in hand, and the money kept somewhere of its own. You run a business.'
  where level = 6;
