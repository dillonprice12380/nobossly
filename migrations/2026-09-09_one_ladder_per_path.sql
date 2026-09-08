-- Nine ladders, one per path (src/ladders.js is now the source of truth for
-- level titles, XP floors and gates — founder_levels is no longer read).
--
-- This migration does the part that must live in the database: the quests those
-- ladders gate on have to exist in `challenges`, because that is the table
-- achievedQuests reads. Twelve of them existed only in tailored_challenges —
-- the elective pool, which is copied into user_custom_challenges on accept and
-- is therefore invisible to the ladder. A gate pointing at one of those would
-- have been a rung nobody could ever clear.
--
-- Every promoted gate is set to 200 XP: the same as the spine gate it replaces
-- ("Ship Something" at rung 3, "Do 25 outreach touches" at rung 4). The XP
-- floors pace the climb, so a substitute worth less would quietly make that
-- path's ladder longer.

insert into challenges (slug, title, description, emoji, challenge_type, xp_reward, requires_proof, is_active, min_level, max_level)
values
  ('publish-12-in-30', 'Publish 12 pieces in 30 days',
   'Volume before polish. Twelve real posts on your main platform teaches you more about what lands than three months of planning.',
   '🎬', 'one_time', 200, true, true, 1, 6),
  ('pitch-25-brands', 'Pitch 25 brands or collaborators',
   'Twenty-five real approaches — brands, other creators, newsletters. Cold outreach for a creator is a pitch deck of one good idea, sent twenty-five times.',
   '📨', 'one_time', 200, true, true, 1, 6),
  ('portfolio-that-wins-work', 'Publish a portfolio that wins work',
   'Not everything you have ever made — three pieces that show the work you want more of, with what the client actually got out of it.',
   '🗂️', 'one_time', 200, true, true, 1, 6),
  ('price-by-outcome', 'Price one offer by the outcome',
   'Name the result, then name the price that follows it. An offer described as sessions and calls gets priced like sessions and calls.',
   '🎁', 'one_time', 200, true, true, 1, 6),
  ('google-business-profile', 'Get your Google Business Profile live and verified',
   'For work people search for locally, this is the shop window. Verified, with real photos, hours and a service area.',
   '📍', 'one_time', 200, true, true, 1, 6),
  ('quote-10-jobs', 'Quote 10 jobs in two weeks',
   'Ten real quotes to real people. It tells you your win rate, which is the number that decides everything else on this path.',
   '📋', 'one_time', 200, true, true, 1, 6),
  ('test-without-lease', 'Test the concept without the lease',
   'A stall, a pop-up, a residency in someone else''s space — your actual product in front of paying strangers while the lease is still hypothetical.',
   '⛺', 'one_time', 200, true, true, 1, 6),
  ('count-footfall', 'Count footfall at three sites',
   'Stand there and count, at the hours you would open. The landlord''s figure is the landlord''s figure.',
   '🚶', 'one_time', 200, true, true, 1, 6),
  ('true-unit-margin', 'Work out your true unit margin',
   'Product, shipping, packaging, platform fees, returns. Not roughly — exactly. Almost every store that fails at scale was profitable on the rough number.',
   '🧾', 'one_time', 200, true, true, 1, 6),
  ('list-first-product-properly', 'List your first product properly',
   'Real photographs, a title someone would search for, and a description that answers the question that stops people buying.',
   '🏷️', 'one_time', 200, true, true, 1, 6),
  ('three-mfg-quotes', 'Get three manufacturing quotes',
   'Three real quotes with minimum order quantities and tooling costs written down. Until then the unit cost is a guess.',
   '🏭', 'one_time', 200, true, true, 1, 6),
  ('make-one-by-hand', 'Make one by hand and sell it',
   'One unit, made by you, sold to someone who is not related to you. It answers more questions than a year of design.',
   '🔨', 'one_time', 200, true, true, 1, 6),
  ('ship-usable-30', 'Ship something usable in 30 days',
   'Not finished — usable. One workflow that works end to end, in front of one real person.',
   '🚀', 'one_time', 200, true, true, 1, 6),
  ('watch-5-use-it', 'Watch 5 people use it without helping',
   'Sit on your hands. Everything you want to explain is a thing the product should have said itself.',
   '🎧', 'one_time', 200, true, true, 1, 6),
  ('interview-5-curious', 'Interview 5 people in a field you are curious about',
   'Five people already doing the thing you are considering. Ask what they wish they had known, and what a normal Tuesday looks like.',
   '🎤', 'one_time', 200, true, true, 1, 6)
on conflict (slug) do update set
  title = excluded.title, description = excluded.description, emoji = excluded.emoji,
  challenge_type = excluded.challenge_type, xp_reward = excluded.xp_reward,
  requires_proof = excluded.requires_proof, is_active = excluded.is_active,
  min_level = excluded.min_level, max_level = excluded.max_level;

-- The elective copies are retired: a quest that gates a rung should appear once,
-- on the quest board, not also in the electives where completing it would be
-- copied into user_custom_challenges and never counted.
update tailored_challenges set is_active = false
 where title in (
   'Publish 12 pieces in 30 days', 'Price one offer by the outcome',
   'Get your Google Business Profile live and verified', 'Quote 10 jobs in two weeks',
   'Test the concept without the lease', 'Count footfall at three sites',
   'Work out your true unit margin', 'Get three manufacturing quotes',
   'Ship something usable in 30 days', 'Watch 5 people use it without helping',
   'Make one by hand and sell it', 'Interview 5 people in a field you are curious about');

comment on table founder_levels is
  'Superseded by src/ladders.js as of 2026-09-09. No application code reads this table; each path has its own ten rungs defined in code. Kept for history.';
