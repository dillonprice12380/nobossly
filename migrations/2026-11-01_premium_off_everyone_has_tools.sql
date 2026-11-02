-- Applied live 2026-11-01 (verified 2026-11-02: has_premium() returns true for every active profile).
-- It was needed with the Phase 0 deploy: without it, premium_save() refused tool
-- saves from members without a subscription, though the site opened the tools to everyone.
--
-- has_premium() decides who may save tool data (premium_save) and whose Proof
-- Page is public (proof_page). Premium is off, so it answers the way
-- is_paid_member() already does since 2026-10-31: every active member counts.
--
-- The subscription columns on profiles, pricing_tiers, and the Stripe/PayPal
-- setup are untouched. When a paid tier returns, restore the previous body
-- (2026-09-25_premium_tools_and_pricing.sql) alongside FLAGS.premium = true.

create or replace function public.has_premium(p_user uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from profiles p
     where p.id = p_user and coalesce(p.account_status, 'active') = 'active'
  );
$function$;

revoke all on function public.has_premium(uuid) from public, anon;
grant execute on function public.has_premium(uuid) to authenticated;
