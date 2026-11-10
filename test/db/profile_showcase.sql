\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
create function rejects(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when check_violation then return true; end $$;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'mo');
update profiles set business_name = 'Mo Designs', offers = '[{"title":"Logo","price":"$300"}]', links = '[{"kind":"instagram","url":"https://instagram.com/mo"}]', privacy = '{"location":false}' where username = 'mo';
select t('a showcase and privacy choices save', (select offers->0->>'title' from profiles where username = 'mo') = 'Logo' and (select privacy->>'location' from profiles where username = 'mo') = 'false');
select t('seven offers are refused', rejects($q$update profiles set offers = (select jsonb_agg(jsonb_build_object('title', 'x' || i)) from generate_series(1, 7) i) where username = 'mo'$q$));
select t('links have to be a list', rejects($q$update profiles set links = '{"url":"https://x.com"}' where username = 'mo'$q$));
select t('privacy has to be an object', rejects($q$update profiles set privacy = '[true]' where username = 'mo'$q$));
select t('a long business name is refused', rejects($q$update profiles set business_name = repeat('x', 81) where username = 'mo'$q$));

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
