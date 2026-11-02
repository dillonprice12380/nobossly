-- Applied live 2026-11-02 (run by hand in the SQL Editor).
-- REQUIRES 2026-11-01_personal_info_filter.sql first (contains_personal_info()
-- and refuse_personal_info() come from there).
--
-- Phase 1: the public side.
--   1. Profiles read like a professional network: a headline, what you are
--      working on, and what you can help with / need help with.
--   2. Feed posts: counters only the triggers may change, contact details
--      filtered, and posts reportable.
--   3. The help board — Dillon's draft of 2026-11-01, with these changes:
--        * contains_personal_info() is NOT redefined here. The draft's version
--          missed "bob at gmail dot com" and spelled-out phone numbers, and
--          blocked "3 hours on the road", "unit 3 of the course" and dates
--          with times; the Phase 0 function is used instead.
--        * 'help' is added to notifications' type check. Without it every
--          help_accept() and help_thank() call would fail on its notification.
--        * group_id: null means open to all members; set means only that
--          group's members see the post (Phase 3 makes groups private).
--        * karma_transactions loses its member INSERT policy; help_thank()
--          is the only writer.
--        * The grants the draft was cut off in the middle of are completed.

begin;

-- ---------------------------------------------------------------------------
-- 1. Profiles
alter table public.profiles
  add column if not exists headline   text,
  add column if not exists working_on text,
  add column if not exists help_offer text[] not null default '{}',
  add column if not exists help_need  text[] not null default '{}';

alter table public.profiles
  drop constraint if exists profiles_headline_len,
  drop constraint if exists profiles_working_on_len,
  drop constraint if exists profiles_help_offer_valid,
  drop constraint if exists profiles_help_need_valid;

alter table public.profiles
  add constraint profiles_headline_len   check (headline is null or char_length(headline) <= 120),
  add constraint profiles_working_on_len check (working_on is null or char_length(working_on) <= 200),
  add constraint profiles_help_offer_valid check (
    cardinality(help_offer) <= 8 and help_offer <@ array[
      'website','marketing_seo','design','legal_finance','sales','product','accountability','other']::text[]),
  add constraint profiles_help_need_valid check (
    cardinality(help_need) <= 8 and help_need <@ array[
      'website','marketing_seo','design','legal_finance','sales','product','accountability','other']::text[]);

-- Profile text is public by default: no contact details in it either.
drop trigger if exists profiles_refuse_personal_info on public.profiles;
create trigger profiles_refuse_personal_info
  before insert or update of headline, working_on, bio on public.profiles
  for each row execute function public.refuse_personal_info('headline', 'working_on', 'bio');

-- ---------------------------------------------------------------------------
-- 2. Feed posts
-- Members could write like_count / comment_count / repost_count / is_pinned on
-- their own posts. Only the triggers (and admins, via the service key) may.
revoke update on public.posts from anon, authenticated;
grant update (post_type, content, link_url, link_title) on public.posts to authenticated;

create or replace function public.posts_insert_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.like_count := 0;
  new.comment_count := 0;
  new.repost_count := 0;
  if not public.is_admin() then new.is_pinned := false; end if;
  new.created_at := now();
  return new;
end
$function$;
revoke all on function public.posts_insert_guard() from public, anon, authenticated;

drop trigger if exists posts_insert_guard on public.posts;
create trigger posts_insert_guard before insert on public.posts
  for each row execute function public.posts_insert_guard();

drop trigger if exists posts_refuse_personal_info on public.posts;
create trigger posts_refuse_personal_info
  before insert or update of content, link_title on public.posts
  for each row execute function public.refuse_personal_info('content', 'link_title');

drop trigger if exists post_comments_refuse_personal_info on public.post_comments;
create trigger post_comments_refuse_personal_info
  before insert or update of content on public.post_comments
  for each row execute function public.refuse_personal_info('content');

-- Posts, comments and help board items can be reported like forum posts.
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type = any (array[
  'forum_thread','forum_reply','user','message',
  'post','post_comment','help_post','help_response']));

-- ---------------------------------------------------------------------------
-- 3. Help board
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
  'levels','message','milestone','wins','social','community','challenges','forum_reply',
  'collab_invite','collab_response','task_assigned','like','follow','comment','repost',
  'mention','badge','system','help']));

drop policy if exists karma_insert on public.karma_transactions;

