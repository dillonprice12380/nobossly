-- The one number each path is measured by.
--
-- Creators got theirs first (followers or monthly visitors). This is the same
-- idea for the other seven, and the shape splits two ways — see src/traction.js
-- for the reasoning:
--
--   EXTERNAL bars are the same for everyone because someone else sets them:
--   advertisers decide when an audience is worth sponsoring, the margin stack
--   decides that a product needs 3x its cost, landlords and retail convention
--   put rent under 10% of takings.
--
--   DERIVED bars fall out of the member's own answers. There is no universal
--   right freelance rate; there is only the rate that clears the money at the
--   hours they have. Hardcoding one would be wrong for half of them.
--
-- Both end up in the same place: a single criterion whose wording binds to that
-- member's own unit. One row reads "$39 an hour" to a freelancer, "34 paying
-- customers" to a SaaS founder and "$15,000 a month through the till" to a shop.
-- Its own category, so it never competes with the path-specific criteria.

insert into fit_criteria_library
  (slug, criterion, why, check_kind, metric, op, value_from, value, applies_when, category, priority, is_active, paths)
values
  ('reaches_the_money_bar',
   'Can this reach a $1,000 month — {traction}?',
   'That is {traction_detail}. A $1k month is the Level 8 rung: the first month this reads as income rather than a hobby. An idea that cannot arithmetically get there is not a slower plan, it is a different one.',
   'judgment', null, null, null, null,
   '{"has_traction_bar": true}'::jsonb, 'traction', 91, true, array[]::text[]),

  -- The risk that matters most on a site about leaving a job: rebuilding the
  -- same dependency you were trying to escape.
  ('client_concentration',
   'Could you lose your biggest client and still cover your costs?',
   'One client over half your income is a job with worse rights and no notice period. It is the specific way this path quietly turns back into the thing you left.',
   'judgment', null, null, null, null, '{}'::jsonb, 'risk', 86, true,
   array['freelancer','consultant']),

  -- The lease is this path's point of no return, and the only cheap thing to do
  -- about it happens before signing.
  ('proof_before_lease',
   'Could you get 25 people to commit before you sign anything?',
   'A lease is years of rent that does not care whether anyone comes in. Twenty-five real people who said yes — a market stall, a pop-up, a pre-sale — costs almost nothing and is the only evidence available before the money is gone.',
   'judgment', null, null, null, null, '{}'::jsonb, 'validation', 90, true,
   array['brick_mortar'])
on conflict (slug) do update set
  criterion = excluded.criterion, why = excluded.why, check_kind = excluded.check_kind,
  applies_when = excluded.applies_when, category = excluded.category,
  priority = excluded.priority, is_active = excluded.is_active, paths = excluded.paths;

-- One quest per path, in that path's unit. Deliberately worded WITHOUT the
-- member's number in it: the elective pool filters by path and level only, so a
-- hardcoded "reach 34 customers" would be wrong for everyone whose pricing
-- differs. The number belongs in the fit test, where it is bound per member.
insert into tailored_challenges
  (title, description, emoji, xp_reward, suggested_days, min_level, max_level, source, is_active, paths)
select * from (values
  ('Raise your rate on the next client',
   'Not the existing ones — the next one. Quote the number your own arithmetic says you need and say nothing after it. If nobody has ever hesitated at your price, it is too low.',
   '💷', 150, 30, 3, 8, 'curated', true, array['freelancer']),
  ('Sell one engagement at your named price',
   'The price you said you could say out loud without flinching. One client at that number teaches you more than ten at your old one.',
   '🎯', 250, 60, 3, 8, 'curated', true, array['consultant']),
  ('Book four jobs in a single week',
   'A week that looks like a full week. It tells you whether the work exists inside your radius at the rate you need, which is the whole question on this path.',
   '🚐', 250, 30, 3, 8, 'curated', true, array['local_service']),
  ('Cost one unit to the penny',
   'Product, shipping, packaging, platform fees, returns. Not roughly — exactly. Almost every store that fails at scale was profitable on the rough number.',
   '🧾', 150, 14, 1, 6, 'curated', true, array['online_store','physical_product']),
  ('Get your first ten paying customers',
   'Ten people who entered card details. It is the smallest number that rules out your friends being polite, and the first honest read on whether the price holds.',
   '💳', 400, 90, 3, 8, 'curated', true, array['software']),
  ('Prove the takings before you sign',
   'A stall, a pop-up, a residency in someone else''s space — anything that puts your actual product in front of paying strangers while the lease is still hypothetical.',
   '🏪', 400, 60, 2, 6, 'curated', true, array['brick_mortar']),
  ('Get 25 committed buyers before you pay for tooling',
   'Pre-orders, deposits, or signed intent from 25 people. Tooling and minimum orders are money you cannot get back — this is the last cheap thing you can do.',
   '📦', 400, 60, 2, 6, 'curated', true, array['physical_product'])
) as v(title, description, emoji, xp_reward, suggested_days, min_level, max_level, source, is_active, paths)
where not exists (select 1 from tailored_challenges t where t.title = v.title);
