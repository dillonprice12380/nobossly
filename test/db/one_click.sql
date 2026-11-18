\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated, service_role; grant usage on sequence _results_n_seq to anon, authenticated, service_role;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated, service_role;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to anon, authenticated, service_role;
create function as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, false) $$;
grant execute on function as_user(uuid) to anon, authenticated, service_role;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'ana');

set role service_role;
select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'supabase', 'supabase', 'Supabase', 'my-app', '{"mode":"oauth","access_token":"FAKE-1"}');
select t('a Supabase sign-in is stored', (select kind from data_connections) = 'supabase');
update data_connections set config = '{"schema":"auth","table":"users"}', status = 'active';
select t('the server can replace its secret in place', data_connection_set_secret((select id from data_connections), '{"mode":"oauth","access_token":"FAKE-2"}'));
select t('...keeping what the member chose', (select config->>'table' from data_connections) = 'users' and (select status from data_connections) = 'active' and (select data_connection_secret(id) from data_connections) like '%FAKE-2%');
select data_connection_store(null, '00000000-0000-0000-0000-00000000000a', 'planetscale', 'planetscale', 'PlanetScale', 'org', '{"mode":"oauth","access_token":"FAKE-3"}');
select t('a PlanetScale sign-in waiting for a database is stored', (select count(*) from data_connections where kind = 'planetscale') = 1);
select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'stripe', '{"mode":"oauth","access_token":"FAKE-STRIPE"}', 'Stripe', null);
select t('a Stripe sign-in is stored by the server', (select payment_connection_secret(id) from payment_connections where provider = 'stripe') like '%FAKE-STRIPE%');
reset role;

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('a member cannot replace a secret', fails($q$select data_connection_set_secret((select id from data_connections limit 1), 'xxxxxxxxxxxx')$q$));
select t('...or store a Stripe sign-in themselves', fails($q$select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'stripe', 'xxxxxxxxxxxx', 'x', null)$q$));
reset role;
select t('other kinds are still refused', fails($q$insert into data_connections(user_id, kind) values ('00000000-0000-0000-0000-00000000000a', 'oracle')$q$));

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
