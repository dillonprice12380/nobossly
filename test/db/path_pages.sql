\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated; grant usage on sequence _results_n_seq to anon, authenticated;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated;
create function rejects(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when check_violation then return true; end $$;

insert into profiles(id, username, path) values
  ('00000000-0000-0000-0000-00000000000a', 'mo', 'freelancer'),
  ('00000000-0000-0000-0000-00000000000b', 'lu', 'freelancer'),
  ('00000000-0000-0000-0000-00000000000c', 'cy', 'creator');
insert into profiles(id, username, path, account_status) values ('00000000-0000-0000-0000-00000000000d', 'gone', 'freelancer', 'suspended');
insert into profiles(id, username, path, is_admin) values ('00000000-0000-0000-0000-00000000000e', 'admin', 'freelancer', true);
insert into forum_categories(slug, name) values ('general', 'General');
insert into forum_threads(user_id, category_id, title, reply_count, created_at) values
  ('00000000-0000-0000-0000-00000000000a', (select id from forum_categories), 'How do you price a logo?', 2, now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000000b', (select id from forum_categories), 'Invoicing late payers', 0, now() - interval '2 days'),
  ('00000000-0000-0000-0000-00000000000b', (select id from forum_categories), 'An old question', 1, now() - interval '200 days'),
  ('00000000-0000-0000-0000-00000000000c', (select id from forum_categories), 'Best mic?', 3, now()),
  ('00000000-0000-0000-0000-00000000000e', (select id from forum_categories), 'Introduce yourself', 5, now());
alter table coworking_sessions disable trigger user;
insert into coworking_sessions(host_id, title, starts_at, minutes, path) values
  ('00000000-0000-0000-0000-00000000000a', 'Freelancer focus hour', now() + interval '1 day', 60, 'freelancer'),
  ('00000000-0000-0000-0000-00000000000c', 'Everyone welcome', now() + interval '2 days', 60, null),
  ('00000000-0000-0000-0000-00000000000c', 'Creators only', now() + interval '3 days', 60, 'creator'),
  ('00000000-0000-0000-0000-00000000000a', 'Already over', now() - interval '3 days', 60, 'freelancer');
update coworking_sessions set cancelled_at = now() where title = 'Creators only';
alter table coworking_sessions enable trigger user;

set role anon;
select t('a visitor can read a path''s community', (public.path_community('freelancer')->>'members')::int = 3);
select t('...its questions from the last 90 days, by active members on the path, not the site''s starter threads', (public.path_community('freelancer')->>'questions')::int = 2 and (public.path_community('freelancer')->>'replied')::int = 1);
select t('...newest first, with titles and no names', public.path_community('freelancer')->'recent'->0->>'title' = 'How do you price a logo?' and not (public.path_community('freelancer')->'recent'->0 ? 'user_id') and jsonb_array_length(public.path_community('freelancer')->'recent') = 2);
select t('...and co-working coming up for that path or for everyone', (public.path_community('freelancer')->>'sessions')::int = 2 and (public.path_community('creator')->>'sessions')::int = 1);
select t('a made-up path gives nothing', public.path_community('x; drop table profiles') is null);
select t('the visitor still cannot read co-working sessions themselves', not has_table_privilege('anon', 'coworking_sessions', 'select'));
reset role;

update profiles set saved_paths = '{"creator":{"subpath":"video","answers":{"stage":"Posting occasionally"}}}' where username = 'mo';
select t('saved answers for another path keep', (select saved_paths->'creator'->>'subpath' from profiles where username = 'mo') = 'video');
select t('saved_paths has to be an object', rejects($q$update profiles set saved_paths = '[1]' where username = 'mo'$q$));
select t('and stays small', rejects($q$update profiles set saved_paths = jsonb_build_object('x', repeat('y', 13000)) where username = 'mo'$q$));

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
