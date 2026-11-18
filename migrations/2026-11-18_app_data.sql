-- NOT APPLIED. Run in the Supabase SQL Editor; it ends with one row, ok = true.
--
-- App data (2026-11-18): a member who builds an app connects their app's own
-- database (Supabase, Neon or any Postgres, MySQL/PlanetScale, Firebase, or a
-- WordPress site) so NoBossly can count its users: total, new each day, and
-- active in the last 7 and 30 days.
--
--  * data_connections: up to three per member. What they paste (a read-only
--    connection string, a service-account key, an application password) is
--    checked by the server, then kept in Supabase Vault by
--    data_connection_store(), which only the service role may call. Members
--    read their own connections, never where the secret lives.
--  * app_metrics: one row per connection per day, written by the server's sync.
--    Members read their own.
--  * data_disconnect(id): the member's own; the secret leaves the Vault and the
--    numbers go with the connection.

begin;

create table if not exists public.data_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('postgres', 'mysql', 'firebase', 'wordpress')),
  provider       text check (provider is null or provider ~ '^[a-z0-9_]{2,30}$'),
  label          text check (label is null or char_length(label) <= 80),
  host_label     text check (host_label is null or char_length(host_label) <= 120),
  config         jsonb check (config is null or (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 4000)),
  secret_id      uuid,
  status         text not null default 'setup' check (status in ('setup', 'active', 'error')),
  last_error     text check (last_error is null or char_length(last_error) <= 300),
  last_synced_at timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists data_connections_owner on public.data_connections (user_id);
alter table public.data_connections enable row level security;
revoke all on public.data_connections from anon, authenticated;
grant select, insert, update, delete on public.data_connections to service_role;
grant select (id, user_id, kind, provider, label, host_label, config, status, last_error, last_synced_at, created_at)
  on public.data_connections to authenticated;
drop policy if exists data_connections_own on public.data_connections;
create policy data_connections_own on public.data_connections for select to authenticated using (user_id = auth.uid());

create table if not exists public.app_metrics (
  connection_id uuid not null references public.data_connections(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  day           date not null,
  total_users   integer check (total_users is null or total_users >= 0),
  new_users     integer check (new_users is null or new_users >= 0),
  active_7d     integer check (active_7d is null or active_7d >= 0),
  active_30d    integer check (active_30d is null or active_30d >= 0),
  primary key (connection_id, day)
);
create index if not exists app_metrics_owner on public.app_metrics (user_id, day);
alter table public.app_metrics enable row level security;
revoke all on public.app_metrics from anon, authenticated;
grant select, insert, update, delete on public.app_metrics to service_role;
grant select on public.app_metrics to authenticated;
drop policy if exists app_metrics_own on public.app_metrics;
create policy app_metrics_own on public.app_metrics for select to authenticated using (user_id = auth.uid());

-- The server stores (or replaces) a connection once it has checked it.
create or replace function public.data_connection_store(p_id uuid, p_user uuid, p_kind text, p_provider text, p_label text, p_host text, p_secret text)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  c public.data_connections;
  sid uuid;
  s text := coalesce(p_secret, '');
begin
  if p_kind not in ('postgres', 'mysql', 'firebase', 'wordpress') then raise exception 'unknown kind'; end if;
  if char_length(s) < 8 or char_length(s) > 8000 then raise exception 'that secret does not look right'; end if;
  if p_id is not null then
    select * into c from public.data_connections where id = p_id and user_id = p_user for update;
    if not found then raise exception 'no such connection'; end if;
    perform vault.update_secret(c.secret_id, s);
    update public.data_connections set kind = p_kind, provider = p_provider, label = left(p_label, 80), host_label = left(p_host, 120),
      config = null, status = 'setup', last_error = null where id = c.id;
    return c.id;
  end if;
  if (select count(*) from public.data_connections where user_id = p_user) >= 3 then raise exception 'three app databases at most'; end if;
  sid := vault.create_secret(s, 'data_connection_' || gen_random_uuid()::text, 'Read-only app database access for a NoBossly member');
  insert into public.data_connections (user_id, kind, provider, label, host_label, secret_id, status)
  values (p_user, p_kind, p_provider, left(p_label, 80), left(p_host, 120), sid, 'setup')
  returning id into c.id;
  return c.id;
end $function$;

create or replace function public.data_connection_secret(p_id uuid)
returns text language sql security definer set search_path to 'public'
as $function$
  select s.decrypted_secret from vault.decrypted_secrets s
    join public.data_connections c on c.secret_id = s.id
   where c.id = p_id
$function$;

create or replace function public.data_disconnect(p_id uuid)
returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  c public.data_connections;
begin
  if uid is null then raise exception 'sign in first'; end if;
  select * into c from public.data_connections where id = p_id and user_id = uid for update;
  if not found then return false; end if;
  if c.secret_id is not null then delete from vault.secrets where id = c.secret_id; end if;
  delete from public.data_connections where id = c.id;
  return true;
end $function$;

revoke all on function public.data_connection_store(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.data_connection_secret(uuid) from public, anon, authenticated;
revoke all on function public.data_disconnect(uuid) from public, anon;
grant execute on function public.data_connection_store(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.data_connection_secret(uuid) to service_role;
grant execute on function public.data_disconnect(uuid) to authenticated;

commit;

select to_regclass('public.data_connections') is not null
   and to_regclass('public.app_metrics') is not null
   and not has_function_privilege('authenticated', 'public.data_connection_secret(uuid)', 'execute')
   and not has_function_privilege('authenticated', 'public.data_connection_store(uuid, uuid, text, text, text, text, text)', 'execute')
   and not has_column_privilege('authenticated', 'public.data_connections', 'secret_id', 'select') as ok;
