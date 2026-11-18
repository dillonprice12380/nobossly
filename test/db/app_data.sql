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

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('a member cannot store a database secret themselves', fails($q$select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'postgres', 'neon', 'x', 'h', 'postgresql://ro:pw@h/db')$q$));
select t('...or write a connection directly', fails($q$insert into data_connections(user_id, kind) values ('00000000-0000-0000-0000-00000000000a', 'postgres')$q$));
reset role;

set role service_role;
select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'postgres', 'supabase', 'My app', 'db.abc.supabase.co', 'postgresql://ro:FAKE@db.abc.supabase.co/postgres');
select t('the server stores a connection, waiting to be set up', (select status from data_connections where user_id = '00000000-0000-0000-0000-00000000000a') = 'setup');
select t('...its secret is in the Vault', (select data_connection_secret(id) from data_connections where user_id = '00000000-0000-0000-0000-00000000000a') like 'postgresql://ro:FAKE%');
select data_connection_store((select id from data_connections where user_id = '00000000-0000-0000-0000-00000000000a'), '00000000-0000-0000-0000-00000000000a', 'postgres', 'supabase', 'My app', 'db.abc.supabase.co', 'postgresql://ro:NEW@db.abc.supabase.co/postgres');
select t('replacing keeps one connection with the new secret', (select count(*) from data_connections) = 1 and (select data_connection_secret(id) from data_connections) like '%NEW%');
select t('another member cannot replace it', fails($q$select data_connection_store((select id from data_connections limit 1), '00000000-0000-0000-0000-00000000000b', 'postgres', 'x', 'x', 'x', 'postgresql://x:y@z/db')$q$));
select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'mysql', 'planetscale', 'Two', 'h2', 'mysql://ro:FAKE@h2/db');
select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'wordpress', 'wordpress', 'Three', 'h3', '{"url":"https://x.com","user":"a","password":"FAKE FAKE"}');
select t('three at most', fails($q$select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'firebase', 'firebase', 'Four', 'h4', '{"project_id":"p"}')$q$));
select t('unknown kinds are refused', fails($q$select data_connection_store(null, '00000000-0000-0000-0000-00000000000b', 'oracle', 'x', 'x', 'x', 'secretsecret')$q$));
update data_connections set status = 'active', config = '{"table":"auth.users"}' where provider = 'supabase';
insert into app_metrics(connection_id, user_id, day, total_users, new_users, active_7d, active_30d)
  select id, user_id, current_date, 120, 4, 30, 75 from data_connections where provider = 'supabase';
select t('the server writes daily numbers', (select total_users from app_metrics) = 120);
reset role;

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('a member reads their connections and numbers', (select count(*) from data_connections) = 3 and (select active_30d from app_metrics) = 75);
select t('...but not where the secret lives', fails($q$select secret_id from data_connections$q$));
select t('...and cannot read the secret', fails($q$select data_connection_secret(id) from data_connections$q$));
select t('...or change the numbers', fails($q$update app_metrics set total_users = 9999$q$));
select as_user('00000000-0000-0000-0000-00000000000b');
select t('another member sees none of it', (select count(*) from data_connections) = 0 and (select count(*) from app_metrics) = 0);
select t('...and cannot disconnect it', not data_disconnect((select id from data_connections limit 1)));
select as_user('00000000-0000-0000-0000-00000000000a');
select t('disconnecting works', data_disconnect((select id from data_connections where provider = 'supabase')));
reset role;
select t('...the numbers and the secret go with it', (select count(*) from app_metrics) = 0 and (select count(*) from data_connections) = 2 and (select count(*) from vault.secrets where description like 'Read-only app database%') = 2);

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
