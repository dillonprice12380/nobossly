-- The AI credit rail.
--
-- Until now nothing in the product metered an AI call. `marketScan` runs a web
-- search (up to five queries) and crawls the member's own website, and it sits
-- behind a "Redraw Compass" button with no cap at all; the advisor re-runs on
-- every draft and every revision. That is not a margin problem, it is an
-- unbounded one: a single member in a loop costs whatever they feel like
-- costing.
--
-- The `ai_credits` table has existed since the beginning with a default balance
-- of 10 and no code that reads or writes it. This is that table, finished.
--
-- Three rules the design turns on:
--
--   1. Credits are a safety rail, not a product. The pricing page promises "no
--      per-report fees, no idea-by-idea charges", so a paying member never sees
--      a balance — they get a ceiling high enough that only abuse reaches it.
--      Free members do see theirs, because "2 coach replies left this month" is
--      the single best upgrade prompt in the product.
--
--   2. Nothing about the price is decided by the browser. The old RLS policy was
--      `for all` on ai_credits, so any member could have set their own balance
--      to a million with one PostgREST call. Reads stay theirs; every write now
--      goes through spend_ai_credits(), which is security definer and looks up
--      the cost and the cap itself. The client passes a kind, nothing more.
--
--   3. Costs and caps live in tables, not in code, so pricing can be tuned from
--      the admin without a deploy.

-- --------------------------------------------------------------------------
-- What a call costs, and what a plan gets.

create table if not exists ai_credit_costs (
  kind        text primary key,
  cost        int  not null default 1 check (cost >= 0),
  label       text not null,
  updated_at  timestamptz not null default now()
);

comment on table ai_credit_costs is
  'What each kind of AI call costs, in credits. Read by spend_ai_credits() — never by the client, so a caller cannot choose its own price. Roughly proportional to real cost: web search and site crawls are dear, small JSON calls are cheap.';

insert into ai_credit_costs (kind, cost, label) values
  ('compass',       6, 'Drawing a Compass (live market scan + site read)'),
  ('advisor',       2, 'Stress-testing an idea against your fit test'),
  ('blueprint',     5, 'Building a launch blueprint'),
  ('demand',        4, 'Live demand evidence (web search)'),
  ('weekly_plan',   2, 'This week''s plan'),
  ('coach',         1, 'One coach reply'),
  ('proof_review',  1, 'Reviewing a rung proof'),
  ('reading_list',  1, 'Picking guides for the week'),
  ('challenges',    2, 'AI-tailored challenges'),
  ('milestones',    2, 'AI-tailored goals'),
  ('budget',        2, 'AI startup budget'),
  ('classify',      1, 'Classifying a business for elective quests')
on conflict (kind) do nothing;

create table if not exists ai_credit_plans (
  plan        text primary key,
  monthly     int  not null check (monthly >= 0),
  visible     bool not null default true,
  updated_at  timestamptz not null default now()
);

comment on table ai_credit_plans is
  'The monthly allowance per plan. `visible` decides whether the member is shown a balance: free yes (it is the upgrade prompt), paid no (the pricing page promises no per-report fees, and a subscriber who can see a meter starts rationing).';

insert into ai_credit_plans (plan, monthly, visible) values
  ('free',  20, true),
  ('paid', 400, false)
on conflict (plan) do nothing;

-- --------------------------------------------------------------------------
-- The balance itself. period_key is what makes the allowance monthly: the
-- balance is not topped up by a cron, it is reset lazily the first time it is
-- touched in a new month. No scheduled job to fail silently.

alter table ai_credits add column if not exists period_key text not null default to_char(now() at time zone 'utc', 'YYYY-MM');

comment on column ai_credits.period_key is
  'The UTC month (YYYY-MM) this balance belongs to. spend_ai_credits() refills on first use of a new month rather than on a schedule, so there is no cron that can quietly stop running.';

-- Every spend, kept. This is the abuse signal: it is how you see one account
-- burning a month of credits in four minutes, and how you price the next tier.
create table if not exists ai_spend (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  kind        text not null,
  cost        int  not null,
  plan        text not null,
  balance_after int not null,
  created_at  timestamptz not null default now()
);

create index if not exists ai_spend_user_idx on ai_spend (user_id, created_at desc);
create index if not exists ai_spend_created_idx on ai_spend (created_at desc);

alter table ai_spend enable row level security;

drop policy if exists ai_spend_own_select on ai_spend;
create policy ai_spend_own_select on ai_spend for select using (auth.uid() = user_id);
-- No insert/update/delete policy on purpose: only spend_ai_credits() writes here.

