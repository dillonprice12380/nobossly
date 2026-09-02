-- Applied 2026-09-02. Level 1 becomes a refinement loop rather than a one-shot
-- draft. All statements are idempotent; re-running is a no-op.
--
-- The advisor already returned fit_results (five pass/fail verdicts against the
-- founder's OWN fit test), sharper_version and considerations on every run, all
-- written to generated_ideas.advisor and rendered nowhere. This turns that into
-- the scoreboard and keeps the history so improvement is visible.

-- ---------- schema ----------
alter table generated_ideas add column if not exists fit_passed smallint;
alter table generated_ideas add column if not exists fit_total smallint;
-- The high-water mark, never lowered: revising into a worse score must not take
-- back a trophy already earned. This is what the trophies read.
alter table generated_ideas add column if not exists best_fit_passed smallint;
alter table generated_ideas add column if not exists revision_count smallint not null default 0;
alter table generated_ideas add column if not exists cut_at timestamptz;
alter table generated_ideas add column if not exists cut_reason text;
-- The founder's own words. Only name/tagline/description were ever persisted;
-- problem/customer/monetization went to the advisor and were discarded, so there
-- was nothing to pre-fill a revision from.
alter table generated_ideas add column if not exists draft jsonb;

create table if not exists idea_versions (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references generated_ideas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version_no smallint not null,
  draft jsonb, advisor jsonb,
  fit_passed smallint, fit_total smallint, success_likelihood smallint,
  created_at timestamptz not null default now(),
  unique (idea_id, version_no)
);
create index if not exists idea_versions_idea_idx on idea_versions (idea_id, version_no);
alter table idea_versions enable row level security;

create table if not exists idea_signals (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references generated_ideas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'founder',   -- 'founder' | 'ai'
  claim text not null, url text, strength text,
  created_at timestamptz not null default now()
);
create index if not exists idea_signals_idea_idx on idea_signals (idea_id);
alter table idea_signals enable row level security;

do $$
declare t text;
begin
  foreach t in array array['idea_versions','idea_signals'] loop
    execute format('drop policy if exists %I on %I', t || '_own', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for select using (auth.uid() = user_id)', t || '_own', t);
    execute format('create policy %I on %I for insert with check (auth.uid() = user_id)', t || '_insert', t);
    execute format('create policy %I on %I for update using (auth.uid() = user_id)', t || '_update', t);
    execute format('create policy %I on %I for delete using (auth.uid() = user_id)', t || '_delete', t);
  end loop;
end $$;

-- ---------- trophies ----------
-- Thresholds, not per-run rewards: paying XP for each advisor pass would train
-- fiddling and could be farmed. These read best_fit_passed, so each fires once.
insert into predefined_milestones (slug, title, description, emoji, category, xp_reward, position, is_active, auto_kind, auto_target, is_claimable)
values
  ('idea_fit_3', 'Idea Holds Up', 'Your idea passed 3 of the 5 criteria on your own fit test.', '🧩', 'foundation', 20, 0, true, 'idea_fit', 3, false),
  ('idea_fit_4', 'Sharpened', 'Four of five. You revised against the advisor and the score moved.', '🔪', 'foundation', 30, 0, true, 'idea_fit', 4, false),
  ('idea_fit_5', 'Passes Your Own Test', 'Five of five against the fit test your own Compass wrote. Level 1 is done.', '🎯', 'foundation', 50, 0, true, 'idea_fit', 5, false),
  -- Every other platform pushes you to keep polishing a bad idea. Dropping one
  -- on the evidence is the harder and better call, so it pays like a threshold.
  ('idea_cut_early', 'Cut It Early', 'Dropped an idea that did not hold up, and wrote down why. The judgement is the win.', '✂️', 'foundation', 40, 0, true, 'ideas_cut', 1, false),
  ('signals_3', 'Three Real Signals', 'Gathered three pieces of evidence that people want this — at least one you found yourself.', '📡', 'foundation', 30, 0, true, 'signals', 3, false)
on conflict (slug) do update set
  title = excluded.title, description = excluded.description, emoji = excluded.emoji,
  category = excluded.category, xp_reward = excluded.xp_reward, is_active = true,
  auto_kind = excluded.auto_kind, auto_target = excluded.auto_target, is_claimable = excluded.is_claimable;

-- ---------- the ladder ----------
-- Level 1 ends when the idea survives contact, not when a blueprint exists.
-- "Blueprint Built" demanded a full launch document — a paid artefact — before
-- the idea had been pressure-tested. It moves to Level 3, ahead of its sprint.
update founder_levels set requirements = '{"quests":[
  {"type":"milestone","title":"Compass Questions Answered"},
  {"type":"milestone","title":"Passes Your Own Test"},
  {"type":"milestone","title":"Three Real Signals"},
  {"type":"challenge","title":"Get 3 Feedback Sessions"},
  {"type":"challenge","title":"Validate your idea"}]}'::jsonb where level = 2;

