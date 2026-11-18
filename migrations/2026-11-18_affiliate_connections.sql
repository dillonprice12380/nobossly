-- Applied live 2026-11-18 (run in the SQL Editor; returned true. Verified: the 8 networks in the provider check, payment_connections.pending readable but not writable by members, payment_connection_store takes them and stays service-role only).
--
-- Affiliate networks in the income log (2026-11-18). A member connects their
-- own affiliate accounts (impact.com, CJ, Awin, Rakuten, PartnerStack,
-- ClickBank, Travelpayouts, Admitad) beside Stripe, Shopify, Gumroad and
-- Square in payment_connections, one each. What they paste is checked by the
-- server, then kept in Supabase Vault by payment_connection_store(), which
-- only the service role may call (migrations/2026-11-09_more_connections.sql).
--
--  * Approved commissions go into the income log; reversed ones that were
--    logged come back out.
--  * Pending commissions are not income yet. Their total sits on the
--    connection (payment_connections.pending, { amounts: { USD: 12.5 },
--    count, as_of }) so the member can see what is on the way. They can read
--    it; only the server writes it.

begin;

alter table public.payment_connections drop constraint if exists payment_connections_provider_check;
alter table public.payment_connections add constraint payment_connections_provider_check
  check (provider in ('stripe', 'shopify', 'gumroad', 'square',
                      'impact', 'cj', 'awin', 'rakuten', 'partnerstack', 'clickbank', 'travelpayouts', 'admitad'));

alter table public.payment_connections add column if not exists pending jsonb
  check (pending is null or (jsonb_typeof(pending) = 'object' and pg_column_size(pending) <= 2000));
grant select (pending) on public.payment_connections to authenticated;

create or replace function public.payment_connection_store(p_user uuid, p_provider text, p_secret text, p_label text, p_meta jsonb)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  conn public.payment_connections;
  sid uuid;
  s text := coalesce(p_secret, '');
begin
  if p_provider not in ('shopify', 'gumroad', 'square',
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
    set account_label = excluded.account_label, meta = excluded.meta, secret_id = excluded.secret_id, status = 'active', last_error = null
  returning id into conn.id;
  return conn.id;
end $function$;
revoke all on function public.payment_connection_store(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_connection_store(uuid, text, text, text, jsonb) to service_role;

commit;

select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'payment_connections' and column_name = 'pending') = 1
   and pg_get_constraintdef((select oid from pg_constraint where conname = 'payment_connections_provider_check')) like '%travelpayouts%'
   and not has_function_privilege('authenticated', 'public.payment_connection_store(uuid, text, text, text, jsonb)', 'execute') as ok;
