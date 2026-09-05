-- Applied 2026-09-04. A ninth path: physical_product.
--
-- It sits next to online_store and the line between them is worth stating,
-- because a founder picking wrongly gets the wrong questions for a year:
--
--   physical_product — you MAKE the thing. Prototyping, manufacturing, unit
--                      cost, minimum orders, tooling, certification, IP.
--   online_store     — you RUN THE SHOP. Sourcing, curating or reselling
--                      products someone else makes. Channel, fulfilment,
--                      margin on goods you buy in.
--
-- The online_store blurb was narrowed to match ("You run the shop — sourcing,
-- curating or reselling products rather than inventing them"), and
-- test/paths.js asserts the two share no questions beyond the universal set,
-- so they cannot quietly converge.

insert into fit_criteria_library (slug, criterion, why, check_kind, metric, op, value_from, value, applies_when, category, priority, paths) values

-- The margin rule that only applies to making something. A shop buys at
-- wholesale and sells at retail; a maker has to leave room for BOTH cuts.
('pp_margin_stack', 'Does it sell for at least three times what it costs to make?',
 'A wholesaler and a retailer both take a cut before the customer pays. A product that only doubles its cost has nothing left to give them, so it can only ever be sold direct.',
 'judgment', null, null, null, null, '{}'::jsonb, 'unit_economics', 93, '{physical_product}'),

('pp_proof_before_tooling', 'Can you prove people will buy it before you pay for tooling or a minimum order?',
 'Tooling and first runs are the point of no return — the money is gone whether it sells or not. Anything you can learn before that is bought cheaply.',
 'boolean', null, null, null, null, '{}'::jsonb, 'risk', 92, '{physical_product}'),

('pp_first_run_affordable', 'Could you pay for the smallest run a manufacturer will accept?',
 'Minimum order quantities decide whether this is a business you can start or one you can only plan.',
 'judgment', null, null, null, null, '{}'::jsonb, 'capital', 89, '{physical_product}')

on conflict (slug) do update set
  criterion = excluded.criterion, why = excluded.why, check_kind = excluded.check_kind,
  applies_when = excluded.applies_when, category = excluded.category,
  priority = excluded.priority, paths = excluded.paths, is_active = true;

-- Curated electives. Every one happens BEFORE money is committed to a run,
-- because that is where this path is won or lost.
insert into tailored_challenges (title, description, emoji, xp_reward, suggested_days, min_level, max_level, paths, source, is_active) values
('Cost one unit to the penny', 'Materials, labour, packaging, shipping, duty, platform fee. Every business decision you make after this depends on the number.', '🧮', 150, 14, 1, 5, '{physical_product}', 'curated', true),
('Make one by hand and sell it', 'One unit, one real buyer, money changing hands. It answers more questions than a year of planning and costs almost nothing.', '🔨', 200, 30, 1, 5, '{physical_product}', 'curated', true),
('Get three manufacturing quotes', 'Same spec, three makers. The spread between them is usually larger than you expect, and asking teaches you what you have not specified.', '🏭', 150, 30, 2, 6, '{physical_product}', 'curated', true),
('Pre-sell 10 units before making any', 'Take real money for something that does not exist yet. If ten people will not, a thousand units in your hallway will not fix it.', '💳', 300, 45, 2, 7, '{physical_product}', 'curated', true),
('Put it in one independent shop', 'One wholesale order to one local retailer. It tests the margin, the packaging and the pitch all at once.', '🛍️', 250, 60, 3, 8, '{physical_product}', 'curated', true)
on conflict do nothing;

-- Snapshot fingerprint after this migration: cbfdad7f at 42 rows.
