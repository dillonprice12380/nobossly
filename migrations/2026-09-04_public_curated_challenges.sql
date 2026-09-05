-- Applied 2026-09-04. Lets the public path landing pages show real challenges.
--
-- The pages at /paths/:slug pull their fit criteria and their challenges LIVE
-- from the same tables the product uses, filtered by the same path tag. Retyping
-- them into marketing copy would guarantee the page and the product drift apart;
-- this way a criterion edited in the library changes the landing page with it.
--
-- fit_criteria_library was already publicly readable (catalog content).
-- tailored_challenges was authenticated-only, so this opens a narrow slice:
-- CURATED rows only. AI-generated ones are written per founder and, although the
-- prompt forbids naming anyone's brand, they have not been read by a human —
-- which is a low bar to clear before putting something on a public page, and one
-- worth keeping.
drop policy if exists tailored_challenges_public_curated on tailored_challenges;
create policy tailored_challenges_public_curated on tailored_challenges
  for select to anon
  using (is_active and source = 'curated');
