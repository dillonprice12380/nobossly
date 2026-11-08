-- NOT APPLIED
--
-- Community, round 1 (2026-11-08): a better Q&A and co-working sessions.
--
-- Q&A
--  * The asker can mark the reply that helped (forum_threads.accepted_reply_id);
--    it shows first. Only a reply in the same thread can be marked.
--  * Members follow threads (forum_follows). The asker follows their own thread
--    and anyone who replies follows it too; everyone following hears about a
--    new reply, except the person who wrote it and anyone who has blocked them.
--  * Reply counts were written by the replier's own client, which RLS only lets
--    a thread's author update: a reply to someone else's thread never moved
--    the count or "last reply". The database now keeps reply_count and
--    last_reply_at itself, and counts views through forum_thread_viewed().
--
-- Co-working sessions
--  * A member hosts a time to work alongside others (coworking_sessions): a
--    title, when, how long, an optional cap and path. Others RSVP
--    (coworking_rsvps). The video link sits in coworking_links, readable only
--    by the host and the people who RSVP'd.
--  * At most five upcoming sessions per host, up to 60 days ahead, and never
--    more RSVPs than the cap. Reminders go out from the server (service role)
--    about an hour before; reminded_at records that.

begin;

-- 1. The answer that helped -------------------------------------------------
alter table public.forum_threads add column if not exists accepted_reply_id uuid
  references public.forum_replies(id) on delete set null;

create or replace function public.forum_threads_check_accepted()
returns trigger language plpgsql set search_path to 'public'
as $function$
begin
  if new.accepted_reply_id is not null and not exists (
       select 1 from public.forum_replies r where r.id = new.accepted_reply_id and r.thread_id = new.id) then
    raise exception 'that reply is not in this thread';
  end if;
  return new;
end $function$;
drop trigger if exists forum_threads_check_accepted on public.forum_threads;
create trigger forum_threads_check_accepted before insert or update of accepted_reply_id on public.forum_threads
  for each row execute function public.forum_threads_check_accepted();

