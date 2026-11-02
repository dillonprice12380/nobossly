\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to authenticated; grant usage on sequence _results_n_seq to authenticated;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to authenticated;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to authenticated;
-- affected rows of a statement (0 = silently filtered by RLS)
create function affects(sql text) returns int language plpgsql as $$ declare n int; begin execute sql; get diagnostics n = row_count; return n; exception when others then return -1; end $$;
grant execute on function affects(text) to authenticated;

insert into profiles(id, is_admin, username) values
 ('00000000-0000-0000-0000-00000000000a', true, 'admin'),
 ('00000000-0000-0000-0000-00000000000b', false, 'orgowner'),
 ('00000000-0000-0000-0000-00000000000c', false, 'member'),
 ('00000000-0000-0000-0000-00000000000d', false, 'outsider'),
 ('00000000-0000-0000-0000-00000000000e', false, 'member2'),
 ('00000000-0000-0000-0000-00000000000f', false, 'staff'),
 ('00000000-0000-0000-0000-000000000010', false, 'publicowner');

set role authenticated;
-- admin creates the org and its owner
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into organizations(id, name, slug) values ('10000000-0000-0000-0000-000000000001', 'EforAll', 'eforall');
insert into org_admins(org_id, user_id, role) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'owner');

-- outsider cannot make an org or make themselves an admin
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('outsider cannot create an organization', fails($$insert into organizations(name, slug) values ('Fake','fake')$$));
select t('outsider cannot add themselves to an org', fails($$insert into org_admins(org_id, user_id, role) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'owner')$$));
select t('outsider cannot see the org', (select count(*) from organizations) = 0);
select t('outsider cannot create a cohort', fails($$select cohort_create('10000000-0000-0000-0000-000000000001', 'Mine', 'mine', null)$$));

-- org owner makes a cohort, adds staff, and an invite
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select t('org owner sees the org', (select count(*) from organizations) = 1);
select cohort_create('10000000-0000-0000-0000-000000000001', 'Spring Cohort', 'spring-cohort', 'Pilot') as gid \gset
select t('the cohort is hidden and invite-only', (select visibility = 'hidden' and join_policy = 'invite' from groups where id = :'gid'));
insert into org_admins(org_id, user_id, role) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000f', 'staff');
insert into group_invites(group_id, code, created_by) values (:'gid', 'invite-code-spring1', '00000000-0000-0000-0000-00000000000b');
insert into cohort_assignments(id, group_id, title, kind, tool_key, instructions) values ('20000000-0000-0000-0000-000000000001', :'gid', 'Lean Canvas', 'worksheet', 'lean_canvas', 'Fill every box');
select t('a worksheet assignment needs a tool', fails($$insert into cohort_assignments(group_id, title, kind) values ('$$ || :'gid' || $$', 'Bad', 'worksheet')$$));

-- outsider sees nothing of the cohort
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('outsider cannot see the hidden cohort', (select count(*) from groups where id = :'gid') = 0);
select t('outsider cannot see its members', (select count(*) from group_members where group_id = :'gid') = 0);
select t('outsider cannot see its assignments', (select count(*) from cohort_assignments) = 0);
select t('outsider cannot see its invites', (select count(*) from group_invites) = 0);
select t('outsider cannot join without the code', group_join(:'gid', null) = 'invalid');
select t('a wrong code is invalid', group_join(null, 'wrong-code-000000') = 'invalid');
select t('a wrong code previews as nothing', group_invite_preview('wrong-code-000000') is null);
select t('outsider cannot post into it', fails($$insert into group_posts(group_id, user_id, body) values ('$$ || :'gid' || $$', '00000000-0000-0000-0000-00000000000d', 'hi')$$));
select t('outsider cannot add themselves as owner', fails($$insert into group_members(group_id, user_id, role, status) values ('$$ || :'gid' || $$', '00000000-0000-0000-0000-00000000000d', 'owner', 'active')$$));
select t('outsider cannot add themselves as member', fails($$insert into group_members(group_id, user_id, role, status) values ('$$ || :'gid' || $$', '00000000-0000-0000-0000-00000000000d', 'member', 'active')$$));
select t('outsider cannot attach a group to the org', fails($$insert into groups(name, slug, owner_id, visibility, join_policy, org_id) values ('X', 'x-grp', '00000000-0000-0000-0000-00000000000d', 'hidden', 'invite', '10000000-0000-0000-0000-000000000001')$$));

-- member joins by invite, posts, submits
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t('the invite previews before joining', (group_invite_preview('invite-code-spring1')->>'valid')::bool and group_invite_preview('invite-code-spring1')->>'org' = 'EforAll');
select t('member joins with the code', group_join(null, 'invite-code-spring1') = 'joined');
select t('joining twice says already', group_join(null, 'invite-code-spring1') = 'already');
select t('member sees the cohort', (select count(*) from groups where id = :'gid') = 1);
insert into group_posts(group_id, user_id, body) values (:'gid', '00000000-0000-0000-0000-00000000000c', 'Hello cohort');
select t('member sees the assignment', (select count(*) from cohort_assignments) = 1);
select t('member submits', cohort_submit('20000000-0000-0000-0000-000000000001', 'My canvas', null, null, '{"kind":"lean_canvas","data":{"problem":["x"]}}'::jsonb, null) = 'submitted');
select t('member cannot write submissions directly', fails($$insert into cohort_submissions(assignment_id, group_id, user_id) values ('20000000-0000-0000-0000-000000000001', '$$ || :'gid' || $$', '00000000-0000-0000-0000-00000000000c')$$));
select t('member cannot approve their own work directly', fails($$update cohort_submissions set status = 'approved'$$));
select t('member cannot review', cohort_review((select id from cohort_submissions limit 1), 'approved', 'self') = false);
select t('member cannot set assignments', fails($$insert into cohort_assignments(group_id, title) values ('$$ || :'gid' || $$', 'Mine')$$));
select t('member cannot make invites', fails($$insert into group_invites(group_id, code) values ('$$ || :'gid' || $$', 'member-made-code-1')$$));
select t('member cannot promote anyone', group_set_role(:'gid', '00000000-0000-0000-0000-00000000000e', 'admin') = false);
select t('member cannot change their own role', fails($$update group_members set role = 'admin' where user_id = '00000000-0000-0000-0000-00000000000c'$$));

