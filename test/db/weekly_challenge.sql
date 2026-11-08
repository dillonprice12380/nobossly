\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'mo');
select t('the weeks already listed are reworded', (select title from challenges where slug = 'weekly-cohort-2026-11-02') = 'Weekly challenge — week of Nov 2'
  and (select description from challenges where slug = 'weekly-cohort-2026-11-02') not ilike '%sprint%');
select t('curated rows are left alone', (select title from challenges where slug = 'validate') = 'Validate your idea');
select ensure_weekly_cohorts();
select t('this week and next week exist', (select count(*) from challenges where slug in ('weekly-cohort-' || date_trunc('week', now() at time zone 'America/New_York')::date, 'weekly-cohort-' || (date_trunc('week', now() at time zone 'America/New_York')::date + 7))) = 2);
select t('new weeks use the new words', not exists (select 1 from challenges where slug like 'weekly-cohort-%' and (title like '%Sprint%' or description ilike '%sprint%' or description ilike '%break it into tasks%')));
select t('running it twice adds nothing', (select count(*) from challenges where slug like 'weekly-cohort-%') = (select count(*) from (select ensure_weekly_cohorts()) x, challenges where slug like 'weekly-cohort-%'));
insert into cohort_waitlist(user_id, cohort_id) select '00000000-0000-0000-0000-00000000000a', id from challenges where slug = 'weekly-cohort-2026-11-02';
select ensure_weekly_cohorts();
select t('the reminder goes out in the new words, once', (select count(*) from notifications where user_id = '00000000-0000-0000-0000-00000000000a' and message like 'This week''s community challenge has started%') = 1
  and not exists (select 1 from cohort_waitlist));

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