create table if not exists public.help_posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  group_id    uuid references public.groups(id) on delete cascade,
  kind        text not null check (kind in ('ask','offer')),
  title       text not null check (char_length(title) between 5 and 120),
  body        text not null check (char_length(body)  between 10 and 2000),
  category    text not null check (category in (
                'website','marketing_seo','design','legal_finance','sales','product','accountability','other')),
  exchange    text not null default 'free' check (exchange in ('free','swap')),
  status      text not null default 'open' check (status in ('open','in_progress','closed','removed')),
  -- The other person in the exchange, once a response is accepted. For an ASK
  -- they are the helper; for an OFFER they are the person being helped.
  partner_id  uuid references public.profiles(id) on delete set null,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists help_posts_board  on public.help_posts (status, kind, category, created_at desc);
create index if not exists help_posts_author on public.help_posts (author_id, created_at desc);
create index if not exists help_posts_group  on public.help_posts (group_id, created_at desc) where group_id is not null;

create table if not exists public.help_responses (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.help_posts(id) on delete cascade,
  responder_id  uuid not null references public.profiles(id) on delete cascade,
  message       text not null check (char_length(message) between 1 and 600),
  status        text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
  created_at    timestamptz not null default now(),
  unique (post_id, responder_id)
);
create index if not exists help_responses_post      on public.help_responses (post_id, created_at);
create index if not exists help_responses_responder on public.help_responses (responder_id, created_at desc);

create table if not exists public.help_thanks (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null unique references public.help_posts(id) on delete cascade,
  helper_id   uuid not null references public.profiles(id) on delete cascade,
  thanker_id  uuid not null references public.profiles(id) on delete cascade,
  note        text check (note is null or char_length(note) <= 500),
  rating      smallint check (rating is null or rating between 1 and 5),
  is_public   boolean not null default true,
  created_at  timestamptz not null default now(),
  check (helper_id <> thanker_id)
);
create index if not exists help_thanks_helper on public.help_thanks (helper_id, created_at desc);

-- Guards: run on every insert, including ones sent straight to the API.
create or replace function public.help_posts_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_done boolean; v_recent int;
begin
  select coalesce(onboarding_completed, false) into v_done from profiles where id = new.author_id;
  if not coalesce(v_done, false) then
    raise exception 'Pick your path before posting to the help board.';
  end if;
  if new.group_id is not null and not exists (
       select 1 from group_members gm where gm.group_id = new.group_id and gm.user_id = new.author_id) then
    raise exception 'You can only post to a group you belong to.';
  end if;
  select count(*) into v_recent from help_posts
   where author_id = new.author_id and created_at > now() - interval '24 hours';
  if v_recent >= 5 then
    raise exception 'You can post up to 5 times a day on the help board.';
  end if;
  if contains_personal_info(new.title) or contains_personal_info(new.body) then
    raise exception 'Please remove emails, phone numbers and street addresses. Use NoBossly messages to connect.';
  end if;
  new.status := 'open';
  new.partner_id := null;
  new.closed_at := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists help_posts_guard_ins on public.help_posts;
create trigger help_posts_guard_ins before insert on public.help_posts
  for each row execute function public.help_posts_guard();

create or replace function public.help_responses_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_post help_posts%rowtype; v_recent int;
begin
  select * into v_post from help_posts where id = new.post_id;
  if not found or v_post.status <> 'open' then
    raise exception 'This post is no longer open.';
  end if;
  if v_post.author_id = new.responder_id then
    raise exception 'You cannot respond to your own post.';
  end if;
  if v_post.group_id is not null and not exists (
       select 1 from group_members gm where gm.group_id = v_post.group_id and gm.user_id = new.responder_id) then
    raise exception 'This post is only open to its group.';
  end if;
  if exists (select 1 from user_blocks b
              where (b.blocker_id = new.responder_id and b.blocked_id = v_post.author_id)
                 or (b.blocked_id = new.responder_id and b.blocker_id = v_post.author_id)) then
    raise exception 'You cannot respond to this post.';
  end if;
  select count(*) into v_recent from help_responses
   where responder_id = new.responder_id and created_at > now() - interval '24 hours';
  if v_recent >= 20 then
    raise exception 'You can send up to 20 responses a day.';
  end if;
  if contains_personal_info(new.message) then
    raise exception 'Please remove emails, phone numbers and street addresses. Use NoBossly messages to connect.';
  end if;
  new.status := 'pending';
  new.created_at := now();
  return new;
