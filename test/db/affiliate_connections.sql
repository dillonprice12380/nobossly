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
select t('a member cannot store an affiliate key themselves', fails($q$select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'impact', '{"sid":"IRFAKE","token":"FAKE"}', 'x', null)$q$));
reset role;

set role service_role;
select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'impact', '{"sid":"IRFAKE0000","token":"FAKE-TOKEN-0000"}', 'Account IRFAKE…', null);
select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'travelpayouts', '{"token":"FAKE0000000000000000"}', 'Travelpayouts account', null);
select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'awin', '{"token":"FAKE-0000-0000-0000-0000"}', 'publisher 123', '{"publisher_id":"123"}');
select t('the server stores affiliate connections, one per network', (select count(*) from payment_connections where user_id = '00000000-0000-0000-0000-00000000000a') = 3);
select t('...the key is in the Vault', (select payment_connection_secret(id) from payment_connections where provider = 'travelpayouts') like '%FAKE%');
select t('every network in the list is accepted', not fails($q$select payment_connection_store('00000000-0000-0000-0000-00000000000b', p, '{"key":"FAKE00000000"}', 'x', null) from unnest(array['cj','rakuten','partnerstack','clickbank','admitad']) p$q$));
select t('...and others are refused', fails($q$select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'shareasale', '{"key":"FAKE00000000"}', 'x', null)$q$));
update payment_connections set pending = '{"amounts":{"USD":42.5},"count":3,"as_of":"2026-11-18T00:00:00Z"}' where provider = 'impact';
select t('the server records what is pending', (select pending->'amounts'->>'USD' from payment_connections where provider = 'impact') = '42.5');
select t('...and pending has to be an object', fails($q$update payment_connections set pending = '[1]' where provider = 'impact'$q$));
reset role;

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('a member reads their pending total', (select pending->>'count' from payment_connections where provider = 'impact') = '3');
select t('...but not where the key lives', fails($q$select secret_id from payment_connections$q$));
select t('...and cannot write the pending total', fails($q$update payment_connections set pending = '{}' where provider = 'impact'$q$));
select as_user('00000000-0000-0000-0000-00000000000b');
select t('another member sees none of it', (select count(*) from payment_connections where user_id = '00000000-0000-0000-0000-00000000000a') = 0);
select as_user('00000000-0000-0000-0000-00000000000a');
select t('disconnecting works', payment_disconnect('impact'));
select t('...and deletes the connection', (select count(*) from payment_connections where provider = 'impact') = 0);
reset role;
select t('...from the Vault too', (select count(*) from vault.secrets where name like 'payment_connection_impact_%') = 0);

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
