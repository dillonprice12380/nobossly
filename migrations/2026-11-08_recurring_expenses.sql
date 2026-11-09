-- Applied live 2026-11-08 (run in the SQL Editor; returned true. Verified: recurring_expenses with RLS on and no anon access, expenses.recurring_id and recurring_period, the unique constraint and the ownership trigger).
--
-- Recurring expenses on the Money page (2026-11-08). A member marks a cost
-- that comes round every month (software, hosting, studio rent) and NoBossly
-- logs it for them each month on the day they chose, until they stop it.
--
--  * recurring_expenses: the rule. logged_through is the last month already
--    logged, so deleting one logged expense does not bring it back.
--  * expenses.recurring_id / recurring_period tie a logged expense to its rule
--    and month; a unique constraint means a month is never logged twice, even
--    if two pages log it at once. Stopping or deleting a rule keeps what was
--    already logged.
--  * The member's own client does the logging when they open Money (src/money.js),
--    so this is the member's own data under the member's own policy.

begin;

create table if not exists public.recurring_expenses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  category       text not null check (char_length(btrim(category)) between 1 and 40),
  amount         numeric(12,2) not null check (amount > 0 and amount <= 10000000),
  note           text check (note is null or char_length(note) <= 200),
  day_of_month   integer not null default 1 check (day_of_month between 1 and 28),
  starts_on      date not null default current_date,
  logged_through date,
  stopped_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists recurring_expenses_owner on public.recurring_expenses (user_id);
alter table public.recurring_expenses enable row level security;
revoke all on public.recurring_expenses from anon, authenticated;
grant select, insert, update, delete on public.recurring_expenses to authenticated;
drop policy if exists recurring_expenses_own on public.recurring_expenses;
create policy recurring_expenses_own on public.recurring_expenses for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.expenses add column if not exists recurring_id uuid references public.recurring_expenses(id) on delete set null;
alter table public.expenses add column if not exists recurring_period date
  check (recurring_period is null or extract(day from recurring_period) = 1);
do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_recurring_once') then
    alter table public.expenses add constraint expenses_recurring_once unique (recurring_id, recurring_period);
  end if;
end $do$;

-- A logged expense can only point at one of the member's own rules.
create or replace function public.expenses_check_recurring()
returns trigger language plpgsql set search_path to 'public'
as $function$
begin
  if new.recurring_id is not null and not exists (
       select 1 from public.recurring_expenses r where r.id = new.recurring_id and r.user_id = new.user_id) then
    raise exception 'that recurring expense is not yours';
  end if;
  return new;
end $function$;
drop trigger if exists expenses_check_recurring on public.expenses;
create trigger expenses_check_recurring before insert or update of recurring_id on public.expenses
  for each row execute function public.expenses_check_recurring();

commit;

select to_regclass('public.recurring_expenses') is not null
   and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name in ('recurring_id', 'recurring_period')) = 2
   and not has_table_privilege('anon', 'public.recurring_expenses', 'select') as ok;
