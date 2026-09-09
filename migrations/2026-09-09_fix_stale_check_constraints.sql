-- The path chooser could not save.
--
-- Choosing anything except "Still figuring it out" and pressing Continue
-- reloaded step 1, with no error shown anywhere.
--
-- Cause: questionnaire_responses_founder_path_chk still listed the ORIGINAL
-- three-stage model — 'existing', 'idea', 'exploring' — from before the product
-- was rebuilt around nine paths. Eight of the nine slugs the form offers were
-- rejected by the database. 'exploring' survived the rename by coincidence,
-- which is why the one member who ever got through has that path, and why this
-- went unnoticed: the only person to complete onboarding picked the one path
-- that still passed.
--
-- The UPDATE raised a check violation, src/routes/questionnaire.js did not read
-- the error, and it redirected to step 2 regardless; the GET for step 2 saw
-- founder_path still null and sent the member back to step 1. A silent loop.
--
-- Second landmine on the same table, which would have blocked the very next
-- screen: readiness_score is written by readinessScore() as a PERCENTAGE
-- (Math.round(100 * done / all.length) — so 0-100), while the constraint
-- demanded 1-5 from an older scoring scheme. Completing the core would have
-- failed the same silent way, including 0 for an empty run.
--
-- Third, not on the onboarding path but the same class of drift:
-- profiles_founder_stage_check allows lowercase 'exploring'/'ideating'/... while
-- views/profile_edit.ejs has offered 'Dreaming'/'Validating'/... for a long
-- time. Saving that field from the profile editor could never have worked.

alter table questionnaire_responses
  drop constraint if exists questionnaire_responses_founder_path_chk;

alter table questionnaire_responses
  add constraint questionnaire_responses_founder_path_chk
  check (
    founder_path is null
    or founder_path = any (array[
      'creator', 'freelancer', 'consultant', 'local_service', 'brick_mortar',
      'online_store', 'physical_product', 'software', 'exploring'
    ])
  );

comment on constraint questionnaire_responses_founder_path_chk on questionnaire_responses is
  'The nine path slugs in src/paths.js PATHS. This list is a SNAPSHOT and has drifted once already — it still held the pre-rewrite stage names months after the paths shipped, which silently broke onboarding for eight of nine paths. test/paths.js now fails if src/paths.js and this list disagree, so adding a path without shipping a migration is caught before deploy.';

alter table questionnaire_responses
  drop constraint if exists questionnaire_responses_readiness_score_check;

alter table questionnaire_responses
  add constraint questionnaire_responses_readiness_score_check
  check (readiness_score is null or (readiness_score >= 0 and readiness_score <= 100));

comment on column questionnaire_responses.readiness_score is
  'How much of this path''s own question set has been answered, as a PERCENTAGE (0-100). Written by readinessScore() in src/routes/questionnaire.js. The constraint demanded 1-5 until 2026-09-09, left over from an earlier five-point scheme.';

-- The profile editor's own six words, plus the five legacy values so existing
-- rows stay valid.
alter table profiles drop constraint if exists profiles_founder_stage_check;
alter table profiles add constraint profiles_founder_stage_check
  check (
    founder_stage is null
    or founder_stage = any (array[
      'Dreaming', 'Validating', 'Building', 'Launched', 'Growing', 'Scaling',
      'exploring', 'ideating', 'building', 'launched', 'scaling'
    ])
  );

comment on constraint profiles_founder_stage_check on profiles is
  'The six options in views/profile_edit.ejs, plus the five lowercase legacy values so existing rows stay valid. Before 2026-09-09 it accepted only the legacy set, so saving the field from the profile editor always failed.';
