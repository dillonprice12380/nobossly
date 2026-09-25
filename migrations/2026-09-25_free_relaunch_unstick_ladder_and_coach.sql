-- Free relaunch cleanup. The Compass, questionnaire, idea advisor, blueprint
-- generator and pricing are gone from the app, but the database still pointed
-- at them. Three fixes, all idempotent:
--
--  1. ladder_rungs still gated Level 2 on "Compass Questions Answered",
--     "Passes Your Own Test" and "Three Real Signals", and Level 3 on
--     "Blueprint Built" — none can be earned any more, so every member was
--     capped at Level 1. Re-seeded from src/ladders.js (scripts/gen_ladder_sql.js).
--  2. Coach tips (guidance_rules) linked to /questionnaire, /compass, /ideas
--     and /pricing, all 404s now. The ones about removed features are switched
--     off; the rest are pointed at pages that exist. Nothing is deleted.
--  3. Trophies only the removed features could award are retired (earned
--     copies still show as legacy), and Level 1's welcome text is rewritten.

begin;

-- 1. The ladder ------------------------------------------------------------
insert into ladder_rungs (path, level, xp_required, min_gates, gates) values
  ('creator', 1, 0, null, '[]'::jsonb),
  ('creator', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('creator', 3, 300, null, '["c:publish 12 pieces in 30 days","m:sprint 1 completed"]'::jsonb),
  ('creator', 4, 600, null, '["c:5 customer conversations","c:pitch 25 brands or collaborators"]'::jsonb),
  ('creator', 5, 1000, null, '["c:make your first sale","m:set up how you get paid"]'::jsonb),
  ('creator', 6, 1500, null, '["c:earn your first $100","m:separate your business money","c:collect 5 pieces of audience proof"]'::jsonb),
  ('creator', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('creator', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('creator', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('creator', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('freelancer', 1, 0, null, '[]'::jsonb),
  ('freelancer', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('freelancer', 3, 300, null, '["c:publish a portfolio that wins work","m:sprint 1 completed"]'::jsonb),
  ('freelancer', 4, 600, null, '["c:5 customer conversations","c:do 25 outreach touches"]'::jsonb),
  ('freelancer', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('freelancer', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('freelancer', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('freelancer', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('freelancer', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('freelancer', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('consultant', 1, 0, null, '[]'::jsonb),
  ('consultant', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('consultant', 3, 300, null, '["c:price one offer by the outcome","m:sprint 1 completed"]'::jsonb),
  ('consultant', 4, 600, null, '["c:5 customer conversations","c:do 25 outreach touches"]'::jsonb),
  ('consultant', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('consultant', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('consultant', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('consultant', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('consultant', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('consultant', 10, 6000, null, '["m:$1k mrr","c:document your playbook"]'::jsonb),
  ('local_service', 1, 0, null, '[]'::jsonb),
  ('local_service', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('local_service', 3, 300, null, '["c:get your google business profile live and verified","m:sprint 1 completed"]'::jsonb),
  ('local_service', 4, 600, null, '["c:5 customer conversations","c:quote 10 jobs in two weeks"]'::jsonb),
  ('local_service', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('local_service', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('local_service', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('local_service', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('local_service', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('local_service', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('brick_mortar', 1, 0, null, '[]'::jsonb),
  ('brick_mortar', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('brick_mortar', 3, 300, null, '["c:test the concept without the lease","m:sprint 1 completed"]'::jsonb),
  ('brick_mortar', 4, 600, null, '["c:5 customer conversations","c:count footfall at three sites"]'::jsonb),
  ('brick_mortar', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('brick_mortar', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('brick_mortar', 7, 2200, null, '["c:serve 100 paying customers","c:automate one process"]'::jsonb),
  ('brick_mortar', 8, 3000, null, '["c:cover a month''s rent from takings","m:built a pitch deck"]'::jsonb),
  ('brick_mortar', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('brick_mortar', 10, 6000, null, '["m:three months of covering rent and paying yourself","c:document your playbook"]'::jsonb),
  ('online_store', 1, 0, null, '[]'::jsonb),
  ('online_store', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('online_store', 3, 300, null, '["c:list your first product properly","m:sprint 1 completed"]'::jsonb),
  ('online_store', 4, 600, null, '["c:5 customer conversations","c:work out your true unit margin"]'::jsonb),
  ('online_store', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('online_store', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('online_store', 7, 2200, null, '["c:reach 50 paying customers","c:automate one process"]'::jsonb),
  ('online_store', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('online_store', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('online_store', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('physical_product', 1, 0, null, '[]'::jsonb),
  ('physical_product', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('physical_product', 3, 300, null, '["c:make one by hand and sell it","m:sprint 1 completed"]'::jsonb),
  ('physical_product', 4, 600, null, '["c:5 customer conversations","c:get three manufacturing quotes"]'::jsonb),
  ('physical_product', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('physical_product', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('physical_product', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('physical_product', 8, 3000, null, '["c:hit a $1k month","m:built a pitch deck"]'::jsonb),
  ('physical_product', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('physical_product', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('software', 1, 0, null, '[]'::jsonb),
  ('software', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('software', 3, 300, null, '["c:ship something usable in 30 days","m:sprint 1 completed"]'::jsonb),
  ('software', 4, 600, null, '["c:5 customer conversations","c:watch 5 people use it without helping"]'::jsonb),
  ('software', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('software', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('software', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('software', 8, 3000, null, '["c:hit a $1k month","m:built a pitch deck"]'::jsonb),
  ('software', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('software', 10, 6000, null, '["m:$1k mrr","c:document your playbook"]'::jsonb),
  ('exploring', 1, 0, null, '[]'::jsonb),
  ('exploring', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('exploring', 3, 300, null, '["c:ship something","m:sprint 1 completed"]'::jsonb),
  ('exploring', 4, 600, null, '["c:5 customer conversations","c:interview 5 people in a field you are curious about"]'::jsonb),
  ('exploring', 5, 1000, null, '["c:make your first sale","m:set up how you get paid"]'::jsonb),
  ('exploring', 6, 1500, null, '["c:earn your first $100","m:separate your business money","c:collect 5 testimonials"]'::jsonb),
  ('exploring', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('exploring', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('exploring', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('exploring', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('default', 1, 0, null, '[]'::jsonb),
  ('default', 2, 100, null, '["c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('default', 3, 300, null, '["c:ship something","m:sprint 1 completed"]'::jsonb),
  ('default', 4, 600, null, '["c:5 customer conversations","c:do 25 outreach touches"]'::jsonb),
  ('default', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('default', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('default', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('default', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('default', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('default', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb)
on conflict (path, level) do update set
  xp_required = excluded.xp_required, min_gates = excluded.min_gates, gates = excluded.gates;

-- 2. Coach tips -------------------------------------------------------------
update guidance_rules set active = false
 where key in ('no_compass', 'compass_no_idea', 'idea_unscored', 'idea_refine',
               'idea_needs_signals', 'idea_ready_for_blueprint', 'idea_drafted_today',
               'blueprint_no_sprint', 'idea_no_blueprint_free', 'tasks_empty_no_sprint',
               'path_exploring_territories', 'needs_feedback_sessions');

-- The first nudge: pick a path (was "answer the questionnaire").
update guidance_rules set
  conditions = '{"has_path": false}'::jsonb,
  message = 'One choice stands between you and your quest board: pick the path that fits what you want to build. You can change it later.',
  cta_label = 'Pick my path', cta_href = '/choose-path'
 where key = 'no_questionnaire';

update guidance_rules set
  message = 'Good to see you again. Skip the guilt — check in, look at your next quest, and do one small thing today.',
  cta_label = 'Check in', cta_href = '/dashboard/checkin'
 where key = 'back_after_14';

update guidance_rules set cta_href = '/dashboard'
 where key = 'sprint_ended';

update guidance_rules set conditions = '{"has_path": true}'::jsonb
 where key = 'review_someone';

update guidance_rules set
  conditions = '{"level": 1, "has_path": true}'::jsonb,
  message = 'Next rung — Level 2: complete "Validate your idea" and get 3 real feedback sessions. The peer-review queue is the fastest way to the second one.',
  cta_href = '/quests'
 where key = 'rung_to_2';

-- 3. Trophies and level text -------------------------------------------------
update predefined_milestones set is_active = false
 where slug in ('questionnaire_done', 'first_idea', 'idea_cut_early', 'signals_3',
                'idea_fit_3', 'idea_fit_4', 'idea_fit_5', 'blueprint_created');

update founder_levels set
  unlock_text = 'Welcome. You picked a path — now take on your first quests, get real feedback, and put your idea in front of people.'
 where level = 1;

commit;
