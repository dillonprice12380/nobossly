-- NOT APPLIED
--
-- Connect Stripe to the income log (2026-11-08). A member pastes a read-only
-- restricted key (rk_live_…) they made in their own Stripe dashboard; NoBossly
-- reads their succeeded charges every few hours and logs them as income
-- (src/stripe_sync.js). Stripe has banned third parties from asking for full
-- secret keys (sk_…) since 2024-09-30; restricted keys are an approved route,
-- and a read-only one cannot refund, pay out or change anything.
--
--  * The key is stored in Supabase Vault, encrypted. Members can see that they
--    are connected (and the last four characters of the key) but can never
--    read the key back, not even their own.
--  * Only the server's sync job (service role) can read a key, through
--    payment_connection_secret().
--  * Connecting and disconnecting go through functions; members cannot write
--    the table directly. Disconnecting deletes the key from the Vault. The
--    payments already logged stay in the income log.
--  * revenue_entries.external_id ('stripe:ch_…') makes a Stripe payment
--    impossible to log twice.

begin;

-- 1. A payment's id at the provider, so syncing never logs it twice.
alter table public.revenue_entries add column if not exists external_id text
  check (external_id is null or char_length(external_id) <= 120);
-- A plain unique constraint (not a partial index) so the sync's upsert can use
-- ON CONFLICT (user_id, external_id); rows with no id are null, and nulls are
-- distinct, so hand-logged payments are unaffected.
do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'revenue_entries_external') then
    alter table public.revenue_entries add constraint revenue_entries_external unique (user_id, external_id);
  end if;
end $do$;

-- 2. Connections.
create table if not exists public.payment_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  provider       text not null check (provider in ('stripe')),
  key_hint       text check (key_hint is null or char_length(key_hint) <= 12),
  secret_id      uuid,
  status         text not null default 'active' check (status in ('active', 'error')),
  last_error     text check (last_error is null or char_length(last_error) <= 300),
  last_synced_at timestamptz,
  synced_through timestamptz,
  imported_count integer not null default 0,
  created_at     timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.payment_connections enable row level security;
revoke all on public.payment_connections from anon, authenticated;
-- The server's sync job writes status, sync times and counts.
grant select, update on public.payment_connections to service_role;
-- Members read their own connection, minus where the key lives.
grant select (id, user_id, provider, key_hint, status, last_error, last_synced_at, synced_through, imported_count, created_at)
  on public.payment_connections to authenticated;
drop policy if exists payment_connections_own on public.payment_connections;
create policy payment_connections_own on public.payment_connections
  for select to authenticated using (user_id = auth.uid());

-- 3. Connect (or replace the key). Live restricted keys only.
create or replace function public.payment_connect_stripe(p_key text)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  k text := btrim(coalesce(p_key, ''));
  conn public.payment_connections;
  sid uuid;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if k !~ '^rk_live_[A-Za-z0-9]{20,200}$' then
    raise exception 'only a live restricted key (rk_live_...) can be connected';
  end if;
  select * into conn from public.payment_connections where user_id = uid and provider = 'stripe' for update;
  if found and conn.secret_id is not null then
    perform vault.update_secret(conn.secret_id, k);
    sid := conn.secret_id;
  else
    sid := vault.create_secret(k, 'payment_connection_stripe_' || uid::text, 'Read-only Stripe key for a NoBossly member');
  end if;
  insert into public.payment_connections (user_id, provider, key_hint, secret_id, status, last_error)
  values (uid, 'stripe', right(k, 4), sid, 'active', null)
  on conflict (user_id, provider) do update
    set key_hint = excluded.key_hint, secret_id = excluded.secret_id, status = 'active', last_error = null
  returning id into conn.id;
  return conn.id;
end $function$;

-- 4. Disconnect: the key leaves the Vault; the payments already logged stay.
create or replace function public.payment_disconnect(p_provider text)
returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  conn public.payment_connections;
begin
  if uid is null then raise exception 'sign in first'; end if;
  select * into conn from public.payment_connections where user_id = uid and provider = p_provider for update;
  if not found then return false; end if;
  if conn.secret_id is not null then delete from vault.secrets where id = conn.secret_id; end if;
  delete from public.payment_connections where id = conn.id;
  return true;
end $function$;

-- 5. The key, for the server's sync job only.
create or replace function public.payment_connection_secret(p_id uuid)
returns text language sql security definer set search_path to 'public'
as $function$
  select s.decrypted_secret from vault.decrypted_secrets s
    join public.payment_connections c on c.secret_id = s.id
   where c.id = p_id
$function$;

revoke all on function public.payment_connect_stripe(text) from public, anon;
revoke all on function public.payment_disconnect(text) from public, anon;
revoke all on function public.payment_connection_secret(uuid) from public, anon, authenticated;
grant execute on function public.payment_connect_stripe(text) to authenticated;
grant execute on function public.payment_disconnect(text) to authenticated;
grant execute on function public.payment_connection_secret(uuid) to service_role;

commit;

select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'revenue_entries' and column_name = 'external_id') = 1
   and to_regclass('public.payment_connections') is not null
   and not has_function_privilege('authenticated', 'public.payment_connection_secret(uuid)', 'execute') as ok;
