\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
create function rejects(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when check_violation then return true; end $$;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'mo');
select t('the column is there and starts empty', (select dashboard_layout from profiles where username = 'mo') is null);
update profiles set dashboard_layout = '{"order":["tools","challenges"],"hidden":["news"]}' where username = 'mo';
select t('a layout saves', (select dashboard_layout->'hidden'->>0 from profiles where username = 'mo') = 'news');
select t('a list instead of an object is refused', rejects($q$update profiles set dashboard_layout = '["tools"]' where username = 'mo'$q$));
select t('a huge value is refused', rejects($q$update profiles set dashboard_layout = jsonb_build_object('order', (select jsonb_agg(md5(i::text)) from generate_series(1, 200) i)) where username = 'mo'$q$));
update profiles set dashboard_layout = null where username = 'mo';
select t('null resets it', (select dashboard_layout from profiles where username = 'mo') is null);

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
