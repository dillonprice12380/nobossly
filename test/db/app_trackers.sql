\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated, service_role; grant usage on sequence _results_n_seq to anon, authenticated, service_role;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated, service_role;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to anon, authenticated, service_role;
create function as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, false) $$;
grant execute on function as_user(uuid) to anon, authenticated, service_role;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'ana'), ('00000000-0000-0000-0000-00000000000b', 'ben');
set role service_role;
select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'supabase', 'supabase', 'Supabase', 'Job Board', '{"mode":"oauth","access_token":"FAKE-1"}');
update data_connections set config = jsonb_build_object('trackers', (select jsonb_agg(jsonb_build_object('key', 't' || i, 'label', repeat('x', 60), 'schema', 'public', 'table', 'jobs', 'filter', jsonb_build_object('column', 'role', 'value', repeat('y', 60)))) from generate_series(1, 12) i)), status = 'active';
select t('twelve trackers fit in what a member chooses', (select jsonb_array_length(config->'trackers') from data_connections) = 12);
insert into app_tracker_days(connection_id, user_id, tracker, day, total, new_items) select id, user_id, 't1', current_date, 5400, 12 from data_connections;
insert into app_tracker_days(connection_id, user_id, tracker, day, total, new_items) select id, user_id, 't2', current_date, 310, 3 from data_connections;
select t('the server writes each tracker''s day', (select count(*) from app_tracker_days) = 2);
select t('tracker names are kept simple', fails($q$insert into app_tracker_days(connection_id, user_id, tracker, day) select id, user_id, 'Bad Name!', current_date from data_connections$q$));
reset role;
set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('a member reads their own', (select sum(total) from app_tracker_days) = 5710);
select t('...and cannot change them', fails($q$update app_tracker_days set total = 1$q$) and fails($q$insert into app_tracker_days(connection_id, user_id, tracker, day) select id, user_id, 't9', current_date from data_connections$q$));
select as_user('00000000-0000-0000-0000-00000000000b');
select t('another member sees none of it', (select count(*) from app_tracker_days) = 0);
select as_user('00000000-0000-0000-0000-00000000000a');
select t('disconnecting takes the counts with it', data_disconnect((select id from data_connections)));
reset role;
select t('...all of them', (select count(*) from app_tracker_days) = 0);

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