end $$;

drop trigger if exists help_responses_guard_ins on public.help_responses;
create trigger help_responses_guard_ins before insert on public.help_responses
  for each row execute function public.help_responses_guard();

revoke all on function public.help_posts_guard()     from public, anon, authenticated;
revoke all on function public.help_responses_guard() from public, anon, authenticated;

-- Row level security
alter table public.help_posts     enable row level security;
alter table public.help_responses enable row level security;
alter table public.help_thanks    enable row level security;
revoke all on public.help_posts, public.help_responses, public.help_thanks from anon;

-- Posts: members see open-to-all posts and their own groups' posts, except
-- removed ones and anyone they have a block with. Authors see their own.
drop policy if exists help_posts_select on public.help_posts;
create policy help_posts_select on public.help_posts
  for select to authenticated
  using (
    author_id = auth.uid()
    or is_admin_user()
    or (
      status <> 'removed'
      and (group_id is null or exists (
            select 1 from public.group_members gm where gm.group_id = help_posts.group_id and gm.user_id = auth.uid()))
      and not exists (
        select 1 from public.user_blocks b
         where (b.blocker_id = auth.uid() and b.blocked_id = help_posts.author_id)
            or (b.blocked_id = auth.uid() and b.blocker_id = help_posts.author_id))
    )
  );

drop policy if exists help_posts_insert on public.help_posts;
create policy help_posts_insert on public.help_posts
  for insert to authenticated with check (author_id = auth.uid());

-- An author can delete a post nobody has been matched on yet.
drop policy if exists help_posts_delete on public.help_posts;
create policy help_posts_delete on public.help_posts
  for delete to authenticated using (author_id = auth.uid() and status = 'open');

-- Only admins edit rows directly (to remove a post). Members change state
-- through help_accept / help_close / help_thank.
drop policy if exists help_posts_update_admin on public.help_posts;
create policy help_posts_update_admin on public.help_posts
  for update to authenticated using (is_admin_user()) with check (is_admin_user());

drop policy if exists help_responses_select on public.help_responses;
create policy help_responses_select on public.help_responses
  for select to authenticated
  using (
    responder_id = auth.uid()
    or is_admin_user()
    or exists (select 1 from public.help_posts p where p.id = help_responses.post_id and p.author_id = auth.uid())
  );

drop policy if exists help_responses_insert on public.help_responses;
create policy help_responses_insert on public.help_responses
  for insert to authenticated with check (responder_id = auth.uid());

drop policy if exists help_responses_withdraw on public.help_responses;
create policy help_responses_withdraw on public.help_responses
  for update to authenticated
  using (responder_id = auth.uid() and status = 'pending')
  with check (responder_id = auth.uid() and status = 'withdrawn');

-- Thanks are written only by help_thank().
drop policy if exists help_thanks_select on public.help_thanks;
create policy help_thanks_select on public.help_thanks
  for select to authenticated
  using (is_public or helper_id = auth.uid() or thanker_id = auth.uid() or is_admin_user());

