-- NOT APPLIED. Run in the Supabase SQL Editor; it ends with one row, ok = true.
--
-- One-click connections (2026-11-18): "Connect with …" sign-ins instead of
-- pasting keys, where a provider offers it.
--
--  * data_connections.kind gains 'supabase' (read through Supabase's own
--    read-only query endpoint after a Supabase sign-in) and 'planetscale' (a
--    sign-in waiting for the member to pick a database; NoBossly then makes a
--    read-only password there and the connection becomes 'mysql' or 'postgres').
--  * data_connection_set_secret(id, secret): the server replaces a
--    connection's secret in place, e.g. when a sign-in's refresh token rotates,
--    without resetting what the member chose to count. Service role only.
--  * payment_connection_store() also takes 'stripe', for "Connect with Stripe"
--    (a Stripe App with read-only permissions) beside the pasted restricted key.

begin;

alter table public.data_connections drop constraint if exists data_connections_kind_check;
alter table public.data_connections add constraint data_connections_kind_check
  check (kind in ('postgres', 'mysql', 'firebase', 'wordpress', 'supabase', 'planetscale'));

create or replace function public.data_connection_store(p_id uuid, p_user uuid, p_kind text, p_provider text, p_label text, p_host text, p_secret text)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  c public.data_connections;
  sid uuid;
  s text := coalesce(p_secret, '');
begin
  if p_kind not in ('postgres', 'mysql', 'firebase', 'wordpress', 'supabase', 'planetscale') then raise exception 'unknown kind'; end if;
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

create or replace function public.data_connection_set_secret(p_id uuid, p_secret text)
returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare
  c public.data_connections;
begin
  if char_length(coalesce(p_secret, '')) < 8 or char_length(p_secret) > 8000 then raise exception 'that secret does not look right'; end if;
  select * into c from public.data_connections where id = p_id for update;
  if not found or c.secret_id is null then return false; end if;
  perform vault.update_secret(c.secret_id, p_secret);
  return true;
end $function$;

create or replace function public.payment_connection_store(p_user uuid, p_provider text, p_secret text, p_label text, p_meta jsonb)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  conn public.payment_connections;
  sid uuid;
  s text := coalesce(p_secret, '');
begin
  if p_provider not in ('stripe', 'shopify', 'gumroad', 'square',
                        'impact', 'cj', 'awin', 'rakuten', 'partnerstack', 'clickbank', 'travelpayouts', 'admitad') then
    raise exception 'unknown provider';
  end if;
  if char_length(s) < 8 or char_length(s) > 4000 then raise exception 'that secret does not look right'; end if;
  select * into conn from public.payment_connections where user_id = p_user and provider = p_provider for update;
  if found and conn.secret_id is not null then
    perform vault.update_secret(conn.secret_id, s);
    sid := conn.secret_id;
  else
    sid := vault.create_secret(s, 'payment_connection_' || p_provider || '_' || p_user::text, 'Read-only ' || p_provider || ' access for a NoBossly member');
  end if;
  insert into public.payment_connections (user_id, provider, key_hint, account_label, meta, secret_id, status, last_error)
  values (p_user, p_provider, null, left(p_label, 80), p_meta, sid, 'active', null)
  on conflict (user_id, provider) do update
    set account_label = excluded.account_label, meta = excluded.meta, secret_id = excluded.secret_id, key_hint = null, status = 'active', last_error = null
  returning id into conn.id;
  return conn.id;
end $function$;

revoke all on function public.data_connection_store(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.data_connection_set_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.payment_connection_store(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.data_connection_store(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.data_connection_set_secret(uuid, text) to service_role;
grant execute on function public.payment_connection_store(uuid, text, text, text, jsonb) to service_role;

commit;

select pg_get_constraintdef((select oid from pg_constraint where conname = 'data_connections_kind_check')) like '%planetscale%'
   and to_regprocedure('public.data_connection_set_secret(uuid, text)') is not null
   and not has_function_privilege('authenticated', 'public.data_connection_set_secret(uuid, text)', 'execute')
   and (select pg_get_functiondef(oid) like '%''stripe'', ''shopify''%' from pg_proc where proname = 'payment_connection_store') as ok;
