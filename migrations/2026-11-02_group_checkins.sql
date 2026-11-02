-- NOT APPLIED, written for review.
--
-- Weekly check-in threads and threaded replies in groups (brief 2.3).
--
-- Every Monday at 09:00 New York time each active group gets "What are you
-- working on this week?", and every Friday "What went well this week?".
-- Members reply in the thread. Group owners and admins can turn either off.
--
-- A check-in has no author (user_id is null) rather than a made-up "system"
-- account: the site shows it as from NoBossly. Members can never create one —
-- the insert policy requires user_id = the member — only post_weekly_checkins(),
-- which only the server's service role can call. It is idempotent: one
-- check-in per group per day, however often the timer fires.
--
-- Replies are one level deep and must stay in the parent's group.

begin;

alter table public.group_posts
  add column if not exists kind        text not null default 'post',
  add column if not exists parent_id   uuid references public.group_posts(id) on delete cascade,
  add column if not exists checkin_key text;
alter table public.group_posts alter column user_id drop not null;
alter table public.group_posts drop constraint if exists group_posts_kind_check;
alter table public.group_posts drop constraint if exists group_posts_shape;
alter table public.group_posts
  add constraint group_posts_kind_check check (kind in ('post','checkin')),
  add constraint group_posts_shape check (
    (kind = 'post' and user_id is not null and checkin_key is null)
    or (kind = 'checkin' and user_id is null and parent_id is null and checkin_key ~ '^\d{4}-\d{2}-\d{2}:(monday|friday)$'));
create unique index if not exists group_posts_checkin_once on public.group_posts (group_id, checkin_key) where checkin_key is not null;
create index if not exists group_posts_thread on public.group_posts (parent_id, created_at) where parent_id is not null;
create index if not exists group_posts_group_time on public.group_posts (group_id, created_at desc);

alter table public.groups
  add column if not exists checkin_monday boolean not null default true,
  add column if not exists checkin_friday boolean not null default true;

-- A reply must sit under a top-level post in the same group.
create or replace function public.group_posts_reply_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare parent group_posts%rowtype;
begin
  if new.parent_id is null then return new; end if;
  select * into parent from group_posts where id = new.parent_id;
  if not found or parent.group_id <> new.group_id or parent.parent_id is not null then
    raise exception 'Replies go under a post in the same group.' using errcode = 'check_violation';
  end if;
  return new;
end
$function$;
revoke all on function public.group_posts_reply_guard() from public, anon, authenticated;
drop trigger if exists group_posts_reply_guard on public.group_posts;
create trigger group_posts_reply_guard before insert or update of parent_id, group_id on public.group_posts
  for each row execute function public.group_posts_reply_guard();

-- Members can still only write posts as themselves (gp_insert, unchanged:
-- user_id = auth.uid()), so a member can never insert a check-in.

-- Post this week's check-in to every group that wants it. p_kind is 'monday'
-- or 'friday'; p_day is that day's date in New York. Returns how many groups
-- got one (0 when they already have it).
create or replace function public.post_weekly_checkins(p_kind text, p_day date)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n integer;
begin
  if p_kind not in ('monday','friday') then raise exception 'unknown check-in'; end if;
  insert into group_posts (group_id, user_id, kind, body, checkin_key)
  select g.id, null, 'checkin',
         case when p_kind = 'monday' then 'What are you working on this week?' else 'What went well this week?' end,
         to_char(p_day, 'YYYY-MM-DD') || ':' || p_kind
    from groups g
   where (case when p_kind = 'monday' then g.checkin_monday else g.checkin_friday end)
     and exists (select 1 from group_members m where m.group_id = g.id and m.status = 'active')
  on conflict (group_id, checkin_key) where checkin_key is not null do nothing;
  get diagnostics n = row_count;
  return n;
end
$function$;
revoke all on function public.post_weekly_checkins(text, date) from public, anon, authenticated;
grant execute on function public.post_weekly_checkins(text, date) to service_role;

commit;