-- The state changes
create or replace function public.help_accept(p_response uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_resp help_responses%rowtype; v_post help_posts%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_resp from help_responses where id = p_response for update;
  if not found then raise exception 'Response not found.'; end if;
  select * into v_post from help_posts where id = v_resp.post_id for update;
  if v_post.author_id <> auth.uid() then raise exception 'Only the post author can accept a response.'; end if;
  if v_post.status <> 'open' then raise exception 'This post is no longer open.'; end if;
  if v_resp.status <> 'pending' then raise exception 'That response is no longer pending.'; end if;

  update help_responses set status = 'accepted' where id = v_resp.id;
  update help_responses set status = 'declined'
   where post_id = v_post.id and id <> v_resp.id and status = 'pending';
  update help_posts
     set status = 'in_progress', partner_id = v_resp.responder_id, updated_at = now()
   where id = v_post.id;

  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (v_resp.responder_id, 'help', auth.uid(), 'help_posts', v_post.id,
          'Your response was accepted: "' || left(v_post.title, 80) || '"', false);
  return v_post.id;
end $$;

create or replace function public.help_close(p_post uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update help_posts
     set status = 'closed', closed_at = now(), updated_at = now()
   where id = p_post and author_id = auth.uid() and status in ('open','in_progress');
  if not found then raise exception 'Post not found, or it is already closed.'; end if;
  update help_responses set status = 'declined' where post_id = p_post and status = 'pending';
end $$;

-- The person who RECEIVED the help says thanks: closes the post, records the
-- thank-you, and gives the helper karma, capped so it cannot be farmed.
create or replace function public.help_thank(
  p_post uuid, p_note text default null, p_rating smallint default null, p_public boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post help_posts%rowtype;
  v_helper uuid; v_thanker uuid;
  v_pair int; v_today int;
  c_karma constant int := 5;
  c_daily_cap constant int := 25;
  c_pair_cap constant int := 3;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_post from help_posts where id = p_post for update;
  if not found then raise exception 'Post not found.'; end if;
  if v_post.status <> 'in_progress' or v_post.partner_id is null then
    raise exception 'There is no accepted exchange to thank yet.';
  end if;

  if v_post.kind = 'ask' then
    v_helper := v_post.partner_id;  v_thanker := v_post.author_id;
  else
    v_helper := v_post.author_id;   v_thanker := v_post.partner_id;
  end if;
  if auth.uid() <> v_thanker then
    raise exception 'Only the person who received the help can say thanks.';
  end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'Rating must be 1 to 5.';
  end if;
  if p_note is not null and contains_personal_info(p_note) then
    raise exception 'Please remove emails, phone numbers and street addresses.';
  end if;

  select count(*) into v_pair from help_thanks t
   where t.created_at > now() - interval '30 days'
     and ((t.helper_id = v_helper and t.thanker_id = v_thanker)
       or (t.helper_id = v_thanker and t.thanker_id = v_helper));
  select coalesce(sum(amount), 0) into v_today from karma_transactions
   where user_id = v_helper and reason = 'help_thanks' and created_at > now() - interval '24 hours';

  insert into help_thanks (post_id, helper_id, thanker_id, note, rating, is_public)
  values (p_post, v_helper, v_thanker, nullif(trim(p_note), ''), p_rating, coalesce(p_public, true));

  update help_posts set status = 'closed', closed_at = now(), updated_at = now() where id = p_post;

  if v_pair < c_pair_cap and v_today + c_karma <= c_daily_cap then
    insert into karma_transactions (user_id, amount, reason, entity_type, entity_id)
    values (v_helper, c_karma, 'help_thanks', 'help_posts', p_post);
  end if;

  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (v_helper, 'help', v_thanker, 'help_posts', p_post,
          'You were thanked for helping with "' || left(v_post.title, 80) || '"', false);
end $$;

-- Up to 5 members worth telling about a new post: for an ASK, people who said
-- they can help in that category; for an OFFER, people looking for it. Group
-- posts only match that group's members. Author only; returns ids.
create or replace function public.help_matches_for(p_post uuid)
returns table (member_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare v_post help_posts%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_post from help_posts where id = p_post;
  if not found or v_post.author_id <> auth.uid() then
    raise exception 'Post not found.';
  end if;
  return query
    select p.id
      from profiles p
     where p.id <> v_post.author_id
       and coalesce(p.account_status, 'active') = 'active'
       and coalesce(p.onboarding_completed, false)
       and ((v_post.kind = 'ask'   and v_post.category = any (p.help_offer))
         or (v_post.kind = 'offer' and v_post.category = any (p.help_need)))
       and (v_post.group_id is null or exists (
             select 1 from group_members gm where gm.group_id = v_post.group_id and gm.user_id = p.id))
       and not exists (select 1 from user_blocks b
                        where (b.blocker_id = p.id and b.blocked_id = v_post.author_id)
                           or (b.blocked_id = p.id and b.blocker_id = v_post.author_id))
     order by p.last_active_at desc nulls last
     limit 5;
end $$;

revoke all on function public.help_accept(uuid)                          from public, anon;
revoke all on function public.help_close(uuid)                           from public, anon;
revoke all on function public.help_thank(uuid, text, smallint, boolean)  from public, anon;
revoke all on function public.help_matches_for(uuid)                     from public, anon;
grant execute on function public.help_accept(uuid)                       to authenticated;
grant execute on function public.help_close(uuid)                        to authenticated;
grant execute on function public.help_thank(uuid, text, smallint, boolean) to authenticated;
grant execute on function public.help_matches_for(uuid)                  to authenticated;

commit;
