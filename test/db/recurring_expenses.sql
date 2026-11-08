\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to public; grant usage on sequence _results_n_seq to public;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
create function as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, false) $$;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'ana'), ('00000000-0000-0000-0000-00000000000b', 'ben');
set role authenticated;
select as_user('00000000-0000-0000-0000-00000000000a');
insert into recurring_expenses(id, user_id, category, amount, day_of_month, starts_on) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'Software', 29, 5, '2026-09-01');
insert into expenses(user_id, category, amount, spent_at, recurring_id, recurring_period) values ('00000000-0000-0000-0000-00000000000a', 'Software', 29, '2026-09-05', '00000000-0000-0000-0000-0000000000a1', '2026-09-01');
select t('a member sets a monthly cost and it is logged', (select count(*) from expenses where recurring_id is not null) = 1);
select t('the same month cannot be logged twice', fails($q$insert into expenses(user_id, category, amount, spent_at, recurring_id, recurring_period) values ('00000000-0000-0000-0000-00000000000a', 'Software', 29, '2026-09-05', '00000000-0000-0000-0000-0000000000a1', '2026-09-01')$q$));
select t('a period is the first of a month', fails($q$insert into expenses(user_id, category, amount, spent_at, recurring_id, recurring_period) values ('00000000-0000-0000-0000-00000000000a', 'Software', 29, '2026-10-05', '00000000-0000-0000-0000-0000000000a1', '2026-10-05')$q$));
select t('the day is 1 to 28, so every month has it', fails($q$insert into recurring_expenses(user_id, category, amount, day_of_month) values ('00000000-0000-0000-0000-00000000000a', 'Rent', 400, 31)$q$));
select t('the amount has to be positive', fails($q$insert into recurring_expenses(user_id, category, amount) values ('00000000-0000-0000-0000-00000000000a', 'Rent', 0)$q$));
insert into expenses(user_id, category, amount) values ('00000000-0000-0000-0000-00000000000a', 'Coffee', 4.5), ('00000000-0000-0000-0000-00000000000a', 'Ink', 12);
select t('ordinary expenses are unaffected by the constraint', (select count(*) from expenses where recurring_id is null) = 2);

select as_user('00000000-0000-0000-0000-00000000000b');
select t('nobody else sees the rule', (select count(*) from recurring_expenses) = 0);
select t('...or can tie their expense to it', fails($q$insert into expenses(user_id, category, amount, recurring_id, recurring_period) values ('00000000-0000-0000-0000-00000000000b', 'Software', 1, '00000000-0000-0000-0000-0000000000a1', '2026-11-01')$q$));
select t('...or set one up in someone else''s name', fails($q$insert into recurring_expenses(user_id, category, amount) values ('00000000-0000-0000-0000-00000000000a', 'Rent', 1)$q$));

select as_user('00000000-0000-0000-0000-00000000000a');
update recurring_expenses set stopped_at = now() where id = '00000000-0000-0000-0000-0000000000a1';
delete from recurring_expenses where id = '00000000-0000-0000-0000-0000000000a1';
select t('deleting a rule keeps what was already logged', (select count(*) from expenses where category = 'Software') = 1 and (select recurring_id from expenses where category = 'Software') is null);
reset role;
set role anon;
select t('signed-out visitors see nothing', fails($q$select count(*) from recurring_expenses$q$));
reset role;

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
