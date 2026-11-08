-- Applied live 2026-11-08 (run in the SQL Editor; returned true).
--
-- Pin and hide workspace tools (2026-11-08). A member can pin the tools they
-- use most to the top of the workspace and hide the ones they never open;
-- their choice is kept on their profile as { "pinned": [...], "hidden": [...] }
-- (src/workspace_hub.js). Null means nothing pinned or hidden. Members already
-- update their own profile row (protect_profile_fields covers billing, XP and
-- admin fields only), so no new grant or policy is needed.

alter table public.profiles add column if not exists workspace_layout jsonb
  check (workspace_layout is null
         or (jsonb_typeof(workspace_layout) = 'object' and pg_column_size(workspace_layout) <= 4000));

select exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'profiles' and column_name = 'workspace_layout') as ok;
