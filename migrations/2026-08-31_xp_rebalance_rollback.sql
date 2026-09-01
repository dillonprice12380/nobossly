-- ROLLBACK for the XP rebalance applied 31 Aug 2026
-- (migration: rebalance_xp_toward_real_achievement).
--
-- Run this only if you want the old economy back. It restores every xp_reward
-- to its pre-rebalance value. It does NOT remove the seven claimable milestones
-- added by repair_founder_ladder_claimable_milestones — those fix a ladder that
-- was hard-capped at Level 4, and reverting them re-breaks levels 5, 6, 8, 9
-- and 10. Roll those back separately and deliberately (bottom of this file).
--
-- What changed and why, for reference:
--
--   Internal-activity trophies   3,025 -> 920 XP   (cut ~70%)
--   Proof-gated challenges       1,925 -> 4,350 XP (raised)
--   New real-world milestones        0 -> 3,700 XP (added)
--   Honor challenges               915 -> 915 XP   (unchanged)
--
--   "Make your first sale"         150 -> 600 XP
--   Task + streak + check-in trophies combined: 1,425 -> 430 XP
--
-- Before, a month of check-ins (450 XP) paid three times what your first
-- paying customer did (150 XP). Level thresholds were not touched; total
-- non-repeating supply is ~9,885 XP against 6,000 for Level 10.

BEGIN;

-- Auto-measured trophies, back to their original values.
UPDATE public.predefined_milestones SET xp_reward = v.xp
FROM (VALUES
  ('tasks',           1,   75), ('tasks',          10,  150),
  ('tasks',          25,  150), ('tasks',          50,  200),
  ('tasks',         100,  200),
  ('challenges',      1,  100), ('challenges',      5,  150),
  ('challenges',     10,  250),
  ('streak',          3,   90), ('streak',          7,  200),
  ('streak',         30,  350),
  ('posts',           1,   50), ('posts',          10,   75),
  ('followers',       1,   50), ('followers',      10,   50),
  ('sprints_done',    1,  200), ('sprints_done',    5,  300),
  ('sprints_started', 1,   75),
  ('profile',         1,   50),
  ('checkins',        1,   10),
  ('ideas',           1,  100),
  ('blueprints',      1,  150)
) AS v(kind, target, xp)
WHERE predefined_milestones.auto_kind = v.kind
  AND predefined_milestones.auto_target = v.target;

-- Proof-gated challenges, back to their original values.
UPDATE public.challenges SET xp_reward = v.xp
FROM (VALUES
  ('Validate your idea',         75),
  ('Get 3 Feedback Sessions',    75),
  ('Ship Something',             50),
  ('5 Customer Conversations',  300),
  ('Do 25 outreach touches',     75),
  ('Make your first sale',      150),
  ('Earn Your First $100',      500),
  ('Collect 5 testimonials',     75),
  ('Reach 10 paying customers', 200),
  ('Automate one process',       75),
  ('Hit a $1k month',           250),
  ('Document your playbook',    100)
) AS v(title, xp)
WHERE challenges.title = v.title;

COMMIT;


-- ---------------------------------------------------------------------------
-- Separate, and NOT recommended: removing the ladder repair.
-- This re-breaks levels 5, 6, 8, 9 and 10 — including Level 5 "first sale",
-- the product's headline promise. Only run it if you are replacing those
-- milestones with a different mechanism.
-- ---------------------------------------------------------------------------
-- UPDATE public.predefined_milestones SET is_active = false
--  WHERE slug IN ('registered-my-business','opened-business-bank-account',
--                 'built-a-pitch-deck','first-profitable-month','1k-mrr',
--                 'completed-an-accelerator','went-full-time');
--
-- The unique index on user_milestones is an integrity fix, not part of the
-- rebalance — it stops a concurrent sweep double-awarding a trophy and its XP.
-- Keep it.
--   DROP INDEX IF EXISTS public.user_milestones_unique_predefined;
