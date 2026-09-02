-- Applied 2026-09-01. Recorded here because the repo tracks schema and game
-- config changes in this folder; both statements are idempotent, so re-running
-- against a database that already has them is a no-op.
--
-- The questionnaire used to sit between signup and every feature, and it is
-- where onboarding lost people. It is now a Level 1 quest instead: a founder
-- can look around first, but cannot leave Level 1 without answering it —
-- because the Compass, and everything drawn from it, depends on those answers.
--
-- auto_kind 'questionnaire' is computed in src/milestones_engine.js as the
-- count of COMPLETED questionnaire_responses, so the trophy self-heals on the
-- next sweep. A half-finished run does not count.

insert into predefined_milestones (slug, title, description, emoji, category, xp_reward, position, is_active, auto_kind, auto_target, is_claimable)
values ('questionnaire_done', 'Compass Questions Answered',
        'Answered the founder questionnaire — the answers your Founder Compass is drawn from.',
        '🧭', 'foundation', 40, 0, true, 'questionnaire', 1, false)
on conflict (slug) do update set
  title = excluded.title, description = excluded.description, emoji = excluded.emoji,
  category = excluded.category, xp_reward = excluded.xp_reward, position = excluded.position,
  is_active = true, auto_kind = excluded.auto_kind, auto_target = excluded.auto_target,
  is_claimable = excluded.is_claimable;

-- Prepended to Level 2's quests, so it reads first in the quest log.
update founder_levels
   set requirements = jsonb_set(
         requirements::jsonb, '{quests}',
         '[{"type":"milestone","title":"Compass Questions Answered"}]'::jsonb
           || (requirements::jsonb -> 'quests')
       )
 where level = 2
   and not (requirements::jsonb -> 'quests' @> '[{"type":"milestone","title":"Compass Questions Answered"}]'::jsonb);

-- The AI idea generator is retired, so this trophy can only come from an idea
-- the founder drafted themselves through the Compass advisor.
update predefined_milestones
   set title = 'First Idea Drafted',
       description = 'Drafted your own idea and ran it past your Compass advisor.'
 where slug = 'first_idea';

-- The Coach: nothing outranks "you have not answered yet". It sits above
-- no_compass (100) because /compass just bounces to /questionnaire when the
-- answers are missing, and being told to draw a Compass only to land on a
-- questionnaire is a bait and switch.
insert into guidance_rules (key, priority, conditions, message, cta_label, cta_href, category, cooldown_days, active)
values ('no_questionnaire', 105,
        '{"has_questionnaire": false}'::jsonb,
        'Seven questions stand between you and your Founder Compass — and answering them is your Level 1 quest. Takes about two minutes.',
        'Answer them now', '/questionnaire', 'onboarding', 1, true)
on conflict (key) do update set
  priority = excluded.priority, conditions = excluded.conditions, message = excluded.message,
  cta_label = excluded.cta_label, cta_href = excluded.cta_href, category = excluded.category,
  cooldown_days = excluded.cooldown_days, active = true;

-- no_compass now means "answered, but has not drawn it yet".
update guidance_rules
   set conditions = conditions::jsonb || '{"has_questionnaire": true}'::jsonb
 where key = 'no_compass';