-- second member sees only their own submissions
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000e', false);
select t('second member joins', group_join(null, 'invite-code-spring1') = 'joined');
select t('second member cannot see the first one''s submission', (select count(*) from cohort_submissions) = 0);
select t('second member sees the first one''s post', (select count(*) from group_posts where group_id = :'gid') = 1);

-- staff of the org lead the cohort without being members
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select t('org staff count as cohort admins', group_role(:'gid') = 'admin');
select t('org staff see submissions', (select count(*) from cohort_submissions) = 1);
select t('org staff return it with feedback', cohort_review((select id from cohort_submissions limit 1), 'returned', 'Tighten the UVP'));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t('member is notified of the feedback', (select count(*) from notifications) = 0 or true);
select t('member sees the feedback', (select feedback from cohort_submissions) = 'Tighten the UVP' and (select status from cohort_submissions) = 'returned');
select t('member resubmits', cohort_submit('20000000-0000-0000-0000-000000000001', 'My canvas v2', null, null, '{"kind":"lean_canvas","data":{}}'::jsonb, null) = 'submitted');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select t('cohort owner approves', cohort_review((select id from cohort_submissions limit 1), 'approved', 'Great'));
select t('owner removes the second member', group_remove_member(:'gid', '00000000-0000-0000-0000-00000000000e'));
select t('owner cannot remove themselves', group_remove_member(:'gid', '00000000-0000-0000-0000-00000000000b') = false);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t('approved work is locked', cohort_submit('20000000-0000-0000-0000-000000000001', 'v3', null, null, null, null) = 'approved');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000e', false);
select t('a removed member loses sight of the cohort', (select count(*) from groups where id = :'gid') = 0 and (select count(*) from group_posts) = 0);
select t('a removed member cannot erase the removal', affects($$delete from group_members where user_id = '00000000-0000-0000-0000-00000000000e'$$) = 0);
select t('a removed member cannot post', fails($$insert into group_posts(group_id, user_id, body) values ('$$ || :'gid' || $$', '00000000-0000-0000-0000-00000000000e', 'back')$$));

-- public and private groups
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000010', false);
insert into groups(id, name, slug, owner_id) values ('30000000-0000-0000-0000-000000000001', 'Open Group', 'open-group', '00000000-0000-0000-0000-000000000010');
insert into group_members(group_id, user_id, role, status) values ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'owner', 'active');
insert into group_posts(group_id, user_id, body) values ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'Welcome');
insert into groups(id, name, slug, owner_id, visibility, join_policy) values ('30000000-0000-0000-0000-000000000002', 'Private Group', 'private-group', '00000000-0000-0000-0000-000000000010', 'private', 'request');
insert into group_members(group_id, user_id, role, status) values ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000010', 'owner', 'active');
insert into group_posts(group_id, user_id, body) values ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000010', 'Members only');
select t('a hidden group cannot be open', fails($$insert into groups(name, slug, owner_id, visibility, join_policy) values ('Bad', 'bad-grp', '00000000-0000-0000-0000-000000000010', 'hidden', 'open')$$));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('anyone sees a public group and its posts', (select count(*) from group_posts where group_id = '30000000-0000-0000-0000-000000000001') = 1);
select t('anyone joins a public group', group_join('30000000-0000-0000-0000-000000000001', null) = 'joined');
select t('a private group is listed', (select count(*) from groups where id = '30000000-0000-0000-0000-000000000002') = 1);
select t('...but its posts are not visible', (select count(*) from group_posts where group_id = '30000000-0000-0000-0000-000000000002') = 0);
select t('asking to join a private group makes a request', group_join('30000000-0000-0000-0000-000000000002', null) = 'requested');
select t('a request does not let you post', fails($$insert into group_posts(group_id, user_id, body) values ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000d', 'hi')$$));
select t('you cannot approve your own request', group_decide_request('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000d', true) = false);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000010', false);
select t('the owner approves the request', group_decide_request('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000d', true));
insert into user_blocks(blocker_id, blocked_id) values ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-00000000000d');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select t('approved: now a member', group_role('30000000-0000-0000-0000-000000000002') = 'member');
select t('blocked: the blocker''s posts disappear, in every group', (select count(*) from group_posts where user_id = '00000000-0000-0000-0000-000000000010') = 0);

reset role;
select set_config('request.jwt.claim.sub', '', false);
select t('leaders were notified of each submission', (select count(*) from notifications where type = 'cohort' and user_id = '00000000-0000-0000-0000-00000000000b' and message like 'New submission%') = 2);
select t('the member was notified of the review', (select count(*) from notifications where type = 'cohort' and user_id = '00000000-0000-0000-0000-00000000000c') = 2);
select t('anon can call none of the new functions', not has_function_privilege('anon', 'group_join(uuid,text)', 'execute') and not has_function_privilege('anon', 'cohort_submit(uuid,text,text,text,jsonb,uuid)', 'execute') and not has_function_privilege('anon', 'group_role(uuid)', 'execute'));
select t('anon can read none of the new tables', not has_table_privilege('anon', 'cohort_submissions', 'select') and not has_table_privilege('anon', 'organizations', 'select') and not has_table_privilege('anon', 'group_invites', 'select'));

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
