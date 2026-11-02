\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated; grant usage on sequence _results_n_seq to anon, authenticated;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to anon, authenticated;

-- a = NoBossly admin, p = provider applicant, s = their staff, m = member, o = outsider, x = a second member
insert into profiles(id, is_admin, username, display_name) values
 ('00000000-0000-0000-0000-00000000000a', true,  'admin',   'Admin'),
 ('00000000-0000-0000-0000-00000000000b', false, 'teacher', 'Tess'),
 ('00000000-0000-0000-0000-00000000000c', false, 'staffer', 'Sam'),
 ('00000000-0000-0000-0000-00000000000d', false, 'member',  'Mo'),
 ('00000000-0000-0000-0000-00000000000e', false, 'outsider', null),
 ('00000000-0000-0000-0000-00000000000f', false, 'second',  'Xia');

set role authenticated;
-- The applicant applies.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select provider_apply('Launch Lab', 'educator', array['course','program'], 'https://launchlab.example', 'Hi@LaunchLab.example', 'We teach people to start a business around a job.') as app \gset
select t('a member can apply to be a provider', :'app' <> '');
select t('...only one pending application at a time', provider_apply('Launch Lab 2', 'educator', array['course'], null, null, 'Another application, twenty chars.') is null);
select t('applicants cannot write applications directly', fails($$update provider_applications set status = 'approved'$$));
select t('applicants cannot approve themselves', provider_decide(:'app', true) is null);
select t('applicants cannot create an organization', fails($$insert into organizations(name, slug) values ('Mine','mine-org')$$));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000e', false);
select t('others cannot see an application', (select count(*) from provider_applications) = 0);

-- The admin was told, and approves.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select t('the admin sees it', (select count(*) from provider_applications where status = 'pending') = 1);
select provider_decide(:'app', true, 'Welcome') as orgslug \gset
select t('approving creates the provider organization', :'orgslug' = 'launch-lab' and (select provider and kind = 'educator' from organizations where slug = 'launch-lab'));
select t('...and makes the applicant its owner', (select role from org_admins oa join organizations o on o.id = oa.org_id where o.slug = 'launch-lab' and oa.user_id = '00000000-0000-0000-0000-00000000000b') = 'owner');
select t('an application is decided once', provider_decide(:'app', false) is null);
select id as org from organizations where slug = 'launch-lab' \gset

-- A non-provider organization (made by an admin for a pilot) cannot publish.
insert into organizations(id, name, slug) values ('10000000-0000-0000-0000-000000000009', 'Pilot Org', 'pilot-org');
insert into org_admins(org_id, user_id, role) values ('10000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-00000000000e', 'owner');
reset role;
insert into groups(id, name, slug, owner_id, visibility, join_policy, org_id) values ('50000000-0000-0000-0000-000000000009', 'Pilot cohort', 'pilot-cohort', '00000000-0000-0000-0000-00000000000e', 'hidden', 'invite', '10000000-0000-0000-0000-000000000009');
set role authenticated;

-- The provider builds a course and a program.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into org_admins(org_id, user_id, role) values (:'org', '00000000-0000-0000-0000-00000000000c', 'staff');
select cohort_create(:'org', 'Spring Program', 'spring-program', null) as gid \gset
insert into listings(id, org_id, kind, title, slug, summary, join_mode, status, created_by)
values ('20000000-0000-0000-0000-000000000001', :'org', 'course', 'Start Here', 'start-here', 'A self-paced course for your first month.', 'enroll', 'published', '00000000-0000-0000-0000-00000000000b');
insert into listings(id, org_id, kind, title, slug, summary, join_mode, status, questions, group_id, created_by)
values ('20000000-0000-0000-0000-000000000002', :'org', 'program', 'Spring Program', 'spring', 'Twelve weeks with mentors and a cohort.', 'apply', 'published',
        '["What are you building?", "How many hours a week?"]', :'gid', '00000000-0000-0000-0000-00000000000b');
