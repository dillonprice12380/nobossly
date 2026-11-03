\set ON_ERROR_STOP 1
create table _results(n serial, label text, ok bool);
grant all on _results to anon, authenticated; grant usage on sequence _results_n_seq to anon, authenticated;
create function t(label text, cond boolean) returns void language sql as $$ insert into _results(label, ok) values (label, coalesce(cond,false)) $$;
grant execute on function t(text, boolean) to anon, authenticated;
create function fails(sql text) returns boolean language plpgsql as $$ begin execute sql; return false; exception when others then return true; end $$;
grant execute on function fails(text) to anon, authenticated;

insert into profiles(id, username) values ('00000000-0000-0000-0000-00000000000a', 'mo'), ('00000000-0000-0000-0000-00000000000b', 'bo');
insert into path_news(path, topic, label, title, url, published_at) values ('creator', 'creator_instagram', 'Instagram', 'Instagram tests long-form video', 'https://news.example/1', now());

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select t('members can read the news', (select count(*) from path_news) = 1);
select t('members cannot add news', fails($$insert into path_news(path, topic, label, title, url, published_at) values ('creator','x_y','X','Fake','https://evil.example', now())$$));
select t('members cannot change news', fails($$update path_news set title = 'Changed'$$));
select t('members cannot delete news', fails($$delete from path_news$$));
select t('alerts are on by default', (select news_alerts from profiles where id = '00000000-0000-0000-0000-00000000000a'));
reset role;
select t('a news notification is allowed', not fails($$insert into notifications(user_id, type, message) values ('00000000-0000-0000-0000-00000000000a', 'news', 'x')$$));
select t('links must be https', fails($$insert into path_news(path, topic, label, title, url, published_at) values ('creator','creator_x','X','T','javascript:alert(1)', now())$$));
select t('a link is stored once per path', fails($$insert into path_news(path, topic, label, title, url, published_at) values ('creator','creator_x','X','T','https://news.example/1', now())$$));
set role anon;
select t('signed-out visitors cannot read it', fails($$select * from path_news$$));
reset role;

select case when ok then '  ✓ ' else '  ✗ ' end || label from _results order by n;
select count(*) filter (where not ok) as failed, count(*) as total from _results;
