-- Cold-start fixes, part 1.
--
--  1. A weekly cohort. The one cohort quest (30-Day Escape Plan) ended on
--     2026-09-11 and kept showing to new members as "Ended". Instead, every
--     week now has its own cohort: start a 7-day sprint on Monday with everyone
--     else, finish by Sunday. ensure_weekly_cohorts() keeps this week's and next
--     week's cohort in place and retires old ones; pg_cron runs it daily.
--  2. A waitlist ("Remind me"): when the next cohort starts, everyone on it
--     gets a notification, once.
--  3. Founder review: while the community is small, the founder reviews every
--     peer-review request. notify_admins_review() tells the admins one is waiting.
--  4. Copy: "Sprint 1 Started" said 30-day; sprints are 7 days everywhere else.

-- 4. Copy ----------------------------------------------------------------------
update predefined_milestones set description = 'Kicked off your first 7-day sprint.'
 where slug = 'first_sprint_started';

-- 1. Weekly cohort -------------------------------------------------------------
create or replace function public.ensure_weekly_cohorts()
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  tz constant text := 'America/New_York';
  this_monday date := date_trunc('week', (now() at time zone tz))::date;
  d date;
begin
  foreach d in array array[this_monday, this_monday + 7] loop
    if not exists (select 1 from challenges where slug = 'weekly-cohort-' || d) then
      insert into challenges (slug, title, description, emoji, challenge_type, xp_reward,
                              starts_at, ends_at, is_active, position, is_cohort, requires_proof,
                              min_level, max_level)
      values ('weekly-cohort-' || d,
              'Weekly Sprint Cohort — week of ' || to_char(d, 'FMMon FMDD'),
              'Start a 7-day sprint on Monday alongside everyone else in the cohort, and finish it by Sunday night. '
                || 'Pick one thing that moves your business forward, break it into tasks, and check in as you go. '
                || 'To complete it, say what you set out to do and what actually got done.',
              '🏃', 'one_time', 40,
              (d::timestamp at time zone tz),
              ((d + 7)::timestamp at time zone tz) - interval '1 second',
              true, 0, true, true, 1, 10);
    end if;
  end loop;

  -- Old weeks drop off the board three weeks after they end. Members who took
  -- part keep their completion; the quest just stops being listed.
  update challenges set is_active = false
   where slug like 'weekly-cohort-%' and is_active and ends_at < now() - interval '21 days';

  -- The waitlist: once a cohort someone asked about has started, remind them
  -- once and take them off the list.
  -- (Written directly: push_notification() needs a signed-in caller, and this
  -- runs from pg_cron.)
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  select w.user_id, 'challenges', null, 'challenges', w.cohort_id,
         'Your sprint cohort has started — join in and run your 7-day sprint alongside everyone else.', false
    from cohort_waitlist w join challenges c on c.id = w.cohort_id
   where c.starts_at <= now();
  delete from cohort_waitlist w using challenges c
   where c.id = w.cohort_id and c.starts_at <= now();
end $function$;
revoke all on function public.ensure_weekly_cohorts() from public;

-- 2. Waitlist ------------------------------------------------------------------
create table if not exists public.cohort_waitlist (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  cohort_id  uuid not null references public.challenges(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, cohort_id)
);
alter table public.cohort_waitlist enable row level security;
drop policy if exists cohort_waitlist_own_read on public.cohort_waitlist;
create policy cohort_waitlist_own_read on public.cohort_waitlist
  for select to authenticated using (user_id = auth.uid());

-- Only for a cohort that has not started yet.
create or replace function public.cohort_waitlist_join(p_cohort uuid)
returns void language sql security definer set search_path to 'public'
as $function$
  insert into cohort_waitlist (user_id, cohort_id)
  select auth.uid(), c.id from challenges c
   where c.id = p_cohort and c.is_cohort and c.is_active and c.starts_at > now()
     and auth.uid() is not null
  on conflict (user_id, cohort_id) do nothing
$function$;
create or replace function public.cohort_waitlist_leave(p_cohort uuid)
returns void language sql security definer set search_path to 'public'
as $function$
  delete from cohort_waitlist where user_id = auth.uid() and cohort_id = p_cohort
$function$;
revoke all on function public.cohort_waitlist_join(uuid) from public;
revoke all on function public.cohort_waitlist_leave(uuid) from public;
grant execute on function public.cohort_waitlist_join(uuid) to authenticated;
grant execute on function public.cohort_waitlist_leave(uuid) to authenticated;

-- 3. Founder review ------------------------------------------------------------
create or replace function public.notify_admins_review(p_request uuid)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_title text;
begin
  -- Only the member who just posted the request can raise the flag for it.
  select title into v_title from peer_reviews
   where id = p_request and submitter_id = auth.uid() and request_id is null;
  if v_title is null then return; end if;
  perform public.push_notification(p.id, 'system',
            'New review request waiting: “' || left(v_title, 80) || '” — founder review while we grow.',
            'peer_reviews', p_request)
    from profiles p where p.is_admin and p.id <> auth.uid();
end $function$;
revoke all on function public.notify_admins_review(uuid) from public;
grant execute on function public.notify_admins_review(uuid) to authenticated;

-- Run it now, then daily (just after midnight in New York) so a new week's
-- cohort exists before Monday and the waitlist is told when it starts.
select public.ensure_weekly_cohorts();
select cron.unschedule('weekly-cohorts') where exists (select 1 from cron.job where jobname = 'weekly-cohorts');
select cron.schedule('weekly-cohorts', '15 5 * * *', 'select public.ensure_weekly_cohorts()');
