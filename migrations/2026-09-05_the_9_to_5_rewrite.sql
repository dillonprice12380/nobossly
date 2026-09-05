-- Repositioning: the site is about getting out of a job, not about being a founder.
--
-- The copy change is mostly in the repo, but four kinds of user-visible text
-- live in the database and would otherwise still say "founder" on a page whose
-- headings no longer do:
--
--   1. pricing_tiers.name    — the paid plan was literally called "Founder"
--   2. guidance_rules.message — the Coach's tips, shown on the dashboard
--   3. challenges.description — two shared quests referred to "a fellow founder"
--   4. site_settings seo_*    — dormant today, but stale the moment it is wired up
--
-- Nothing here touches level titles: level 6 is still "Founder", and members who
-- earned it keep the title they earned.

-- 1. The paid plan is the Escape plan ------------------------------------------
update pricing_tiers set name = 'Escape Monthly'    where key = 'month';
update pricing_tiers set name = 'Escape Quarterly'  where key = 'quarter';
update pricing_tiers set name = 'Escape Annual'     where key = 'year';
update pricing_tiers set name = 'Escape Lifetime',
       tagline = 'One payment. Yours forever. Early-member price.'
  where key = 'lifetime';

-- 2. The Coach ------------------------------------------------------------------
update guidance_rules set message =
  'Seven questions stand between you and your Compass — and answering them is your Level 1 quest. Takes about two minutes, tonight, after work.'
  where key = 'no_questionnaire';

update guidance_rules set message =
  'Your character sheet is waiting. Draw your Compass — archetype, territories, and the 5-point fit test built from the hours you actually have — in about a minute.'
  where key = 'no_compass';

update guidance_rules set message =
  'Streak reset — it happens to everyone doing this around a job. Your record is {longest_streak} days, and it''s still there to beat. Check in today to restart.'
  where key = 'streak_broken';

update guidance_rules set message =
  'Next rung — Level 5, Operator: make your first sale and register your business. The first money you earn that has nothing to do with your employer.'
  where key = 'rung_to_5';

update guidance_rules set message =
  'Next rung — Level 6, Founder: earn your first $100, open a business bank account, collect 5 testimonials. Prove the first sale wasn''t luck.'
  where key = 'rung_to_6';

update guidance_rules set message =
  'Next rung — Level 8, Launcher: hit a $1k month and build your pitch deck. The first month this reads as income rather than a hobby.'
  where key = 'rung_to_8';

update guidance_rules set message =
  'The final rung — Level 10, Legend: sustain $1K MRR and document your playbook for the people still stuck where you started.'
  where key = 'rung_to_10';

-- Two tips for the situation the whole site is now about: doing this while
-- still employed. Same shape as the existing evergreen tips.
insert into guidance_rules (key, priority, conditions, message, cta_label, cta_href, category, cooldown_days, active)
values
  ('tip_dont_quit_early', 20, '{"level": {"lte": 5}}'::jsonb,
   'Coach''s tip: your job is funding this. Quitting before Level 8 turns a patient plan into a panicked one — the salary is the runway that lets you say no to bad customers.',
   null, null, 'evergreen', 21, true),
  ('tip_evening_scope', 20, '{"level": {"lte": 4}}'::jsonb,
   'Coach''s tip: scope the week to the hours you actually have, not the hours you wish you had. Two real evenings beats a heroic weekend you cancel.',
   null, null, 'evergreen', 16, true)
on conflict (key) do update set
  message = excluded.message, conditions = excluded.conditions,
  category = excluded.category, priority = excluded.priority,
  cooldown_days = excluded.cooldown_days, active = excluded.active;

-- 3. Shared quests --------------------------------------------------------------
update challenges set description = 'Complete one peer review for another member in the queue.'
  where slug = 'peer_review_give';
update challenges set description = 'Complete one market research survey from another member.'
  where slug = 'respond_to_survey';

-- 4. Dormant SEO settings -------------------------------------------------------
update site_settings set value = to_jsonb('NoBossly — Work your way out of the 9 to 5.'::text) where key = 'seo_title';
update site_settings set value = to_jsonb('NoBossly is how people with a job build their way out of it: a Compass drawn from your real hours and runway, a fit test your idea has to pass, and ten levels from first customer to handing in your notice.'::text) where key = 'seo_description';
update site_settings set value = to_jsonb('quit your job, escape the 9 to 5, side hustle, business ideas, self employment, AI'::text) where key = 'seo_keywords';

-- 5. The About page -------------------------------------------------------------
-- CMS content, so it is not in the repo with the rest of the copy, but it is a
-- public marketing page and it still described the product as being about
-- becoming a founder.
update cms_contents set body =
'<h2>Fire your boss. Level up instead.</h2><p>NoBossly is for people who already have a job and want a way out of it. It begins with your Compass — an honest map of your archetype, your strengths, the hours that are genuinely yours once work is done, how long you could last without a paycheck, and the territories where you hold a real edge. Then you choose your own idea, in your own words, and an AI advisor stress-tests it against your own fit criteria and the live market. From there you climb: ten levels, where every level-up gates on something that actually happened — your first feedback sessions, the first thing you ship, the first money that did not come from your employer, your first $1k month, the month you go full-time — with 7-day sprints sized for evenings, daily check-ins, and a community of people fitting this around the same kind of week you have.</p><p>The XP is for fun. The accomplishments are real. Level 8 is the first month this reads as income rather than a hobby, and Level 10 means you publish your playbook for the people still stuck where you started.</p><p>We believe getting out of a job you do not want should not require capital, connections, or an MBA — just a plan you can work on after dinner and proof at every step that it is working. NoBossly exists to make that ordinary.</p>'
  where slug = 'about' and type = 'page';
