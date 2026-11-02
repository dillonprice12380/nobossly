-- Applied live 2026-11-02 (run by hand in the SQL Editor; verified: 5 tables, 19 policies, 13 functions, anon closed).
--
-- Phase 3: the private side. Groups become public, private or hidden;
-- accelerators get organizations whose staff run cohorts (hidden, invite-only
-- groups); cohort leaders set assignments and members submit their work to
-- them. Nothing in a cohort is visible to anyone outside it.
--
-- There are no groups yet (0 rows in groups, group_members, group_posts on
-- 2026-11-02), so the policies are replaced outright with nothing to migrate.
--
-- Who can do what, in one place:
--   group_role(g)       the caller's role in g ('owner'…'member'), counting an
--                       organization's admins and staff as 'admin' of its
--                       cohorts; null if not an active member.
--   is_group_member(g)  any active role.
--   is_group_leader(g)  owner, admin or mentor — the people who set
--                       assignments and review submissions.
-- These are SECURITY DEFINER so policies can use them without recursing into
-- the group_members policy.
--
-- Joining, roles, requests, invites and submissions go through functions, not
-- direct writes, so the rules (invite codes, approval, no self-promotion) are
-- enforced by the database whatever the client sends.

begin;

-- ---------------------------------------------------------------------------
-- Organizations: accelerators, incubators, nonprofits, universities. Created by
-- NoBossly admins for now; their admins and staff run the org's cohorts.
create table if not exists public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 2 and 120),
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  kind          text not null default 'accelerator' check (kind in ('accelerator','incubator','nonprofit','university','other')),
  website_url   text check (website_url is null or website_url ~* '^https?://'),
  contact_email text check (contact_email is null or char_length(contact_email) <= 200),
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table if not exists public.org_admins (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'admin' check (role in ('owner','admin','staff')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_admins_user on public.org_admins (user_id);

-- ---------------------------------------------------------------------------
-- Groups: visibility and how people get in.
--   public  + open    anyone joins
--   private + request listed; members approve requests (or use an invite)
--   hidden  + invite  not listed anywhere; invite link only (cohorts)
alter table public.groups
  add column if not exists visibility  text not null default 'public',
  add column if not exists join_policy text not null default 'open',
  add column if not exists org_id      uuid references public.organizations(id) on delete set null;
alter table public.groups drop constraint if exists groups_visibility_check;
alter table public.groups drop constraint if exists groups_join_policy_check;
alter table public.groups drop constraint if exists groups_shape;
alter table public.groups
  add constraint groups_visibility_check  check (visibility in ('public','private','hidden')),
  add constraint groups_join_policy_check check (join_policy in ('open','request','invite')),
  -- A hidden group is never open; a cohort (org group) is always hidden.
  add constraint groups_shape check (
    not (visibility = 'hidden' and join_policy = 'open')
    and (org_id is null or visibility = 'hidden')
    and char_length(name) between 2 and 120
    and (description is null or char_length(description) <= 600));
create index if not exists groups_org on public.groups (org_id) where org_id is not null;

alter table public.group_members drop constraint if exists group_members_role_check;
alter table public.group_members add constraint group_members_role_check
  check (role in ('owner','admin','moderator','mentor','member'));
alter table public.group_members add column if not exists status text not null default 'active';
alter table public.group_members drop constraint if exists group_members_status_check;
alter table public.group_members add constraint group_members_status_check
  check (status in ('active','requested','invited','removed','left'));
create index if not exists group_members_user on public.group_members (user_id, status);

create table if not exists public.group_invites (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  code        text not null unique check (code ~ '^[A-Za-z0-9_-]{12,40}$'),
  created_by  uuid references public.profiles(id) on delete set null,
  max_uses    integer check (max_uses is null or max_uses between 1 and 1000),
  uses        integer not null default 0,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists group_invites_group on public.group_invites (group_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Role helpers.
create or replace function public.group_role(p_group uuid)
returns text
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select m.role from group_members m
      where m.group_id = p_group and m.user_id = auth.uid() and m.status = 'active'),
    (select 'admin' from groups g join org_admins oa on oa.org_id = g.org_id
      where g.id = p_group and oa.user_id = auth.uid() limit 1));
$function$;

create or replace function public.is_group_member(p_group uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$ select public.group_role(p_group) is not null $function$;

create or replace function public.is_group_leader(p_group uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$ select coalesce(public.group_role(p_group) in ('owner','admin','mentor'), false) $function$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$ select exists (select 1 from org_admins where org_id = p_org and user_id = auth.uid()) $function$;

-- The caller's role in an organization, or null. Policies on org_admins use
-- this rather than querying org_admins from inside its own policy (which
-- would recurse).
create or replace function public.org_role(p_org uuid)
returns text
language sql
stable security definer
set search_path to 'public'
as $function$ select role from org_admins where org_id = p_org and user_id = auth.uid() $function$;

revoke all on function public.org_role(uuid)        from public, anon;
grant execute on function public.org_role(uuid)        to authenticated;
revoke all on function public.group_role(uuid)      from public, anon;
revoke all on function public.is_group_member(uuid) from public, anon;
revoke all on function public.is_group_leader(uuid) from public, anon;
revoke all on function public.is_org_admin(uuid)    from public, anon;
grant execute on function public.group_role(uuid)      to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.is_group_leader(uuid) to authenticated;
grant execute on function public.is_org_admin(uuid)    to authenticated;

-- ---------------------------------------------------------------------------
-- Row policies. Signed-in only throughout; anon sees none of this.
alter table public.organizations enable row level security;
alter table public.org_admins    enable row level security;
alter table public.group_invites enable row level security;
revoke all on public.organizations, public.org_admins, public.group_invites from anon;
revoke all on public.groups, public.group_members, public.group_posts from anon;

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select to authenticated
  using (public.is_org_admin(id) or public.is_admin());
drop policy if exists organizations_admin_write on public.organizations;
create policy organizations_admin_write on public.organizations for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists organizations_update_own on public.organizations;
create policy organizations_update_own on public.organizations for update to authenticated
  using (public.org_role(organizations.id) in ('owner','admin'))
  with check (public.org_role(organizations.id) in ('owner','admin'));

drop policy if exists org_admins_select on public.org_admins;
create policy org_admins_select on public.org_admins for select to authenticated
  using (public.is_org_admin(org_id) or public.is_admin());
drop policy if exists org_admins_write on public.org_admins;
-- NoBossly admins and the organization's owner manage its admins and staff.
create policy org_admins_write on public.org_admins for all to authenticated
  using (public.is_admin() or public.org_role(org_id) = 'owner')
  with check (public.is_admin() or public.org_role(org_id) = 'owner');

-- groups: public and private groups are listed; hidden ones only to members.
drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups for select to authenticated
  using (visibility in ('public','private') or public.is_group_member(id) or public.is_admin());
drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups for insert to authenticated
  with check (owner_id = auth.uid() and (org_id is null or public.is_org_admin(org_id)));
drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups for update to authenticated
  using (public.group_role(id) in ('owner','admin') or public.is_admin())
  with check ((public.group_role(id) in ('owner','admin') or public.is_admin())
              and (org_id is null or public.is_org_admin(org_id) or public.is_admin()));
drop policy if exists groups_delete on public.groups;
create policy groups_delete on public.groups for delete to authenticated
  using (owner_id = auth.uid() or (org_id is not null and public.is_org_admin(org_id)) or public.is_admin());

-- group_members: public groups' members are visible to all members of the
-- site; private and hidden groups' only to their own members. You always see
-- your own row (a pending request, an invitation).
drop policy if exists gm_select on public.group_members;
create policy gm_select on public.group_members for select to authenticated
  using (user_id = auth.uid()
         or public.is_group_member(group_id)
         or exists (select 1 from groups g where g.id = group_id and g.visibility = 'public')
         or public.is_admin());
-- Direct inserts: only the creator adding themselves as owner of their new
-- group. Everything else (joining, requests, invites) is group_join().
drop policy if exists gm_insert on public.group_members;
create policy gm_insert on public.group_members for insert to authenticated
  with check (user_id = auth.uid() and role = 'owner' and status = 'active'
              and exists (select 1 from groups g where g.id = group_id and g.owner_id = auth.uid()));
-- Leaving deletes your own row; owners and admins remove others through
-- group_remove_member() so the row stays as 'removed' and blocks rejoining.
drop policy if exists gm_delete on public.group_members;
create policy gm_delete on public.group_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'owner' and status <> 'removed') or public.is_admin());
revoke update on public.group_members from authenticated;

-- group_posts: members only for private and hidden groups, and never from
-- someone you have blocked or who has blocked you.
drop policy if exists gp_select on public.group_posts;
create policy gp_select on public.group_posts for select to authenticated
  using ((public.is_group_member(group_id)
          or exists (select 1 from groups g where g.id = group_id and g.visibility = 'public')
          or public.is_admin())
         and not exists (select 1 from user_blocks b
                          where (b.blocker_id = auth.uid() and b.blocked_id = group_posts.user_id)
                             or (b.blocked_id = auth.uid() and b.blocker_id = group_posts.user_id)));
drop policy if exists gp_insert on public.group_posts;
create policy gp_insert on public.group_posts for insert to authenticated
  with check (user_id = auth.uid() and public.is_group_member(group_id));
drop policy if exists gp_delete on public.group_posts;
create policy gp_delete on public.group_posts for delete to authenticated
  using (user_id = auth.uid() or public.group_role(group_id) in ('owner','admin','moderator') or public.is_admin());

drop policy if exists group_invites_leaders on public.group_invites;
create policy group_invites_leaders on public.group_invites for all to authenticated
  using (public.group_role(group_id) in ('owner','admin') or public.is_admin())
  with check (public.group_role(group_id) in ('owner','admin') or public.is_admin());

-- The help board's group posts follow the same membership rule.
drop policy if exists help_posts_select on public.help_posts;
create policy help_posts_select on public.help_posts
  for select to authenticated
  using (
    author_id = auth.uid()
    or is_admin_user()
    or (
      status <> 'removed'
      and (group_id is null or public.is_group_member(group_id))
      and not exists (
        select 1 from public.user_blocks b
         where (b.blocker_id = auth.uid() and b.blocked_id = help_posts.author_id)
            or (b.blocked_id = auth.uid() and b.blocker_id = help_posts.author_id))
    )
  );

-- The help board (2026-11-01_phase1_public_side.sql) checked group membership
-- by row alone; with requests and removals, only active members count. Same
-- functions, with "and gm.status = 'active'" added.
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
       select 1 from group_members gm where gm.group_id = new.group_id and gm.user_id = new.author_id and gm.status = 'active') then
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
       select 1 from group_members gm where gm.group_id = v_post.group_id and gm.user_id = new.responder_id and gm.status = 'active') then
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
             select 1 from group_members gm where gm.group_id = v_post.group_id and gm.user_id = p.id and gm.status = 'active'))
       and not exists (select 1 from user_blocks b
                        where (b.blocker_id = p.id and b.blocked_id = v_post.author_id)
                           or (b.blocked_id = p.id and b.blocker_id = v_post.author_id))
     order by p.last_active_at desc nulls last
     limit 5;
