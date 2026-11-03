-- Applied live 2026-11-03 (run in the SQL Editor; verified: table with RLS, news_alerts,
-- the "news" type, the secret and the 30-minute schedule; first run stored 42 headlines
-- from 30 feeds and alerted 15 members. The edge function is deployed as path-news v3).
--
-- News for each path (2026-11-03). Every 30 minutes pg_cron calls the
-- path-news edge function (supabase/functions/path-news), which reads
-- publishers' RSS feeds, sorts headlines into each path's topics, stores new
-- ones here and sends each member at most one in-app notification a day about the freshest
-- story for their path. Members read everything at /news and on their
-- dashboard, and can turn the notifications off in their account settings.

begin;

create table if not exists public.path_news (
  id           uuid primary key default gen_random_uuid(),
  path         text not null check (path ~ '^[a-z_]{2,40}$'),
  topic        text not null check (topic ~ '^[a-z_]{2,60}$'),
  label        text not null check (char_length(label) between 1 and 80),
  subpaths     text[],
  title        text not null check (char_length(title) between 1 and 300),
  url          text not null check (char_length(url) <= 1000 and url ~* '^https://'),
  publisher    text check (publisher is null or char_length(publisher) <= 80),
  published_at timestamptz not null,
  alerted_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (path, url)
);
create index if not exists path_news_feed on public.path_news (path, published_at desc);

-- Readable by signed-in members; written only by the job (service role).
alter table public.path_news enable row level security;
revoke all on public.path_news from anon;
revoke insert, update, delete on public.path_news from authenticated;
drop policy if exists path_news_select on public.path_news;
create policy path_news_select on public.path_news for select to authenticated using (true);

-- The member's switch for news notifications (on by default).
alter table public.profiles add column if not exists news_alerts boolean not null default true;

-- A notification type for news.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
  'levels','message','milestone','wins','social','community','challenges','forum_reply','collab_invite',
  'collab_response','task_assigned','like','follow','comment','repost','mention','badge','system','help',
  'cohort','group','news']));

-- The job's secret, made in the database (it never appears in the repo), and
-- the schedule: every 30 minutes.
do $do$
begin
  if to_regclass('public.app_secrets') is not null then
    insert into public.app_secrets (key, value)
    values ('cron_path_news', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
    on conflict (key) do nothing;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.schedule('path-news', '*/30 * * * *', $cmd$ select net.http_post(
      url := 'https://wzuptydjilpqafhwtbwq.supabase.co/functions/v1/path-news',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-cron-secret', (select value from public.app_secrets where key = 'cron_path_news')),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    ); $cmd$);
  end if;
end
$do$;

commit;
