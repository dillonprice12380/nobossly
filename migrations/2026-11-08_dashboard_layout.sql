-- NOT APPLIED
--
-- Customize the dashboard (2026-11-08). A member can reorder and hide the
-- dashboard's sections; their choice is kept on their profile as
-- { "order": [...], "hidden": [...] } (src/dashboard_layout.js). Null means the
-- default layout. Members already update their own profile row (policy and
-- the protect_profile_fields trigger cover billing, XP and admin fields only),
-- so no new grant or policy is needed.

alter table public.profiles add column if not exists dashboard_layout jsonb
  check (dashboard_layout is null
         or (jsonb_typeof(dashboard_layout) = 'object' and pg_column_size(dashboard_layout) <= 2000));

select exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'profiles' and column_name = 'dashboard_layout') as ok;
