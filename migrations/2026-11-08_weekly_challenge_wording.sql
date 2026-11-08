-- Applied live 2026-11-08 (run in the SQL Editor; verified: ensure_weekly_cohorts() has the
-- new words and no sprint wording, and the three listed weeks read "Weekly challenge — week of …").
--
-- NoBossly is a workspace and a community, not a program (2026-11-08). The
-- weekly cohort stays as a community challenge, but its words still talked
-- about 7-day sprints and check-ins, which are switched off, and told members
-- how to work ("break it into tasks"). Now: pick your own goal for the week,
-- say what got done at the end. Same slugs, dates and schedule; only the words
-- change, for the weeks already listed and for every week from now on.

begin;

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
              'Weekly challenge — week of ' || to_char(d, 'FMMon FMDD'),
              'Pick one goal of your own for this week and work on it alongside everyone else who joined. '
                || 'On Sunday night, say what you set out to do and what got done.',
              '🗓', 'one_time', 40,
              (d::timestamp at time zone tz),
              ((d + 7)::timestamp at time zone tz) - interval '1 second',
              true, 0, true, true, 1, 10);
    end if;
  end loop;

  -- Old weeks drop off the board three weeks after they end. Members who took
  -- part keep their completion; the challenge just stops being listed.
  update challenges set is_active = false
   where slug like 'weekly-cohort-%' and is_active and ends_at < now() - interval '21 days';

  -- The waitlist: once a week someone asked about has started, remind them
  -- once and take them off the list.
  -- (Written directly: push_notification() needs a signed-in caller, and this
  -- runs from pg_cron.)
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  select w.user_id, 'challenges', null, 'challenges', w.cohort_id,
         'This week''s community challenge has started. Join in and pick your goal for the week.', false
    from cohort_waitlist w join challenges c on c.id = w.cohort_id
   where c.starts_at <= now();
  delete from cohort_waitlist w using challenges c
   where c.id = w.cohort_id and c.starts_at <= now();
end $function$;
revoke all on function public.ensure_weekly_cohorts() from public;

-- The weeks already listed.
update challenges
   set title = replace(title, 'Weekly Sprint Cohort — week of', 'Weekly challenge — week of'),
       description = 'Pick one goal of your own for this week and work on it alongside everyone else who joined. '
                     || 'On Sunday night, say what you set out to do and what got done.',
       emoji = '🗓'
 where slug like 'weekly-cohort-%';

commit;

select count(*) filter (where title like 'Weekly challenge%') = count(*) as ok
  from challenges where slug like 'weekly-cohort-%';
