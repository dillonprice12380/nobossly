\set ON_ERROR_STOP 1
create table if not exists _results(n serial, label text, ok bool);
grant all on _results to authenticated, service_role; grant usage on sequence _results_n_seq to authenticated, service_role;
create or replace function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to authenticated, service_role;
create or replace function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to authenticated, service_role;
grant usage on schema public to service_role;

insert into profiles(id, username) values
 ('00000000-0000-0000-0000-000000000101', 'owner'),
 ('00000000-0000-0000-0000-000000000102', 'member'),
 ('00000000-0000-0000-0000-000000000103', 'outsider');

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', false);
insert into groups(id, name, slug, owner_id) values ('50000000-0000-0000-0000-000000000001', 'Builders', 'builders', '00000000-0000-0000-0000-000000000101');
insert into group_members(group_id, user_id, role, status) values ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'owner', 'active');
insert into groups(id, name, slug, owner_id, checkin_friday) values ('50000000-0000-0000-0000-000000000002', 'Quiet Fridays', 'quiet', '00000000-0000-0000-0000-000000000101', false);
insert into group_members(group_id, user_id, role, status) values ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000101', 'owner', 'active');
insert into groups(id, name, slug, owner_id) values ('50000000-0000-0000-0000-000000000003', 'Empty', 'empty', '00000000-0000-0000-0000-000000000101');

select t('members cannot post a check-in', fails($$insert into group_posts(group_id, user_id, kind, body, checkin_key) values ('50000000-0000-0000-0000-000000000001', null, 'checkin', 'x', '2026-11-09:monday')$$));
select t('members cannot post as a check-in under their own name', fails($$insert into group_posts(group_id, user_id, kind, body, checkin_key) values ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'checkin', 'x', '2026-11-09:monday')$$));
select t('members cannot run the check-in job', fails($$select post_weekly_checkins('monday', '2026-11-09')$$));

reset role;
set role service_role;
select t('Monday posts to every group with members', post_weekly_checkins('monday', '2026-11-09') = 2);
select t('running it again posts nothing more', post_weekly_checkins('monday', '2026-11-09') = 0);
select t('Friday skips groups that turned it off', post_weekly_checkins('friday', '2026-11-13') = 1);
select t('an unknown kind is refused', fails($$select post_weekly_checkins('sunday', '2026-11-15')$$));
reset role;

select t('a check-in has no author and the right words', (select count(*) from group_posts where kind = 'checkin' and user_id is null and body = 'What are you working on this week?') = 2);
select t('an empty group gets none', (select count(*) from group_posts where group_id = '50000000-0000-0000-0000-000000000003') = 0);

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', false);
select id as cid from group_posts where group_id = '50000000-0000-0000-0000-000000000001' and checkin_key = '2026-11-09:monday' \gset
insert into group_posts(id, group_id, user_id, body, parent_id) values ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'Shipping the pricing page', :'cid');
select t('a member replies to the check-in', (select count(*) from group_posts where parent_id = :'cid') = 1);
select t('a reply cannot go under a reply', fails($$insert into group_posts(group_id, user_id, body, parent_id) values ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'deep', '60000000-0000-0000-0000-000000000001')$$));
select t('a reply cannot point into another group', fails($$insert into group_posts(group_id, user_id, body, parent_id) values ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000101', 'elsewhere', '$$ || :'cid' || $$')$$));
with u as (update groups set checkin_friday = false where id = '50000000-0000-0000-0000-000000000001' returning 1) select t('the owner can turn Friday off', (select count(*) from u) = 1);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000103', false);
select t('an outsider cannot reply in a group they are not in', fails($$insert into group_posts(group_id, user_id, body, parent_id) values ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000103', 'hi', '$$ || :'cid' || $$')$$));
select t('anyone can still read a public group''s check-in', (select count(*) from group_posts where id = :'cid') = 1);
reset role;
select t('anon cannot run the job', not has_function_privilege('anon', 'post_weekly_checkins(text,date)', 'execute'));
select t('signed-in members cannot run the job', not has_function_privilege('authenticated', 'post_weekly_checkins(text,date)', 'execute'));
select t('the server can', has_function_privilege('service_role', 'post_weekly_checkins(text,date)', 'execute'));

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results where n > coalesce((select max(n) from _results where label = '__start__'), 0) order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
