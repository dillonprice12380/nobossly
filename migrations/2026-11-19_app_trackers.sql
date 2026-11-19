-- Applied live 2026-11-19 (run in the SQL Editor; returned true. Verified: app_tracker_days with RLS on, members read but cannot write, anon reads nothing, data_connections.config allows up to 12000 bytes).
--
-- App data, round 2 (2026-11-19): a member chooses what to track in their
-- app's database, not just one users table. Each tracker is a table (and
-- optionally only the rows where one column has one value, e.g. role =
-- 'employer'), counted every few hours: how many there are, how many are new
-- each day if it has a date column, and how many were active if it has a
-- last-active column. Sign-ups (job seekers, employers) and inventory (job
-- posts, blog posts) are both trackers.
--
--  * app_tracker_days: one row per connection, tracker and day, written by the
--    server's sync. Members read their own. app_metrics stays for the counts
--    already taken; new counts go here.

begin;

create table if not exists public.app_tracker_days (
  connection_id uuid not null references public.data_connections(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  tracker       text not null check (tracker ~ '^[a-z0-9_]{1,24}$'),
  day           date not null,
  total         bigint check (total is null or total >= 0),
  new_items     integer check (new_items is null or new_items >= 0),
  active_7d     integer check (active_7d is null or active_7d >= 0),
  active_30d    integer check (active_30d is null or active_30d >= 0),
  primary key (connection_id, tracker, day)
);
create index if not exists app_tracker_days_owner on public.app_tracker_days (user_id, day);
alter table public.app_tracker_days enable row level security;
revoke all on public.app_tracker_days from anon, authenticated;
grant select, insert, update, delete on public.app_tracker_days to service_role;
grant select on public.app_tracker_days to authenticated;
drop policy if exists app_tracker_days_own on public.app_tracker_days;
create policy app_tracker_days_own on public.app_tracker_days for select to authenticated using (user_id = auth.uid());

-- What a member chooses to track can be longer now (up to twelve trackers).
alter table public.data_connections drop constraint if exists data_connections_config_check;
alter table public.data_connections add constraint data_connections_config_check
  check (config is null or (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 12000));

commit;

select to_regclass('public.app_tracker_days') is not null
   and (select relrowsecurity from pg_class where oid = 'public.app_tracker_days'::regclass)
   and not has_table_privilege('authenticated', 'public.app_tracker_days', 'insert')
   and has_table_privilege('authenticated', 'public.app_tracker_days', 'select') as ok;
