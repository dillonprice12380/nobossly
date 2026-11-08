\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated, service_role; grant usage on sequence _results_n_seq to anon, authenticated, service_role;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated, service_role;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to anon, authenticated, service_role;
-- Fake keys, assembled so secret scanners do not take them for real ones.
create function fake_key(kind text, mode text, tail text) returns text language sql immutable as $$ select kind || '_' || mode || '_FAKE' || repeat('x', 24) || tail $$;
grant execute on function fake_key(text, text, text) to anon, authenticated, service_role;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'mo'), ('00000000-0000-0000-0000-00000000000b', 'bo');

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select t('a full secret key is refused', fails($$select payment_connect_stripe(fake_key('sk', 'live', '0000'))$$));
select t('a test-mode key is refused', fails($$select payment_connect_stripe(fake_key('rk', 'test', '0000'))$$));
select t('a live restricted key connects', payment_connect_stripe(fake_key('rk', 'live', '1234')) is not null);
select t('the member sees their connection and the last four characters', (select key_hint from payment_connections) = '1234' and (select status from payment_connections) = 'active');
select t('...but cannot see where the key is kept', fails($$select secret_id from payment_connections$$));
select t('...cannot read the key back', fails($$select payment_connection_secret(id) from payment_connections$$));
select t('...cannot read the vault', fails($$select * from vault.decrypted_secrets$$));
select t('...and cannot write the table directly', fails($$update payment_connections set status = 'error'$$) and fails($$insert into payment_connections(user_id, provider) values ('00000000-0000-0000-0000-00000000000a', 'stripe')$$) and fails($$delete from payment_connections$$));
select payment_connect_stripe(fake_key('rk', 'live', '9876'));
select t('replacing the key keeps one connection', (select count(*) from payment_connections) = 1 and (select key_hint from payment_connections) = '9876');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select t('another member sees none of it', (select count(*) from payment_connections) = 0);
select t('...and their disconnect touches nothing of mine', payment_disconnect('stripe') = false);
reset role;
select t('one key in the vault, replaced in place', (select count(*) from vault.secrets) = 1 and (select secret from vault.secrets) = fake_key('rk', 'live', '9876'));

set role service_role;
select t('the sync job can read the key', (select payment_connection_secret(id) from payment_connections) = fake_key('rk', 'live', '9876'));
reset role;

-- A synced payment is logged once.
insert into revenue_entries(user_id, amount, entry_date, source, external_id) values ('00000000-0000-0000-0000-00000000000a', 29, '2026-11-02', 'Stripe', 'stripe:ch_1');
select t('the same Stripe payment cannot be logged twice', fails($$insert into revenue_entries(user_id, amount, entry_date, source, external_id) values ('00000000-0000-0000-0000-00000000000a', 29, '2026-11-02', 'Stripe', 'stripe:ch_1')$$));
insert into revenue_entries(user_id, amount, entry_date, source, external_id) values ('00000000-0000-0000-0000-00000000000a', 29, '2026-11-02', 'Stripe', 'stripe:ch_1'), ('00000000-0000-0000-0000-00000000000a', 9, '2026-11-03', 'Stripe', 'stripe:ch_2')
  on conflict (user_id, external_id) do nothing;
select t('the sync''s upsert (on conflict user_id, external_id) skips the known one and adds the new one', (select count(*) from revenue_entries where external_id like 'stripe:%') = 2);
select t('...while hand-logged payments, with no id, can repeat', not fails($$insert into revenue_entries(user_id, amount, entry_date, source) values ('00000000-0000-0000-0000-00000000000a', 5, '2026-11-02', 'Cash'), ('00000000-0000-0000-0000-00000000000a', 5, '2026-11-02', 'Cash')$$));

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select t('disconnecting says it did', payment_disconnect('stripe') = true);
select t('...and removes the connection', (select count(*) from payment_connections) = 0);
reset role;
select t('...deletes the key from the vault', (select count(*) from vault.secrets) = 0);
select t('...and keeps the payments already logged', (select count(*) from revenue_entries where external_id = 'stripe:ch_1') = 1);

set role anon;
select t('signed-out visitors cannot connect anything', fails($$select payment_connect_stripe(fake_key('rk', 'live', '1234'))$$));
reset role;

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