end $$;

-- ---------------------------------------------------------------------------
-- Joining and running a group.

-- What an invite link leads to, so the join page can show it before joining.
-- Returns null for a code that does not exist.
create or replace function public.group_invite_preview(p_code text)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'group_id', g.id, 'name', g.name, 'slug', g.slug, 'description', g.description,
    'org', o.name, 'is_cohort', g.org_id is not null,
    'valid', (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.uses < i.max_uses),
    'member', exists (select 1 from group_members m where m.group_id = g.id and m.user_id = auth.uid() and m.status = 'active'))
    from group_invites i
    join groups g on g.id = i.group_id
    left join organizations o on o.id = g.org_id
   where i.code = p_code and auth.uid() is not null;
$function$;

-- Join a group, request to join, or accept an invite.
-- Returns: joined | requested | already | invalid | expired | full | removed
create or replace function public.group_join(p_group uuid, p_code text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  g groups%rowtype;
  inv group_invites%rowtype;
  cur group_members%rowtype;
begin
  if auth.uid() is null then return 'invalid'; end if;
  if p_code is not null and p_code <> '' then
    select * into inv from group_invites where code = p_code for update;
    if not found or (p_group is not null and inv.group_id <> p_group) then return 'invalid'; end if;
    if inv.expires_at is not null and inv.expires_at <= now() then return 'expired'; end if;
    if inv.max_uses is not null and inv.uses >= inv.max_uses then return 'full'; end if;
    p_group := inv.group_id;
  end if;
  select * into g from groups where id = p_group;
  if not found then return 'invalid'; end if;
  select * into cur from group_members where group_id = g.id and user_id = auth.uid();
  if found and cur.status = 'active' then return 'already'; end if;

  if inv.id is not null then
    -- A fresh invite lets someone back in, even after removal.
    insert into group_members (group_id, user_id, role, status)
    values (g.id, auth.uid(), 'member', 'active')
    on conflict (group_id, user_id) do update set status = 'active', role = 'member', joined_at = now();
    update group_invites set uses = uses + 1 where id = inv.id;
    return 'joined';
  end if;

  if found and cur.status = 'removed' then return 'removed'; end if;
  if g.visibility = 'public' and g.join_policy = 'open' then
    insert into group_members (group_id, user_id, role, status)
    values (g.id, auth.uid(), 'member', 'active')
    on conflict (group_id, user_id) do update set status = 'active', role = 'member', joined_at = now();
    return 'joined';
  end if;
  if g.visibility <> 'hidden' and g.join_policy = 'request' then
    insert into group_members (group_id, user_id, role, status)
    values (g.id, auth.uid(), 'member', 'requested')
    on conflict (group_id, user_id) do update set status = 'requested';
    return 'requested';
  end if;
  return 'invalid';
end
$function$;

-- Approve or decline a request (owners, admins and moderators).
create or replace function public.group_decide_request(p_group uuid, p_user uuid, p_approve boolean)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(public.group_role(p_group) in ('owner','admin','moderator'), false) is false then return false; end if;
  if p_approve then
    update group_members set status = 'active', joined_at = now()
     where group_id = p_group and user_id = p_user and status = 'requested';
  else
    delete from group_members where group_id = p_group and user_id = p_user and status = 'requested';
  end if;
  return found;
end
$function$;

-- Change someone's role (owners and admins). Nobody changes the owner, makes
-- a second owner, or changes their own role.
create or replace function public.group_set_role(p_group uuid, p_user uuid, p_role text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare me text := public.group_role(p_group);
begin
  if me is null or me not in ('owner','admin') then return false; end if;
  if p_role not in ('admin','moderator','mentor','member') or p_user = auth.uid() then return false; end if;
  if p_role = 'admin' and me <> 'owner' and not exists (
       select 1 from groups g join org_admins oa on oa.org_id = g.org_id where g.id = p_group and oa.user_id = auth.uid()) then
    return false;  -- only the owner (or the cohort's organization) makes admins
  end if;
  update group_members set role = p_role
   where group_id = p_group and user_id = p_user and status = 'active' and role <> 'owner';
  return found;
end
$function$;

-- Remove someone (owners and admins; moderators may remove members only).
create or replace function public.group_remove_member(p_group uuid, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare me text := public.group_role(p_group); them text;
begin
  select role into them from group_members where group_id = p_group and user_id = p_user and status = 'active';
  if them is null or them = 'owner' or p_user = auth.uid() then return false; end if;
  if me in ('owner','admin') or (me = 'moderator' and them = 'member') then
    update group_members set status = 'removed' where group_id = p_group and user_id = p_user;
    return true;
  end if;
  return false;
end
$function$;

-- A cohort: a hidden, invite-only group under an organization. Only the
-- organization's admins and staff create them.
create or replace function public.cohort_create(p_org uuid, p_name text, p_slug text, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare gid uuid;
begin
  if not public.is_org_admin(p_org) then raise exception 'Only the organization''s admins can create cohorts.'; end if;
  insert into groups (name, slug, description, owner_id, visibility, join_policy, org_id)
  values (p_name, p_slug, nullif(trim(p_description), ''), auth.uid(), 'hidden', 'invite', p_org)
  returning id into gid;
  insert into group_members (group_id, user_id, role, status) values (gid, auth.uid(), 'owner', 'active');
  return gid;
end
$function$;

-- ---------------------------------------------------------------------------
-- Assignments and submissions.
--
-- A leader sets an assignment: a worksheet (e.g. lean_canvas), a board, free
-- text or a link. A member submits a COPY of their work (snapshot) — their
-- workspace stays private, and the leader sees exactly what was handed in.
-- Resubmitting replaces the copy until the leader approves it.
create table if not exists public.cohort_assignments (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups(id) on delete cascade,
  title        text not null check (char_length(title) between 3 and 160),
  instructions text check (instructions is null or char_length(instructions) <= 4000),
  kind         text not null default 'text' check (kind in ('worksheet','board','text','link')),
  tool_key     text check (tool_key is null or tool_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  due_on       date,
  position     integer not null default 0,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((kind in ('worksheet','board')) = (tool_key is not null))
);
create index if not exists cohort_assignments_group on public.cohort_assignments (group_id, position, created_at);

create table if not exists public.cohort_submissions (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.cohort_assignments(id) on delete cascade,
  group_id      uuid not null references public.groups(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'submitted' check (status in ('submitted','returned','approved')),
  title         text check (title is null or char_length(title) <= 160),
  body          text check (body is null or char_length(body) <= 6000),
  link_url      text check (link_url is null or link_url ~* '^https?://'),
  snapshot      jsonb check (snapshot is null or (jsonb_typeof(snapshot) = 'object' and pg_column_size(snapshot) < 200000)),
  source_id     uuid,
  feedback      text check (feedback is null or char_length(feedback) <= 3000),
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  submitted_at  timestamptz not null default now(),
  unique (assignment_id, user_id)
);
create index if not exists cohort_submissions_group on public.cohort_submissions (group_id, status, submitted_at desc);
create index if not exists cohort_submissions_user on public.cohort_submissions (user_id, submitted_at desc);

drop trigger if exists cohort_assignments_touch on public.cohort_assignments;
create trigger cohort_assignments_touch before update on public.cohort_assignments
  for each row execute function public.touch_updated_at();

alter table public.cohort_assignments enable row level security;
alter table public.cohort_submissions enable row level security;
revoke all on public.cohort_assignments, public.cohort_submissions from anon;
-- Submissions are written only by cohort_submit() and cohort_review().
revoke insert, update, delete on public.cohort_submissions from authenticated;

drop policy if exists cohort_assignments_select on public.cohort_assignments;
create policy cohort_assignments_select on public.cohort_assignments for select to authenticated
  using (public.is_group_member(group_id) or public.is_admin());
drop policy if exists cohort_assignments_write on public.cohort_assignments;
create policy cohort_assignments_write on public.cohort_assignments for all to authenticated
  using (public.is_group_leader(group_id))
  with check (public.is_group_leader(group_id));

-- You see your own submissions; leaders see everyone's in their cohort.
drop policy if exists cohort_submissions_select on public.cohort_submissions;
create policy cohort_submissions_select on public.cohort_submissions for select to authenticated
  using (user_id = auth.uid() or public.is_group_leader(group_id) or public.is_admin());

-- Hand in (or replace) your work. Returns: submitted | approved (locked) | invalid
create or replace function public.cohort_submit(
  p_assignment uuid, p_title text, p_body text, p_link text, p_snapshot jsonb, p_source uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare a cohort_assignments%rowtype; cur cohort_submissions%rowtype;
begin
  if auth.uid() is null then return 'invalid'; end if;
  select * into a from cohort_assignments where id = p_assignment;
  if not found or not public.is_group_member(a.group_id) then return 'invalid'; end if;
  select * into cur from cohort_submissions where assignment_id = a.id and user_id = auth.uid();
  if found and cur.status = 'approved' then return 'approved'; end if;
  insert into cohort_submissions (assignment_id, group_id, user_id, status, title, body, link_url, snapshot, source_id, submitted_at)
  values (a.id, a.group_id, auth.uid(), 'submitted', left(p_title, 160), left(p_body, 6000), p_link, p_snapshot, p_source, now())
  on conflict (assignment_id, user_id) do update
    set status = 'submitted', title = excluded.title, body = excluded.body, link_url = excluded.link_url,
        snapshot = excluded.snapshot, source_id = excluded.source_id, submitted_at = now();
  -- Tell the cohort's leaders (owner and admins), at most once per submission.
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  select m.user_id, 'cohort', auth.uid(), 'cohort_assignments', a.id,
         'New submission: "' || left(a.title, 80) || '"', false
    from group_members m
   where m.group_id = a.group_id and m.status = 'active' and m.role in ('owner','admin','mentor') and m.user_id <> auth.uid();
  return 'submitted';
end
$function$;

-- Review: approve, or return with feedback. Leaders only.
create or replace function public.cohort_review(p_submission uuid, p_status text, p_feedback text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare s cohort_submissions%rowtype; t text;
begin
  select * into s from cohort_submissions where id = p_submission for update;
  if not found or not public.is_group_leader(s.group_id) or p_status not in ('returned','approved') then return false; end if;
  update cohort_submissions
     set status = p_status, feedback = nullif(left(trim(p_feedback), 3000), ''), reviewed_by = auth.uid(), reviewed_at = now()
   where id = s.id;
  select title into t from cohort_assignments where id = s.assignment_id;
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (s.user_id, 'cohort', auth.uid(), 'cohort_assignments', s.assignment_id,
          case when p_status = 'approved' then 'Approved: "' else 'Feedback on: "' end || left(t, 80) || '"', false);
  return true;
end
$function$;

revoke all on function public.group_invite_preview(text)                          from public, anon;
revoke all on function public.group_join(uuid, text)                              from public, anon;
revoke all on function public.group_decide_request(uuid, uuid, boolean)           from public, anon;
revoke all on function public.group_set_role(uuid, uuid, text)                    from public, anon;
revoke all on function public.group_remove_member(uuid, uuid)                     from public, anon;
revoke all on function public.cohort_create(uuid, text, text, text)               from public, anon;
revoke all on function public.cohort_submit(uuid, text, text, text, jsonb, uuid)  from public, anon;
revoke all on function public.cohort_review(uuid, text, text)                     from public, anon;
grant execute on function public.group_invite_preview(text)                         to authenticated;
grant execute on function public.group_join(uuid, text)                             to authenticated;
grant execute on function public.group_decide_request(uuid, uuid, boolean)          to authenticated;
grant execute on function public.group_set_role(uuid, uuid, text)                   to authenticated;
grant execute on function public.group_remove_member(uuid, uuid)                    to authenticated;
grant execute on function public.cohort_create(uuid, text, text, text)              to authenticated;
grant execute on function public.cohort_submit(uuid, text, text, text, jsonb, uuid) to authenticated;
grant execute on function public.cohort_review(uuid, text, text)                    to authenticated;

-- ---------------------------------------------------------------------------
-- Notifications and reports learn the new kinds.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type = any (array[
  'levels','message','milestone','wins','social','community','challenges','forum_reply',
  'collab_invite','collab_response','task_assigned','like','follow','comment','repost',
  'mention','badge','system','help','cohort','group']));

alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type = any (array[
  'forum_thread','forum_reply','user','message',
  'post','post_comment','help_post','help_response','group_post']));

commit;
