-- NoBossly Premium: five standalone tools (Quit-Date Planner, Tax Set-Aside,
-- Pricing & Margin Calculator, Proof Page, Customer Interview Tracker) sold as
-- one bundle — $3.99/month, $38.30/year, or $191.50 once for lifetime access.
-- The community, the ladder and every quest stay free; only these tools are paid.

-- 1. Prices --------------------------------------------------------------------
-- The old Stripe Price IDs were for the old prices ($12/$29/$97/$350). They are
-- cleared so checkout builds the line item inline from price_cents and can
-- never charge an old amount. Paste new Price IDs in /admin/pricing if you
-- create catalog prices in Stripe; inline works without them.
update pricing_tiers set name = 'Premium Monthly', tagline = 'All five premium tools, billed monthly',
  price_cents = 399, interval_label = 'per month', mode = 'subscription',
  stripe_price_id = null, promo_price_cents = null, promo_stripe_price_id = null,
  promo_label = null, promo_ends_at = null, is_active = true, sort = 1
 where key = 'month';
update pricing_tiers set name = 'Premium Annual', tagline = 'Save 20% vs monthly',
  price_cents = 3830, interval_label = 'per year', mode = 'subscription',
  stripe_price_id = null, promo_price_cents = null, promo_stripe_price_id = null,
  promo_label = null, promo_ends_at = null, is_active = true, sort = 2
 where key = 'year';
update pricing_tiers set name = 'Premium Lifetime', tagline = 'One payment. Full access, forever.',
  price_cents = 19150, interval_label = 'one-time', mode = 'payment',
  stripe_price_id = null, promo_price_cents = null, promo_stripe_price_id = null,
  promo_label = null, promo_ends_at = null, is_active = true, sort = 3
 where key = 'lifetime';
update pricing_tiers set is_active = false, stripe_price_id = null where key = 'quarter';

-- 2. Let billing writes through --------------------------------------------------
-- protect_profile_fields() resets subscription_* and is_lifetime on any update
-- not made by an admin. apply_subscription() runs from the Stripe webhook with
-- no signed-in admin, so every subscription it applied was silently reverted.
-- It now flags its own write, and the trigger lets exactly that write through.
-- The trigger also now protects the period end and Stripe IDs, which members
-- could previously edit on their own row.
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  trusted boolean := coalesce(current_setting('app.trusted_write', true), 'off') = 'on';
  billing boolean := coalesce(current_setting('app.billing_write', true), 'off') = 'on';
begin
  if not public.is_admin() then
    new.is_admin := old.is_admin;

    if not billing then
      new.subscription_tier       := old.subscription_tier;
      new.subscription_status     := old.subscription_status;
      new.is_lifetime             := old.is_lifetime;
      new.subscription_period_end := old.subscription_period_end;
      new.stripe_customer_id      := old.stripe_customer_id;
      new.stripe_subscription_id  := old.stripe_subscription_id;
    end if;

    if new.account_status is distinct from old.account_status
       and new.account_status not in ('active', 'deactivated', 'pending_deletion') then
      new.account_status := old.account_status;
    end if;

    if new.verified_level is distinct from old.verified_level
       and (new.verified_level > least(coalesce(new.current_level, 1), 7)
            or coalesce(old.verified_level, 1) > 7) then
      new.verified_level := old.verified_level;
    end if;

    if not trusted then
      new.xp_total                 := old.xp_total;
      new.current_level            := old.current_level;
      new.streak_days              := old.streak_days;
      new.longest_streak           := old.longest_streak;
      new.tasks_completed          := old.tasks_completed;
      new.last_checkin_date        := old.last_checkin_date;
      new.streak_freeze_used_month := old.streak_freeze_used_month;
    end if;
  end if;
  return new;
end $function$;

create or replace function public.apply_subscription(
  p_secret text, p_user uuid, p_tier text, p_status text, p_customer text,
  p_sub_id text, p_period_end timestamptz, p_lifetime boolean)
returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if (select value from app_secrets where key = 'sub_sync') is distinct from p_secret then
    raise exception 'forbidden';
  end if;
  perform set_config('app.billing_write', 'on', true);
  update profiles set
    subscription_tier = coalesce(p_tier, subscription_tier),
    subscription_status = coalesce(p_status, subscription_status),
    subscription_start_date = coalesce(subscription_start_date, now()),
    stripe_customer_id = coalesce(p_customer, stripe_customer_id),
    stripe_subscription_id = coalesce(p_sub_id, stripe_subscription_id),
    subscription_period_end = coalesce(p_period_end, subscription_period_end),
    is_lifetime = (coalesce(is_lifetime, false) or coalesce(p_lifetime, false)),
    updated_at = now()
  where id = p_user;
  perform set_config('app.billing_write', 'off', true);
end $function$;

-- 3. Who has Premium ---------------------------------------------------------
-- Lifetime, admins, or a subscription that is paid up. A cancelled
-- subscription keeps access until its period ends; a failed renewal gets three
-- days' grace while Stripe retries.
create or replace function public.has_premium(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select coalesce((
    select p.is_admin
        or coalesce(p.is_lifetime, false)
        or (p.subscription_status in ('active', 'trialing', 'past_due')
            and (p.subscription_period_end is null or p.subscription_period_end > now() - interval '3 days'))
        or (p.subscription_status = 'canceled'
            and p.subscription_period_end is not null and p.subscription_period_end > now())
      from profiles p where p.id = p_user), false)
$function$;
revoke all on function public.has_premium(uuid) from public;
grant execute on function public.has_premium(uuid) to authenticated;

-- 4. Tool data ---------------------------------------------------------------
-- One JSON document per member per tool. Members read their own; writes go
-- through premium_save(), which checks Premium in the database so a lapsed or
-- free account cannot write by calling the API directly.
create table if not exists public.premium_tool_data (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  tool       text not null check (tool in ('quit', 'tax', 'pricing', 'proof', 'interviews')),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, tool)
);
alter table public.premium_tool_data enable row level security;
drop policy if exists premium_tool_data_own_read on public.premium_tool_data;
create policy premium_tool_data_own_read on public.premium_tool_data
  for select to authenticated using (user_id = auth.uid());

create or replace function public.premium_save(p_tool text, p_data jsonb)
returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if auth.uid() is null or not public.has_premium(auth.uid()) then
    raise exception 'premium_required';
  end if;
  if p_tool not in ('quit', 'tax', 'pricing', 'proof', 'interviews') then
    raise exception 'unknown tool';
  end if;
  if pg_column_size(p_data) > 400000 then
    raise exception 'too_large';
  end if;
  insert into premium_tool_data (user_id, tool, data, updated_at)
  values (auth.uid(), p_tool, coalesce(p_data, '{}'::jsonb), now())
  on conflict (user_id, tool) do update set data = excluded.data, updated_at = now();
end $function$;
revoke all on function public.premium_save(text, jsonb) from public;
grant execute on function public.premium_save(text, jsonb) to authenticated;

-- 5. The public Proof Page -------------------------------------------------------
-- Shown at /proof/:username while the owner has Premium and has published it.
-- Returns only what the owner chose to show, plus their approved wins.
create or replace function public.proof_page(p_username text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_prof profiles%rowtype; v_data jsonb;
begin
  select * into v_prof from profiles
   where lower(username) = lower(p_username) and coalesce(account_status, 'active') = 'active';
  if not found or not public.has_premium(v_prof.id) then return null; end if;
  select data into v_data from premium_tool_data where user_id = v_prof.id and tool = 'proof';
  if v_data is null or coalesce((v_data->>'published')::boolean, false) is not true then return null; end if;
  return jsonb_build_object(
    'username', v_prof.username,
    'display_name', v_prof.display_name,
    'avatar_url', v_prof.avatar_url,
    'path', v_prof.path,
    'current_level', v_prof.current_level,
    'verified_level', v_prof.verified_level,
    'page', v_data,
    'wins', case when coalesce((v_data->>'show_wins')::boolean, true) then coalesce((
      select jsonb_agg(w order by w.created_at desc) from (
        select title, category, amount_usd, created_at from wins
         where user_id = v_prof.id and approved order by created_at desc limit 6) w), '[]'::jsonb)
      else '[]'::jsonb end
  );
end $function$;
revoke all on function public.proof_page(text) from public;
grant execute on function public.proof_page(text) to anon, authenticated;
