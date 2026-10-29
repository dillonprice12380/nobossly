-- PayPal as a second way to pay for Premium, next to Stripe.
--
--   Monthly  $5/mo   PayPal subscription  (plan P-1XT24633L8241682JNLRY2GY)
--   Annual   $48/yr  PayPal subscription  (plan P-6R276282EC310145KNLRY2WQ)
--   Lifetime $200    PayPal one-time order (no plan: it is a payment)
--
-- What this adds:
--   * pricing_tiers.paypal_plan_id          which PayPal plan sells the tier
--   * profiles.paypal_subscription_id       the member's live PayPal subscription
--   * profiles.paypal_capture_id            the capture that bought Lifetime (for refunds)
--   * protect_profile_fields()              the two new columns are billing-owned, like the Stripe ones
--   * apply_paypal_subscription()           grant / update, gated by the same app_secrets.sub_sync secret
--   * find_user_by_paypal_sub()             webhook: whose subscription is this
--   * find_user_by_paypal_capture()         webhook: whose Lifetime payment is this
--   * revoke_paypal_lifetime()              webhook: a refunded / reversed Lifetime payment
--   * apply_subscription()                  now also lets go of a PayPal subscription when Stripe
--                                           takes over, so a late PayPal event can never end a newer membership
--
-- Unlike apply_subscription (still EXECUTE-able by anon, see
-- 2026-08-31_lock_down_security_definer.sql), the new functions are granted to
-- service_role only. The PayPal routes use the service role and refuse to start
-- a PayPal checkout without it.

alter table pricing_tiers add column if not exists paypal_plan_id text;
alter table profiles      add column if not exists paypal_subscription_id text;
alter table profiles      add column if not exists paypal_capture_id text;

create index if not exists profiles_paypal_subscription_id_idx on profiles (paypal_subscription_id) where paypal_subscription_id is not null;
create index if not exists profiles_paypal_capture_id_idx      on profiles (paypal_capture_id)      where paypal_capture_id is not null;

-- The two PayPal plans created in the PayPal dashboard (product "NoBossly Premium").
-- The server re-checks each plan's price and interval with PayPal before
-- charging, so a wrong ID here refuses the checkout instead of mis-charging.
update pricing_tiers set paypal_plan_id = 'P-1XT24633L8241682JNLRY2GY' where key = 'month';
update pricing_tiers set paypal_plan_id = 'P-6R276282EC310145KNLRY2WQ' where key = 'year';

-- ---------------------------------------------------------------------------
-- Billing-owned profile columns. Identical to the live function plus the two
-- PayPal columns.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
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
      new.paypal_subscription_id  := old.paypal_subscription_id;
      new.paypal_capture_id       := old.paypal_capture_id;
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

-- ---------------------------------------------------------------------------
-- Stripe grants: the live function plus one thing. A new Stripe subscription
-- replaces any PayPal one on the profile, so events for the old PayPal
-- subscription no longer resolve to this member.
create or replace function public.apply_subscription(p_secret text, p_user uuid, p_tier text, p_status text, p_customer text, p_sub_id text, p_period_end timestamp with time zone, p_lifetime boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
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
    paypal_subscription_id = case when p_sub_id is not null then null else paypal_subscription_id end,
    subscription_period_end = coalesce(p_period_end, subscription_period_end),
    is_lifetime = (coalesce(is_lifetime, false) or coalesce(p_lifetime, false)),
    updated_at = now()
  where id = p_user;
  perform set_config('app.billing_write', 'off', true);
end $function$;

-- ---------------------------------------------------------------------------
-- PayPal grants. p_sub_id / p_capture_id are only ever set, never cleared by a
-- null, so a status-only update (a cancel, a failed payment) keeps them.
-- A PayPal subscription replaces any Stripe subscription id on the profile for
-- the same reason as above.
create or replace function public.apply_paypal_subscription(
  p_secret text, p_user uuid, p_tier text, p_status text,
  p_sub_id text, p_period_end timestamp with time zone, p_lifetime boolean, p_capture_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
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
    paypal_subscription_id = coalesce(p_sub_id, paypal_subscription_id),
    stripe_subscription_id = case when p_sub_id is not null then null else stripe_subscription_id end,
    paypal_capture_id = coalesce(p_capture_id, paypal_capture_id),
    subscription_period_end = coalesce(p_period_end, subscription_period_end),
    is_lifetime = (coalesce(is_lifetime, false) or coalesce(p_lifetime, false)),
    updated_at = now()
  where id = p_user;
  perform set_config('app.billing_write', 'off', true);
end $function$;

create or replace function public.find_user_by_paypal_sub(p_secret text, p_sub_id text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare uid uuid;
begin
  if (select value from app_secrets where key = 'sub_sync') is distinct from p_secret then
    raise exception 'forbidden';
  end if;
  select id into uid from profiles where paypal_subscription_id = p_sub_id limit 1;
  return uid;
end $function$;

create or replace function public.find_user_by_paypal_capture(p_secret text, p_capture_id text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare uid uuid;
begin
  if (select value from app_secrets where key = 'sub_sync') is distinct from p_secret then
    raise exception 'forbidden';
  end if;
  select id into uid from profiles where paypal_capture_id = p_capture_id limit 1;
  return uid;
end $function$;

-- A refunded or reversed Lifetime payment takes Lifetime back. Only the
-- member whose profile holds that exact capture is touched.
create or replace function public.revoke_paypal_lifetime(p_secret text, p_capture_id text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare uid uuid;
begin
  if (select value from app_secrets where key = 'sub_sync') is distinct from p_secret then
    raise exception 'forbidden';
  end if;
  perform set_config('app.billing_write', 'on', true);
  update profiles set
    is_lifetime = false,
    subscription_status = 'expired',
    paypal_capture_id = null,
    updated_at = now()
  where paypal_capture_id = p_capture_id
  returning id into uid;
  perform set_config('app.billing_write', 'off', true);
  return uid;
end $function$;

revoke execute on function public.apply_paypal_subscription(text, uuid, text, text, text, timestamptz, boolean, text) from public, anon, authenticated;
revoke execute on function public.find_user_by_paypal_sub(text, text)     from public, anon, authenticated;
revoke execute on function public.find_user_by_paypal_capture(text, text) from public, anon, authenticated;
revoke execute on function public.revoke_paypal_lifetime(text, text)      from public, anon, authenticated;
grant  execute on function public.apply_paypal_subscription(text, uuid, text, text, text, timestamptz, boolean, text) to service_role;
grant  execute on function public.find_user_by_paypal_sub(text, text)     to service_role;
grant  execute on function public.find_user_by_paypal_capture(text, text) to service_role;
grant  execute on function public.revoke_paypal_lifetime(text, text)      to service_role;
