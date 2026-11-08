\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to public; grant usage on sequence _results_n_seq to public;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
create function changed(sql text) returns int language plpgsql as $$ declare n int; begin execute sql; get diagnostics n = row_count; return n; end $$;
create function as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, false) $$;

insert into profiles(id, username, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'ana', 'Ana'),
  ('00000000-0000-0000-0000-00000000000b', 'ben', 'Ben'),
  ('00000000-0000-0000-0000-00000000000c', 'cy', 'Cy'),
  ('00000000-0000-0000-0000-00000000000d', 'dee', 'Dee');
insert into forum_categories(id, slug, name) values ('00000000-0000-0000-0000-0000000000c1', 'questions', 'Questions');

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
insert into forum_threads(id, category_id, user_id, title, body) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'How do you price a logo?', 'Help');
select t('the asker follows their own question', exists (select 1 from forum_follows where thread_id = '00000000-0000-0000-0000-0000000000f1' and user_id = '00000000-0000-0000-0000-00000000000a'));

select as_user('00000000-0000-0000-0000-00000000000b');
insert into forum_replies(id, thread_id, user_id, body) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000b', 'By the hour at first');
reset role;
select t('a reply to someone else''s thread moves its count and last reply', (select reply_count from forum_threads where id = '00000000-0000-0000-0000-0000000000f1') = 1 and (select last_reply_at from forum_threads where id = '00000000-0000-0000-0000-0000000000f1') is not null);
select t('the asker hears about it', (select message from notifications where user_id = '00000000-0000-0000-0000-00000000000a' and type = 'forum_reply') = 'Ben replied to your question "How do you price a logo?"');
select t('the replier now follows the thread', exists (select 1 from forum_follows where thread_id = '00000000-0000-0000-0000-0000000000f1' and user_id = '00000000-0000-0000-0000-00000000000b'));

