-- Applied 2026-09-02. The fit test is now built from a curated library matched
-- to the founder's answers, with the model asked only for whatever gap is left.
--
-- Before this the model invented all five criteria on every Compass draw. Two
-- founders with identical answers could get different tests, nobody ever
-- reviewed the wording, and — because the model wrote them untyped — every
-- criterion had to be graded by opinion rather than arithmetic.
--
-- A library row carries its own check/metric/op, so it arrives ready to be
-- graded in code by src/fit.js. That is the difference between a score that
-- holds still between advisor runs and one that drifts.
--
-- applies_when is matched against the derived facts in src/fit_library.js
-- (founderFacts): budgets and hours arrive as buckets ("$500-2,000", "10-20"),
-- so they are turned into numbers first, always taking the TOP of the bucket —
-- a founder who picked "$500-2,000" has up to $2,000, and holding them to $500
-- would invent a constraint they never stated.
--
-- criterion/why carry {budget}, {hours}, {weeks} placeholders bound to the
-- founder's own numbers, so one row serves every tier. value_from names which
-- number supplies a numeric threshold. A numeric row whose threshold cannot be
-- resolved is DROPPED, never quietly downgraded to judgement.
create table if not exists fit_criteria_library (
  slug text primary key,
  criterion text not null,
  why text,
  check_kind text not null default 'judgment',   -- numeric | boolean | judgment
  metric text,                                   -- startup_cost | time_to_revenue
  op text,                                       -- lte | gte | lt | gt
  value_from text,                               -- launch_budget_usd | revenue_deadline_weeks | hours_per_week
  value numeric,                                 -- static fallback threshold
  applies_when jsonb not null default '{}'::jsonb,
  category text not null,                        -- one criterion per category, so a founder
                                                 -- is not asked about money five ways
  priority smallint not null default 50,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table fit_criteria_library enable row level security;
-- Catalog content: readable by anyone signed in, written only through the
-- service role. Nobody edits their own fit test into existence.
drop policy if exists fit_criteria_library_read on fit_criteria_library;
create policy fit_criteria_library_read on fit_criteria_library for select using (true);
create index if not exists fit_criteria_library_active_idx on fit_criteria_library (is_active, priority desc);

-- The seeded rows themselves are long; they live in
-- test/fit-library-snapshot.json, which mirrors this table exactly. Verify the
-- mirror after any edit — it must match the fingerprint test/fit-library.js
-- prints:
--
--   select count(*), md5(string_agg(
--     slug||'|'||criterion||'|'||check_kind||'|'||coalesce(metric,'')||'|'
--     ||coalesce(op,'')||'|'||coalesce(value_from,'')||'|'
--     ||coalesce((value::float8)::text,'')||'|'||category||'|'||priority::text,
--     E'\n' order by slug))
--   from fit_criteria_library where is_active;
--
-- To re-seed from the snapshot, insert each row with an
-- `on conflict (slug) do update` so re-running is a no-op.
