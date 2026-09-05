-- Creators are measured in two different units, and the units become money at
-- very different sizes.
--
-- The questionnaire now asks a creator what kind they are and then asks for the
-- right number — followers/subscribers, or monthly visitors. This is the
-- database half: the fit criteria that hold an idea to the bar, and two quests
-- that name it.
--
-- The bar itself lives in src/paths.js (CREATOR_AUDIENCE) and is bound into the
-- wording per member, so one library row serves both kinds — a social creator
-- reads "10,000 followers" and a publisher reads "50,000 monthly visitors" from
-- the same row.

-- The existing "does it earn before you have a large audience?" was the right
-- question asked vaguely. Same slug, same category, now carrying the number.
update fit_criteria_library set
  criterion = 'Does it earn before you reach {audience_target} {audience_metric}?',
  why = 'The money that comes from audience size alone — sponsorship, ads, affiliate — does not really begin until around {audience_target} {audience_metric}, and you have {audience_now}. Anything that pays nothing before then is a plan for a later year, not for your runway.',
  priority = 92
  where slug = 'creator_not_just_ads';

insert into fit_criteria_library
  (slug, criterion, why, check_kind, metric, op, value_from, value, applies_when, category, priority, is_active, paths)
values
  ('creator_route_to_audience',
   'Is there a believable route from {audience_now} to {audience_target} {audience_metric} at a rhythm you can hold?',
   'Audience is the asset this path is built on, and "post more" is not a route. A specific format, a place people already gather, and a cadence you can keep for a year is.',
   'judgment', null, null, null, null, '{}'::jsonb, 'distribution', 88, true, array['creator'])
on conflict (slug) do update set
  criterion = excluded.criterion, why = excluded.why, check_kind = excluded.check_kind,
  applies_when = excluded.applies_when, category = excluded.category,
  priority = excluded.priority, is_active = excluded.is_active, paths = excluded.paths;

-- Two quests, one per unit. The elective board filters by path and level only,
-- so both are offered to every creator and they take the one that matches their
-- medium — the board is a menu, not an assignment.
insert into tailored_challenges
  (title, description, emoji, xp_reward, suggested_days, min_level, max_level, source, is_active, paths)
select * from (values
  ('Reach 10,000 followers',
   'The size where sponsorship offers start arriving without you asking. One format, one rhythm, held. This is a months-long quest, not a weekend one.',
   '📈', 400, 180, 3, 8, 'curated', true, array['creator']),
  ('Reach 50,000 monthly readers',
   'For a blog or publication this is roughly where ad and affiliate revenue stops being pocket change. Search traffic compounds — the work is publishing consistently against questions people actually ask.',
   '📊', 400, 180, 3, 8, 'curated', true, array['creator'])
) as v(title, description, emoji, xp_reward, suggested_days, min_level, max_level, source, is_active, paths)
where not exists (select 1 from tailored_challenges t where t.title = v.title);
