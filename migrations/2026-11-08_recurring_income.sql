-- NOT APPLIED
--
-- A "Recurring" tick box on the income log (2026-11-08). Subscription and
-- retainer payments are ticked; monthly recurring revenue on the Apps &
-- Software dashboard then fills itself in from them, and the other income
-- numbers (billable income, takings, revenue) from every payment that month.
-- A number a member types for a month still wins. Existing payments start
-- unticked. revenue_entries is already the member's own (policy revenue_own).

alter table public.revenue_entries add column if not exists is_recurring boolean not null default false;

select exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'revenue_entries' and column_name = 'is_recurring') as ok;