-- Cy follows; Ana blocked Dee.
insert into forum_follows(user_id, thread_id) values ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000f1');
insert into user_blocks(blocker_id, blocked_id) values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000d');
delete from notifications;
set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000d');
insert into forum_replies(id, thread_id, user_id, body) values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000d', 'Per project');
reset role;
select t('followers hear about a reply, the writer does not', (select count(*) from notifications where user_id in ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c')) = 2 and not exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-00000000000d'));
select t('...and nobody hears from someone they blocked', not exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-00000000000a'));
select t('...the follower''s message says where', (select message from notifications where user_id = '00000000-0000-0000-0000-00000000000c') = 'Dee replied in "How do you price a logo?"');

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000c');
select t('a member sees only their own follows', (select count(*) from forum_follows) = 1);
select t('...and cannot follow on someone else''s behalf', fails($q$insert into forum_follows(user_id, thread_id) values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000f1')$q$));
select t('someone else cannot mark the answer', changed($q$update forum_threads set accepted_reply_id = '00000000-0000-0000-0000-0000000000e1' where id = '00000000-0000-0000-0000-0000000000f1'$q$) = 0);
select forum_thread_viewed('00000000-0000-0000-0000-0000000000f1');
select t('...but anyone reading it counts as a view', (select view_count from forum_threads where id = '00000000-0000-0000-0000-0000000000f1') = 1);
select as_user('00000000-0000-0000-0000-00000000000a');
update forum_threads set accepted_reply_id = '00000000-0000-0000-0000-0000000000e1' where id = '00000000-0000-0000-0000-0000000000f1';
select t('the asker marks the reply that helped', (select accepted_reply_id from forum_threads where id = '00000000-0000-0000-0000-0000000000f1') = '00000000-0000-0000-0000-0000000000e1');
insert into forum_threads(id, category_id, user_id, title, body) values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', 'Another', 'x');
select t('a reply from another thread cannot be marked', fails($q$update forum_threads set accepted_reply_id = '00000000-0000-0000-0000-0000000000e1' where id = '00000000-0000-0000-0000-0000000000f2'$q$));
select as_user('00000000-0000-0000-0000-00000000000b');
delete from forum_replies where id = '00000000-0000-0000-0000-0000000000e1';
reset role;
select t('deleting the accepted reply clears the mark and the count', (select accepted_reply_id is null and reply_count = 1 from forum_threads where id = '00000000-0000-0000-0000-0000000000f1'));

-- Co-working.
set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
insert into coworking_sessions(id, host_id, title, starts_at, minutes, capacity) values ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-00000000000a', 'Tuesday evening focus hour', now() + interval '2 days', 60, 2);
insert into coworking_links(session_id, link) values ('00000000-0000-0000-0000-0000000005e1', 'https://meet.example.com/abc-defg');
insert into coworking_rsvps(session_id, user_id) values ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-00000000000a');
select t('a member hosts a session and sees its link', (select count(*) from coworking_links) = 1);
select t('a session in the past is refused', fails($q$insert into coworking_sessions(host_id, title, starts_at) values ('00000000-0000-0000-0000-00000000000a', 'Too late', now() - interval '1 hour')$q$));
select t('...as is one more than 60 days out', fails($q$insert into coworking_sessions(host_id, title, starts_at) values ('00000000-0000-0000-0000-00000000000a', 'Too far', now() + interval '70 days')$q$));
select t('...and one hosted in someone else''s name', fails($q$insert into coworking_sessions(host_id, title, starts_at) values ('00000000-0000-0000-0000-00000000000b', 'Not me', now() + interval '1 day')$q$));
select t('a link has to be https', fails($q$insert into coworking_sessions(id, host_id, title, starts_at) values ('00000000-0000-0000-0000-0000000005e9', '00000000-0000-0000-0000-00000000000a', 'Link test', now() + interval '1 day'); insert into coworking_links values ('00000000-0000-0000-0000-0000000005e9', 'javascript:alert(1)')$q$));
insert into coworking_sessions(host_id, title, starts_at) select '00000000-0000-0000-0000-00000000000a', 'Session ' || i, now() + make_interval(days => i + 3) from generate_series(1, 4) i;
select t('five upcoming sessions per host at most', fails($q$insert into coworking_sessions(host_id, title, starts_at) values ('00000000-0000-0000-0000-00000000000a', 'Sixth', now() + interval '20 days')$q$));

select as_user('00000000-0000-0000-0000-00000000000b');
select t('before RSVPing, another member sees the session but not the link', (select count(*) from coworking_sessions where id = '00000000-0000-0000-0000-0000000005e1') = 1 and (select count(*) from coworking_links) = 0);
insert into coworking_rsvps(session_id, user_id) values ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-00000000000b');
select t('after RSVPing, the link shows', (select link from coworking_links where session_id = '00000000-0000-0000-0000-0000000005e1') = 'https://meet.example.com/abc-defg');
select t('they cannot change the session', changed($q$update coworking_sessions set title = 'Mine now' where id = '00000000-0000-0000-0000-0000000005e1'$q$) = 0);
select t('...or mark themselves reminded', fails($q$update coworking_rsvps set reminded_at = now() where user_id = '00000000-0000-0000-0000-00000000000b'$q$));
select as_user('00000000-0000-0000-0000-00000000000c');
select t('a full session takes no more RSVPs', fails($q$insert into coworking_rsvps(session_id, user_id) values ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-00000000000c')$q$));
select t('nobody RSVPs for someone else', fails($q$insert into coworking_rsvps(session_id, user_id) values ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-00000000000d')$q$));
select as_user('00000000-0000-0000-0000-00000000000a');
update coworking_sessions set cancelled_at = now() where id = '00000000-0000-0000-0000-0000000005e1';
select as_user('00000000-0000-0000-0000-00000000000b');
delete from coworking_rsvps where session_id = '00000000-0000-0000-0000-0000000005e1' and user_id = '00000000-0000-0000-0000-00000000000b';
select as_user('00000000-0000-0000-0000-00000000000c');
select t('a cancelled session takes no RSVPs', fails($q$insert into coworking_rsvps(session_id, user_id) values ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-00000000000c')$q$));
reset role;
set role anon;
select t('signed-out visitors see no sessions', fails($q$select count(*) from coworking_sessions$q$));
reset role;
set role service_role;
update coworking_rsvps set reminded_at = now() where user_id = '00000000-0000-0000-0000-00000000000a';
select t('the server marks reminders sent', (select count(*) from coworking_rsvps where reminded_at is not null) = 1);
reset role;

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