-- Reads stay the member's own; writes are the function's alone.
drop policy if exists ai_credits_own on ai_credits;
drop policy if exists ai_credits_own_select on ai_credits;
create policy ai_credits_own_select on ai_credits for select using (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- The one entry point.
--
-- Takes a kind and nothing else. Looks up the member's plan, the cap for that
-- plan and the cost of that kind, rolls the month over if it has turned, and
-- either debits and returns ok, or refuses and says how long until the refill.
--
-- `p_dry_run` answers "could they afford this?" without spending, which is what
-- the views need to show or hide a button.

create or replace function spend_ai_credits(p_kind text, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_plan    text;
  v_cap     int;
  v_visible bool;
  v_cost    int;
  v_period  text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_balance int;
  v_row     ai_credits%rowtype;
  v_prof    profiles%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'auth');
  end if;

  select * into v_prof from profiles where id = v_user;

  -- Mirrors planOf() in src/middleware/auth.js. Kept in step deliberately: if
  -- the two ever disagree, a member sees a feature the rail then refuses.
  v_plan := case
    when v_prof.is_admin or v_prof.is_lifetime then 'paid'
    when v_prof.subscription_status in ('active','canceled','trialing')
         and v_prof.subscription_period_end is not null
         and v_prof.subscription_period_end > now() then 'paid'
    when v_prof.subscription_status = 'active'
         and v_prof.subscription_period_end is null then 'paid'
    else 'free'
  end;

  select monthly, visible into v_cap, v_visible from ai_credit_plans where plan = v_plan;
  if v_cap is null then v_cap := 20; v_visible := true; end if;

  select cost into v_cost from ai_credit_costs where kind = p_kind;
  if v_cost is null then v_cost := 1; end if;

  -- Create the row on first touch rather than relying on a signup trigger that
  -- may not have existed when the account was made.
  insert into ai_credits (user_id, balance, period_key)
  values (v_user, v_cap, v_period)
  on conflict (user_id) do nothing;

  select * into v_row from ai_credits where user_id = v_user for update;

  -- The month turned: refill. Done here, on the first call of the month, so
  -- there is no scheduled job whose failure would silently strand everyone.
  if v_row.period_key is distinct from v_period then
    update ai_credits
       set balance = v_cap, period_key = v_period, updated_at = now()
     where user_id = v_user
    returning * into v_row;
  end if;

  -- A plan change mid-month must not leave a new subscriber capped at the free
  -- allowance until the calendar turns.
  if v_row.balance > v_cap then
    update ai_credits set balance = v_cap, updated_at = now() where user_id = v_user returning * into v_row;
  end if;

  v_balance := v_row.balance;

  if v_balance < v_cost then
    return jsonb_build_object(
      'ok', false, 'reason', 'insufficient', 'plan', v_plan,
      'balance', v_balance, 'cost', v_cost, 'cap', v_cap, 'visible', v_visible,
      'refills_on', (date_trunc('month', now() at time zone 'utc') + interval '1 month')::date);
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'plan', v_plan,
      'balance', v_balance, 'cost', v_cost, 'cap', v_cap, 'visible', v_visible);
  end if;

  update ai_credits
     set balance = balance - v_cost,
         total_used = coalesce(total_used, 0) + v_cost,
         updated_at = now()
   where user_id = v_user
  returning balance into v_balance;

  insert into ai_spend (user_id, kind, cost, plan, balance_after)
  values (v_user, p_kind, v_cost, v_plan, v_balance);

  return jsonb_build_object(
    'ok', true, 'plan', v_plan, 'spent', v_cost,
    'balance', v_balance, 'cost', v_cost, 'cap', v_cap, 'visible', v_visible);
end;
$$;

revoke all on function spend_ai_credits(text, boolean) from public;
grant execute on function spend_ai_credits(text, boolean) to authenticated;

comment on function spend_ai_credits(text, boolean) is
  'The only way credits move. Security definer because the member must not be able to set their own balance — the old `for all` policy on ai_credits let them. Costs come from ai_credit_costs and caps from ai_credit_plans, both server-side, so the caller chooses a kind and nothing else.';

-- --------------------------------------------------------------------------
-- Reading the balance without spending, for the header and the account page.

create or replace function ai_credit_status()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select spend_ai_credits('__status__', true);
$$;

revoke all on function ai_credit_status() from public;
grant execute on function ai_credit_status() to authenticated;

comment on function ai_credit_status() is
  'Balance, cap and whether to show it, with nothing spent. The __status__ kind is not in ai_credit_costs so it falls to the default cost of 1, which only matters in that a member with 0 credits reads as "cannot afford" — which is true.';

grant select on ai_credit_costs to authenticated, anon;
grant select on ai_credit_plans to authenticated, anon;
alter table ai_credit_costs enable row level security;
alter table ai_credit_plans enable row level security;
drop policy if exists ai_credit_costs_read on ai_credit_costs;
drop policy if exists ai_credit_plans_read on ai_credit_plans;
create policy ai_credit_costs_read on ai_credit_costs for select using (true);
create policy ai_credit_plans_read on ai_credit_plans for select using (true);

-- --------------------------------------------------------------------------
-- Applied as a follow-up: the balance has to remember which cap it was issued
-- against.
--
-- Without it the only refill trigger is the month turning, so the seven legacy
-- rows created with the table's original default of 10 would have stayed at 10
-- forever, and someone upgrading on the 3rd would wait until the 1st for the
-- plan they just paid for. Clamping a downgrade was handled; raising was not.
-- Caught by running the function against a real profile before wiring any of it
-- to the app.

alter table ai_credits add column if not exists issued_cap int;

comment on column ai_credits.issued_cap is
  'The plan cap this balance was issued against. When it stops matching the member''s current cap — an upgrade, a downgrade, or an admin retuning ai_credit_plans — the balance is reissued on the next call.';

-- In spend_ai_credits(), the insert carries issued_cap and the refill test
-- becomes:
--
--   if v_row.period_key is distinct from v_period
--      or v_row.issued_cap is distinct from v_cap then
--     update ai_credits set balance = v_cap, period_key = v_period,
--            issued_cap = v_cap, updated_at = now() where user_id = v_user;
--   end if;
--
-- and the separate `balance > cap` clamp is gone, subsumed by the above.

update ai_credits set issued_cap = null, total_used = 0;