-- 2. Following threads -----------------------------------------------------
create table if not exists public.forum_follows (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  thread_id  uuid not null references public.forum_threads(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);
create index if not exists forum_follows_thread on public.forum_follows (thread_id);
alter table public.forum_follows enable row level security;
revoke all on public.forum_follows from anon, authenticated;
grant select, insert, delete on public.forum_follows to authenticated;
drop policy if exists forum_follows_own on public.forum_follows;
create policy forum_follows_own on public.forum_follows for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The asker follows their own thread.
create or replace function public.forum_thread_added()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  insert into public.forum_follows (user_id, thread_id) values (new.user_id, new.id) on conflict do nothing;
  return new;
end $function$;
drop trigger if exists forum_thread_added on public.forum_threads;
create trigger forum_thread_added after insert on public.forum_threads
  for each row execute function public.forum_thread_added();

-- 3. Replies: counts, "last reply", the replier follows, followers are told.
create or replace function public.forum_reply_added()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  t public.forum_threads;
  who text;
begin
  update public.forum_threads
     set reply_count = (select count(*) from public.forum_replies where thread_id = new.thread_id),
         last_reply_at = greatest(coalesce(last_reply_at, new.created_at), new.created_at)
   where id = new.thread_id
  returning * into t;
  if t.id is null then return new; end if;
  insert into public.forum_follows (user_id, thread_id) values (new.user_id, new.thread_id) on conflict do nothing;
  select coalesce(nullif(btrim(display_name), ''), username, 'Someone') into who from public.profiles where id = new.user_id;
  insert into public.notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  select f.user_id, 'forum_reply', new.user_id, 'forum_threads', new.thread_id,
         coalesce(who, 'Someone') || case when f.user_id = t.user_id then ' replied to your question "' else ' replied in "' end
           || left(t.title, 60) || '"',
         false
    from public.forum_follows f
   where f.thread_id = new.thread_id and f.user_id <> new.user_id
     and not exists (select 1 from public.user_blocks b
                      where (b.blocker_id = f.user_id and b.blocked_id = new.user_id)
                         or (b.blocker_id = new.user_id and b.blocked_id = f.user_id));
  return new;
end $function$;
drop trigger if exists forum_reply_added on public.forum_replies;
create trigger forum_reply_added after insert on public.forum_replies
  for each row execute function public.forum_reply_added();

create or replace function public.forum_reply_removed()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  update public.forum_threads
     set reply_count = (select count(*) from public.forum_replies where thread_id = old.thread_id)
   where id = old.thread_id;
  return old;
end $function$;
drop trigger if exists forum_reply_removed on public.forum_replies;
create trigger forum_reply_removed after delete on public.forum_replies
  for each row execute function public.forum_reply_removed();

-- Views: anyone reading a thread counts it, without being able to edit it.
create or replace function public.forum_thread_viewed(p_id uuid)
returns void language sql security definer set search_path to 'public'
as $function$
  update public.forum_threads set view_count = coalesce(view_count, 0) + 1 where id = p_id
$function$;
revoke all on function public.forum_thread_viewed(uuid) from public;
grant execute on function public.forum_thread_viewed(uuid) to anon, authenticated;

-- Bring every count in line once.
update public.forum_threads t
   set reply_count = (select count(*) from public.forum_replies r where r.thread_id = t.id)
 where reply_count is distinct from (select count(*) from public.forum_replies r where r.thread_id = t.id);
insert into public.forum_follows (user_id, thread_id) select user_id, id from public.forum_threads on conflict do nothing;

-- 4. Co-working sessions ---------------------------------------------------
create table if not exists public.coworking_sessions (
  id           uuid primary key default gen_random_uuid(),
  host_id      uuid not null references public.profiles(id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 3 and 120),
  about        text check (about is null or char_length(about) <= 1000),
  starts_at    timestamptz not null,
  minutes      integer not null default 60 check (minutes between 15 and 240),
  capacity     integer check (capacity is null or capacity between 2 and 50),
  path         text check (path is null or path ~ '^[a-z_]{2,40}$'),
  cancelled_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists coworking_sessions_when on public.coworking_sessions (starts_at);

create table if not exists public.coworking_links (
  session_id uuid primary key references public.coworking_sessions(id) on delete cascade,
  link       text not null check (link ~ '^https://[^[:space:]]{4,}$' and char_length(link) <= 300)
);

create table if not exists public.coworking_rsvps (
  session_id  uuid not null references public.coworking_sessions(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  reminded_at timestamptz,
  primary key (session_id, user_id)
);
create index if not exists coworking_rsvps_user on public.coworking_rsvps (user_id);

-- A session starts in the future, within 60 days, and a host has at most five
-- upcoming. Rescheduling keeps the same rules; the host never changes.
create or replace function public.coworking_sessions_rules()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if tg_op = 'UPDATE' and new.host_id is distinct from old.host_id then raise exception 'the host cannot change'; end if;
  if tg_op = 'INSERT' or new.starts_at is distinct from old.starts_at then
    if new.starts_at < now() + interval '5 minutes' then raise exception 'a session has to start in the future'; end if;
    if new.starts_at > now() + interval '60 days' then raise exception 'a session can be at most 60 days ahead'; end if;
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.coworking_sessions
                            where host_id = new.host_id and cancelled_at is null and starts_at > now()) >= 5 then
    raise exception 'you already host five upcoming sessions';
  end if;
  return new;
end $function$;
drop trigger if exists coworking_sessions_rules on public.coworking_sessions;
create trigger coworking_sessions_rules before insert or update on public.coworking_sessions
  for each row execute function public.coworking_sessions_rules();

-- An RSVP is for an upcoming session that is not cancelled or full.
create or replace function public.coworking_rsvps_rules()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare s public.coworking_sessions;
begin
  select * into s from public.coworking_sessions where id = new.session_id for update;
  if s.id is null or s.cancelled_at is not null then raise exception 'that session is not on'; end if;
  if s.starts_at + make_interval(mins => s.minutes) < now() then raise exception 'that session is over'; end if;
  if s.capacity is not null and (select count(*) from public.coworking_rsvps where session_id = s.id) >= s.capacity then
    raise exception 'that session is full';
  end if;
  return new;
end $function$;
drop trigger if exists coworking_rsvps_rules on public.coworking_rsvps;
create trigger coworking_rsvps_rules before insert on public.coworking_rsvps
  for each row execute function public.coworking_rsvps_rules();

alter table public.coworking_sessions enable row level security;
alter table public.coworking_links enable row level security;
alter table public.coworking_rsvps enable row level security;
revoke all on public.coworking_sessions, public.coworking_links, public.coworking_rsvps from anon, authenticated;
grant select, insert, update, delete on public.coworking_sessions to authenticated;
grant select, insert, update, delete on public.coworking_links to authenticated;
grant select, insert, delete on public.coworking_rsvps to authenticated;
grant select on public.coworking_sessions, public.coworking_links to service_role;
grant select, update on public.coworking_rsvps to service_role;

drop policy if exists coworking_sessions_read on public.coworking_sessions;
create policy coworking_sessions_read on public.coworking_sessions for select to authenticated using (true);
drop policy if exists coworking_sessions_host on public.coworking_sessions;
create policy coworking_sessions_host on public.coworking_sessions for insert to authenticated with check (host_id = auth.uid());
drop policy if exists coworking_sessions_edit on public.coworking_sessions;
create policy coworking_sessions_edit on public.coworking_sessions for update to authenticated
  using (host_id = auth.uid()) with check (host_id = auth.uid());
drop policy if exists coworking_sessions_delete on public.coworking_sessions;
create policy coworking_sessions_delete on public.coworking_sessions for delete to authenticated
  using (host_id = auth.uid() or is_admin());

-- The link: the host, and whoever has RSVP'd.
drop policy if exists coworking_links_read on public.coworking_links;
create policy coworking_links_read on public.coworking_links for select to authenticated using (
  exists (select 1 from public.coworking_sessions s where s.id = session_id and s.host_id = auth.uid())
  or exists (select 1 from public.coworking_rsvps r where r.session_id = coworking_links.session_id and r.user_id = auth.uid())
  or is_admin());
drop policy if exists coworking_links_host on public.coworking_links;
create policy coworking_links_host on public.coworking_links for all to authenticated
  using (exists (select 1 from public.coworking_sessions s where s.id = session_id and s.host_id = auth.uid()))
  with check (exists (select 1 from public.coworking_sessions s where s.id = session_id and s.host_id = auth.uid()));

drop policy if exists coworking_rsvps_read on public.coworking_rsvps;
create policy coworking_rsvps_read on public.coworking_rsvps for select to authenticated using (true);
drop policy if exists coworking_rsvps_own on public.coworking_rsvps;
create policy coworking_rsvps_own on public.coworking_rsvps for insert to authenticated with check (user_id = auth.uid());
drop policy if exists coworking_rsvps_leave on public.coworking_rsvps;
create policy coworking_rsvps_leave on public.coworking_rsvps for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.coworking_sessions s where s.id = session_id and s.host_id = auth.uid()));

commit;

select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'forum_threads' and column_name = 'accepted_reply_id') = 1
   and to_regclass('public.forum_follows') is not null
   and to_regclass('public.coworking_sessions') is not null
   and to_regclass('public.coworking_rsvps') is not null
   and to_regclass('public.coworking_links') is not null
   and not has_table_privilege('anon', 'public.coworking_sessions', 'select') as ok;
