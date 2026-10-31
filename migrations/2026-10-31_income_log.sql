-- The income log every member keeps. revenue_entries was created for the
-- pre-relaunch idea tracker and never written to (0 rows), so it is reused
-- rather than adding a second table: one row per payment the side business
-- received, read by the Budget page, the Quit-Date Planner and Tax Set-Aside.
--
-- Logging income is free. What it unlocks on the ladder is still claimed the
-- usual way (a quest proof note, a confirmed trophy): nothing here awards XP.
-- Applied live 2026-10-31.

alter table public.revenue_entries
  add constraint revenue_entries_amount_range check (amount > 0 and amount <= 100000000);

create index if not exists revenue_entries_user_date
  on public.revenue_entries (user_id, entry_date desc);

-- Was `for all to public`; only a signed-in member can have rows of their own.
drop policy if exists revenue_own on public.revenue_entries;
create policy revenue_own on public.revenue_entries
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