insert into listings(id, org_id, kind, title, slug, summary, status, created_by)
values ('20000000-0000-0000-0000-000000000003', :'org', 'course', 'Draft Course', 'draft-course', 'Not finished yet, hidden.', 'draft', '00000000-0000-0000-0000-00000000000b');
insert into course_modules(id, listing_id, title, position) values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Week 1', 0);
insert into course_lessons(id, listing_id, module_id, title, body, position) values
 ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Pick a problem', '<p>Secret lesson body</p>', 0),
 ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Talk to people', '<p>Second</p>', 1);
select t('the team can build lessons', (select count(*) from course_lessons) = 2);
select t('a lesson cannot point at another course''s module', fails($$insert into course_lessons(listing_id, module_id, title) values ('20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'x')$$));
select t('a listing cannot use another organization''s cohort', fails($$update listings set group_id = '50000000-0000-0000-0000-000000000009' where id = '20000000-0000-0000-0000-000000000001'$$));

-- Staff can edit; the owner of a non-provider org cannot publish.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
with u as (update listings set summary = 'A self-paced course for month one.' where id = '20000000-0000-0000-0000-000000000001' returning 1)
select t('staff can edit their organization''s listings', count(*) = 1) from u;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000e', false);
insert into listings(org_id, kind, title, slug, summary, created_by) values ('10000000-0000-0000-0000-000000000009', 'course', 'Pilot', 'pilot-course', 'A pilot course, draft only.', '00000000-0000-0000-0000-00000000000e');
select t('a non-provider organization can draft', (select count(*) from listings where slug = 'pilot-course') = 1);
select t('...but not publish', fails($$update listings set status = 'published' where slug = 'pilot-course'$$));
with u as (update listings set title = 'Hacked' where org_id <> '10000000-0000-0000-0000-000000000009' returning 1)
select t('nobody edits someone else''s listing', count(*) = 0) from u;
select t('nobody lists for someone else''s organization', fails($$insert into listings(org_id, kind, title, slug, summary, created_by) values ('$$ || :'org' || $$', 'course', 'Fake', 'fake-course', 'Pretending to be them.', '00000000-0000-0000-0000-00000000000e')$$));

-- A member browses (drafts hidden), enrolls in the course, applies to the program.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('the marketplace shows published listings only', (select array_agg(slug order by slug) from marketplace_listings()) = array['spring','start-here']);
select t('a draft has no public page', listing_page('draft-course') is null);
select t('the course page shows the outline, not the lessons', listing_page('start-here')->'outline'->0->'lessons'->1->>'title' = 'Talk to people' and listing_page('start-here')::text not like '%Secret lesson body%');
select t('lesson bodies are hidden before enrolling', (select count(*) from course_lessons) = 0);
select t('progress cannot be logged before enrolling', fails($$insert into lesson_progress(user_id, lesson_id, listing_id) values ('00000000-0000-0000-0000-00000000000d', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001')$$));
select t('enrolling in a course is instant', listing_join('20000000-0000-0000-0000-000000000001') = 'enrolled');
select t('...then the lessons open', (select count(*) from course_lessons) = 2);
insert into lesson_progress(user_id, lesson_id, listing_id) values ('00000000-0000-0000-0000-00000000000d', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
select t('...and progress is kept', (select done from my_listings() where slug = 'start-here') = 1 and (select lessons from my_listings() where slug = 'start-here') = 2);
select t('progress cannot be logged against another course', fails($$insert into lesson_progress(user_id, lesson_id, listing_id) values ('00000000-0000-0000-0000-00000000000d', '40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002')$$));
select t('nobody logs progress for someone else', fails($$insert into lesson_progress(user_id, lesson_id, listing_id) values ('00000000-0000-0000-0000-00000000000f', '40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001')$$));
select t('applying to a program waits for review', listing_join('20000000-0000-0000-0000-000000000002', array['A bakery', 'Ten']) = 'applied');
select t('...with the answers kept against the questions', (select answers->1->>'q' = 'How many hours a week?' and answers->1->>'a' = 'Ten' from listing_enrollments where listing_id = '20000000-0000-0000-0000-000000000002'));
select t('...and not yet in the cohort', group_role(:'gid') is null);
select t('members cannot accept themselves', listing_decide((select id from listing_enrollments where listing_id = '20000000-0000-0000-0000-000000000002'), 'accept') is null);
select t('members cannot write enrollments directly', fails($$update listing_enrollments set status = 'enrolled'$$));
select t('a draft cannot be joined', listing_join('20000000-0000-0000-0000-000000000003') = 'invalid');

-- The team reviews.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select t('the team sees the applicant and answers', (select count(*) from listing_enrollments where listing_id = '20000000-0000-0000-0000-000000000002' and status = 'applied') = 1);
select t('the team cannot join its own listing', listing_join('20000000-0000-0000-0000-000000000002') = 'own');
select t('accepting enrolls them', listing_decide((select id from listing_enrollments where listing_id = '20000000-0000-0000-0000-000000000002'), 'accept', 'Welcome!') = 'enrolled');
select t('the team sees learners'' progress', (select count(*) from lesson_progress) = 1);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('accepted members join the program''s cohort', group_role(:'gid') = 'member');

-- Others see nothing private.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select t('others cannot see anyone''s enrollment', (select count(*) from listing_enrollments) = 0);
select t('others cannot see anyone''s progress', (select count(*) from lesson_progress) = 0);
select t('others cannot see drafts', (select count(*) from listings where status = 'draft') = 0);
reset role;
update listings set capacity = 1 where id = '20000000-0000-0000-0000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select t('a full course says so', listing_join('20000000-0000-0000-0000-000000000001') = 'full');

-- Withdrawing and removal.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('a member can withdraw', listing_withdraw('20000000-0000-0000-0000-000000000002'));
select t('...which takes them out of the cohort', group_role(:'gid') is null);
select t('...and apply again', listing_join('20000000-0000-0000-0000-000000000002', array['Still a bakery']) = 'applied');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select t('declining notifies, and a declined member cannot just reapply', listing_decide((select id from listing_enrollments where listing_id = '20000000-0000-0000-0000-000000000002'), 'decline') = 'declined');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('...they see "declined"', listing_join('20000000-0000-0000-0000-000000000002') = 'declined');

-- Signed out.
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select t('signed-out visitors can browse', (select count(*) from marketplace_listings()) = 2);
select t('...and open a listing page, with no status of their own', listing_page('spring')->>'title' = 'Spring Program' and listing_page('spring')->'mine' = 'null'::jsonb);
select t('...and read published listings', (select count(*) from listings) = 2);
select t('...but no lessons', fails($$select * from course_lessons$$));
select t('...no enrollments', fails($$select * from listing_enrollments$$));
select t('...no applications', fails($$select * from provider_applications$$));
select t('...and cannot join or apply', fails($$select listing_join('20000000-0000-0000-0000-000000000001')$$) and fails($$select provider_apply('x','other',array['course'],null,null,'twenty characters here')$$));

reset role;
select t('the admin was notified of the application', (select count(*) from notifications where user_id = '00000000-0000-0000-0000-00000000000a' and entity_type = 'provider_applications') = 1);
select t('the applicant was notified of the approval', (select count(*) from notifications where user_id = '00000000-0000-0000-0000-00000000000b' and entity_type = 'provider_applications') = 1);
select t('the team was notified of the application and enrollment', (select count(*) from notifications where entity_type = 'listing_enrollments' and user_id = '00000000-0000-0000-0000-00000000000c') >= 2);
select t('the member was notified of each decision', (select count(*) from notifications where entity_type = 'listing_enrollments' and user_id = '00000000-0000-0000-0000-00000000000d') = 2);

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
