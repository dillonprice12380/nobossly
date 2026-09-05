-- Applied 2026-09-04. Onboarding branches on the KIND of business now.
--
-- It used to branch on STAGE — already in business, have an idea, still
-- exploring — and then ask every founder the same generic questions. A content
-- creator and a plumber filled in the same form, which is why the answers were
-- thin enough that the Compass had to guess at everything downstream.
--
-- founder_path holds one of eight business paths (see src/paths.js). Stage is
-- now one question INSIDE each path, phrased in that path's own vocabulary, and
-- derived back out by paths.stageOf(). The two are orthogonal and both matter:
-- a creator with 40k followers and one with none need different questions, and
-- "already running it" is where the most valuable users are.
--
-- The eight: creator, freelancer, consultant, local_service, brick_mortar,
-- online_store, software, exploring.

-- Path-specific answers, rather than sixty-odd new columns. The UNIVERSAL
-- constraint questions — budget, hours, runway, income goal, deal breakers —
-- keep writing to their own columns, because the fit-criteria library matches
-- on exactly those facts and would silently stop working otherwise.
alter table questionnaire_responses add column if not exists path_answers jsonb not null default '{}'::jsonb;

-- Mirrored from the newest completed run so challenge matching and the Coach do
-- not join through the questionnaire on every request.
alter table profiles add column if not exists path text;

-- Curated challenges and fit criteria can both be tagged by path. An empty
-- array means "applies to every path", which is how every pre-existing row
-- stays valid. A path is DECLARED, where business_types is an AI
-- classification of free text — so path is the more trustworthy signal and
-- src/tailor.js sorts path-tagged matches first.
alter table tailored_challenges add column if not exists paths text[] not null default '{}';
create index if not exists tailored_challenges_paths_idx on tailored_challenges using gin (paths);

alter table fit_criteria_library add column if not exists paths text[] not null default '{}';
create index if not exists fit_criteria_library_paths_idx on fit_criteria_library using gin (paths);

-- Two criteria matched on founder_path = 'existing', which used to mean
-- "already in business". founder_path is the business type now, so without this
-- they would match nobody at all.
update fit_criteria_library
   set applies_when = '{"is_running": true}'::jsonb
 where slug in ('builds_on_existing', 'serves_current_customers');

-- The path-specific criteria and curated electives themselves are long; they
-- are recorded in the two migrations applied alongside this one
-- (path_aware_fit_criteria, curated_path_challenges) and mirrored in
-- test/fit-library-snapshot.json. Verify the mirror after any change:
--
--   select count(*), md5(string_agg(
--     slug||'|'||criterion||'|'||check_kind||'|'||coalesce(metric,'')||'|'
--     ||coalesce(op,'')||'|'||coalesce(value_from,'')||'|'
--     ||coalesce((value::float8)::text,'')||'|'||category||'|'||priority::text,
--     E'\n' order by slug))
--   from fit_criteria_library where is_active;
--
-- It must match the fingerprint test/fit-library.js prints (54e5af85 at 39 rows
-- when this was applied).
