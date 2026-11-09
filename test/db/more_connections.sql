\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated, service_role; grant usage on sequence _results_n_seq to anon, authenticated, service_role;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated, service_role;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to anon, authenticated, service_role;
create function changed(sql text) returns int language plpgsql as $$ declare n int; begin execute sql; get diagnostics n = row_count; return n; end $$;
grant execute on function changed(text) to anon, authenticated, service_role;
create function as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, false) $$;
grant execute on function as_user(uuid) to anon, authenticated, service_role;
-- A fake Plaid token, assembled so secret scanners leave it alone.
create function fake_token(tail text) returns text language sql immutable as $$ select 'access-' || 'sandbox-' || 'FAKE' || repeat('0', 12) || tail $$;
grant execute on function fake_token(text) to anon, authenticated, service_role;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'ana'), ('00000000-0000-0000-0000-00000000000b', 'ben');

-- Shopify, Gumroad, Square: stored by the server only.
set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('a member cannot store a connection secret themselves', fails($q$select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'shopify', 'secret-secret-secret', 'x', '{}')$q$));
reset role;
set role service_role;
select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'shopify', '{"client_id":"abc","client_secret":"shpss_FAKE0000000000"}', 'ana-shop.myshopify.com', '{"shop":"ana-shop.myshopify.com"}');
select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'gumroad', 'gumroad-token-FAKE-000', 'Ana on Gumroad', null);
select t('the server stores a Shopify and a Gumroad connection', (select count(*) from payment_connections where user_id = '00000000-0000-0000-0000-00000000000a') = 2);
select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'gumroad', 'gumroad-token-FAKE-111', 'Ana on Gumroad', null);
select t('...reconnecting replaces the secret in place', (select count(*) from payment_connections where provider = 'gumroad') = 1 and (select payment_connection_secret(id) from payment_connections where provider = 'gumroad') = 'gumroad-token-FAKE-111');
select t('unknown providers are refused', fails($q$select payment_connection_store('00000000-0000-0000-0000-00000000000a', 'venmo', 'secret-secret', 'x', null)$q$));
reset role;
set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('the member sees the store name but not where the secret is', (select account_label from payment_connections where provider = 'shopify') = 'ana-shop.myshopify.com' and fails($q$select secret_id from payment_connections$q$) and fails($q$select meta from payment_connections$q$));
select t('...and can disconnect', payment_disconnect('gumroad') = true);
select t('...which removes the connection', (select count(*) from payment_connections where provider = 'gumroad') = 0);
reset role;
select t('the Gumroad secret is gone from the vault', not exists (select 1 from vault.secrets where secret like 'gumroad-token%'));

-- Banks.
set role service_role;
select t('only a Plaid-shaped token is stored', fails($q$select bank_connection_store('00000000-0000-0000-0000-00000000000a', 'item-1', 'Bank', '[]', 'not-a-token')$q$));
select bank_connection_store('00000000-0000-0000-0000-00000000000a', 'item-1', 'Chase', '[{"name":"Business checking","mask":"1234"}]', fake_token('1'));
select t('the server stores a bank connection', (select count(*) from bank_connections) = 1 and bank_connection_secret((select id from bank_connections)) = fake_token('1'));
select t('...that another member cannot take over', fails($q$select bank_connection_store('00000000-0000-0000-0000-00000000000b', 'item-1', 'Chase', '[]', fake_token('2'))$q$));
select bank_connection_store('00000000-0000-0000-0000-00000000000a', 'item-' || i, 'Bank ' || i, '[]', fake_token(i::text)) from generate_series(2, 5) i;
select t('five banks at most', fails($q$select bank_connection_store('00000000-0000-0000-0000-00000000000a', 'item-6', 'Bank 6', '[]', fake_token('6'))$q$));
insert into bank_transactions(user_id, connection_id, external_id, posted_on, amount, direction, name)
  select '00000000-0000-0000-0000-00000000000a', (select id from bank_connections where item_id = 'item-1'), 'plaid:tx' || i, ('2026-11-0' || i)::date, 100 * i, case when i % 2 = 0 then 'out' else 'in' end, 'Payee ' || i from generate_series(1, 4) i;
select t('the sync fills the inbox, never the same transaction twice', fails($q$insert into bank_transactions(user_id, external_id, posted_on, amount, direction) values ('00000000-0000-0000-0000-00000000000a', 'plaid:tx1', '2026-11-01', 1, 'in')$q$));
reset role;

set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
select t('a member sees their banks, not the token or the cursor', (select count(*) from bank_connections) = 5 and fails($q$select secret_id from bank_connections$q$) and fails($q$select sync_cursor from bank_connections$q$));
select t('...cannot read a bank token', fails($q$select bank_connection_secret(id) from bank_connections$q$));
select t('...cannot add a bank by hand', fails($q$insert into bank_connections(user_id, item_id) values ('00000000-0000-0000-0000-00000000000a', 'x')$q$));
select t('they see their inbox', (select count(*) from bank_transactions where status = 'new') = 4);
update bank_transactions set status = 'income', decided_at = now() where external_id = 'plaid:tx1';
select t('...and decide what each one is', (select status from bank_transactions where external_id = 'plaid:tx1') = 'income');
select t('...but cannot change the amount or invent one', fails($q$update bank_transactions set amount = 999 where external_id = 'plaid:tx3'$q$) and fails($q$insert into bank_transactions(user_id, external_id, posted_on, amount, direction) values ('00000000-0000-0000-0000-00000000000a', 'x', '2026-11-01', 5, 'in')$q$));
insert into expenses(user_id, category, amount, spent_at, external_id) values ('00000000-0000-0000-0000-00000000000a', 'Software', 200, '2026-11-02', 'plaid:tx2');
select t('a bank expense is logged once', fails($q$insert into expenses(user_id, category, amount, spent_at, external_id) values ('00000000-0000-0000-0000-00000000000a', 'Software', 200, '2026-11-02', 'plaid:tx2')$q$));
select as_user('00000000-0000-0000-0000-00000000000b');
select t('another member sees none of it and changes nothing', (select count(*) from bank_transactions) = 0 and (select count(*) from bank_connections) = 0
  and changed($q$update bank_transactions set status = 'ignored'$q$) = 0 and bank_disconnect((select id from bank_connections limit 1)) is distinct from true);
select as_user('00000000-0000-0000-0000-00000000000a');
select t('disconnecting a bank works', bank_disconnect((select id from bank_connections where institution = 'Chase')) = true);
select t('...it removes what was still waiting and keeps what was decided', (select count(*) from bank_transactions where status = 'new') = 0 and (select count(*) from bank_transactions where status = 'income') = 1 and (select count(*) from bank_connections) = 4);
reset role;
select t('...and its token leaves the vault', not exists (select 1 from vault.secrets where secret = fake_token('1')));
set role anon;
select t('signed-out visitors see nothing', fails($q$select count(*) from bank_transactions$q$) and fails($q$select count(*) from bank_connections$q$));
reset role;

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