update founder_levels set requirements = '{"quests":[
  {"type":"milestone","title":"Blueprint Built"},
  {"type":"challenge","title":"Ship Something"},
  {"type":"milestone","title":"Sprint 1 Completed"}]}'::jsonb where level = 3;

update founder_levels
   set unlock_text = 'Welcome, Ideator. Answer your Compass questions, draft your idea, then refine it until it passes your own fit test.'
 where level = 1;

-- ---------- the Coach ----------
insert into guidance_rules (key, priority, conditions, message, cta_label, cta_href, category, cooldown_days, active)
values
  ('idea_unscored', 94, '{"live_ideas": {"gte": 1}, "idea_scored": false}'::jsonb,
   'Your idea is saved but the advisor has not scored it yet. Run it and you will get a pass or fail on each of your five fit-test criteria, with the reason.',
   'Score my idea', '/ideas', 'onboarding', 1, true),
  ('idea_refine', 93, '{"idea_scored": true, "fit_complete": false}'::jsonb,
   'Your idea passes {fit_passed} of {fit_total} on your own fit test. {fit_gap} to go — change what the advisor pushed back on and re-run it. That is Level 1.',
   'Revise my idea', '/ideas', 'onboarding', 1, true),
  ('idea_needs_signals', 92, '{"fit_complete": true, "signals_count": {"lt": 3}}'::jsonb,
   'Your idea passes its own fit test. Now prove someone wants it: three real demand signals, at least one you found yourself. You have {signals_count}.',
   'Add a signal', '/ideas', 'onboarding', 1, true),
  ('idea_ready_for_blueprint', 91, '{"fit_complete": true, "signals_count": {"gte": 3}, "has_blueprint": false}'::jsonb,
   'Fit test passed and the demand is evidenced. This idea has earned its launch blueprint.',
   'Build my blueprint', '/ideas', 'onboarding', 2, true)
on conflict (key) do update set
  priority = excluded.priority, conditions = excluded.conditions, message = excluded.message,
  cta_label = excluded.cta_label, cta_href = excluded.cta_href, category = excluded.category,
  cooldown_days = excluded.cooldown_days, active = true;

-- Counted every idea row, so cutting your only idea left you with no prompt.
update guidance_rules set conditions = '{"has_compass": true, "live_ideas": 0}'::jsonb where key = 'compass_no_idea';
-- Told founders to blueprint an idea that had not been tested; superseded.
update guidance_rules set active = false where key = 'idea_no_blueprint_paid';

-- test/level1-loop.js keeps a copy of the loop rules (anon RLS blocks reading
-- them with the publishable key). After editing a rule above, re-check the copy:
--
--   select key, priority, conditions::text from guidance_rules
--    where active and key in ('no_questionnaire','no_compass','compass_no_idea',
--          'idea_unscored','idea_refine','idea_needs_signals','idea_ready_for_blueprint')
--    order by priority desc;
