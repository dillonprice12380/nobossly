-- NOT APPLIED, written for review.
--
-- The other side of NoBossly: the people who run accelerator programs and
-- teach courses (2026-11-03).
--
--   1. A provider applies once (provider_apply). A NoBossly admin approves it
--      (provider_decide), which creates their organization, makes them its
--      owner and marks it a provider. Organizations made before this (e.g.
--      for a pilot cohort) become providers when an admin ticks the box.
--   2. A provider's team publishes listings: a program or a course. Each one
--      is free, or shows a price and links out to the provider's own checkout
--      (NoBossly takes no payments). Each listing either takes applications
--      the team reviews, or lets members enroll straight away.
--   3. People who are accepted or enroll join the listing's private cohort,
--      if it has one, and get the course lessons hosted here, with progress.
--
-- Anyone, signed in or not, can browse published listings and see a course's
-- outline. Lesson bodies are only for the team and enrolled members.
-- Applications, enrollments and listings are written through the functions
-- and policies below; nothing here is open to anon except the read-only
-- browse and listing-page functions.

begin;

-- ---------------------------------------------------------------------------
-- Organizations become providers.
alter table public.organizations
  add column if not exists provider boolean not null default false,
  add column if not exists tagline  text check (tagline is null or char_length(tagline) <= 160),
  add column if not exists about    text check (about is null or char_length(about) <= 2000);
alter table public.organizations drop constraint if exists organizations_kind_check;
alter table public.organizations add constraint organizations_kind_check
  check (kind in ('accelerator','incubator','nonprofit','university','educator','other'));

-- ---------------------------------------------------------------------------
-- Applications to become a provider.
create table if not exists public.provider_applications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  org_name      text not null check (char_length(org_name) between 2 and 120),
  kind          text not null check (kind in ('accelerator','incubator','nonprofit','university','educator','other')),
  offers        text[] not null check (cardinality(offers) between 1 and 2 and offers <@ array['program','course']),
  website_url   text check (website_url is null or (char_length(website_url) <= 300 and website_url ~* '^https?://')),
  contact_email text check (contact_email is null or (char_length(contact_email) <= 254 and contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  about         text not null check (char_length(about) between 20 and 2000),
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note    text check (admin_note is null or char_length(admin_note) <= 500),
  org_id        uuid references public.organizations(id) on delete set null,
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists provider_applications_status on public.provider_applications (status, created_at desc);
create unique index if not exists provider_applications_one_pending on public.provider_applications (user_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Listings: a program or a course.
create table if not exists public.listings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  kind         text not null check (kind in ('program','course')),
  title        text not null check (char_length(title) between 3 and 120),
  slug         text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  summary      text not null check (char_length(summary) between 10 and 280),
  description  text check (description is null or char_length(description) <= 20000),
  paths        text[] not null default '{}' check (cardinality(paths) <= 12),
  format       text not null default 'online' check (format in ('online','in_person','hybrid')),
  location     text check (location is null or char_length(location) <= 120),
  price_cents  integer check (price_cents is null or price_cents between 0 and 10000000),
  price_note   text check (price_note is null or char_length(price_note) <= 120),
  external_url text check (external_url is null or (char_length(external_url) <= 500 and external_url ~* '^https?://')),
  join_mode    text not null default 'apply' check (join_mode in ('apply','enroll')),
  questions    jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) <= 5),
  capacity     integer check (capacity is null or capacity between 1 and 10000),
  starts_on    date,
  ends_on      date,
  apply_by     date,
  group_id     uuid references public.groups(id) on delete set null,
  status       text not null default 'draft' check (status in ('draft','published','closed')),
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index if not exists listings_org on public.listings (org_id, created_at desc);
create index if not exists listings_published on public.listings (status, kind, created_at desc);

-- Who has applied or enrolled.
create table if not exists public.listing_enrollments (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  status      text not null check (status in ('applied','enrolled','declined','withdrawn','removed')),
  answers     jsonb not null default '[]'::jsonb check (jsonb_typeof(answers) = 'array' and jsonb_array_length(answers) <= 5),
  note        text check (note is null or char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid references public.profiles(id) on delete set null,
  unique (listing_id, user_id)
);
create index if not exists listing_enrollments_user on public.listing_enrollments (user_id, created_at desc);
create index if not exists listing_enrollments_listing on public.listing_enrollments (listing_id, status);

-- Course content.
create table if not exists public.course_modules (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id) on delete cascade,
  position    integer not null default 0,
  title       text not null check (char_length(title) between 1 and 120),
  created_at  timestamptz not null default now()
);
create index if not exists course_modules_listing on public.course_modules (listing_id, position);

create table if not exists public.course_lessons (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id) on delete cascade,
  module_id   uuid not null references public.course_modules(id) on delete cascade,
  position    integer not null default 0,
  title       text not null check (char_length(title) between 1 and 160),
  body        text check (body is null or char_length(body) <= 40000),
  video_url   text check (video_url is null or (char_length(video_url) <= 500 and video_url ~* '^https://')),
  minutes     integer check (minutes is null or minutes between 1 and 600),
  tool_key    text check (tool_key is null or tool_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists course_lessons_module on public.course_lessons (module_id, position);
create index if not exists course_lessons_listing on public.course_lessons (listing_id);

create table if not exists public.lesson_progress (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  lesson_id    uuid not null references public.course_lessons(id) on delete cascade,
  listing_id   uuid not null references public.listings(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create index if not exists lesson_progress_listing on public.lesson_progress (listing_id, user_id);

-- ---------------------------------------------------------------------------
-- Helpers.

-- On the listing's team: its organization's owner, admins or staff (or a
-- NoBossly admin).
create or replace function public.listing_team(p_listing uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from listings l join org_admins oa on oa.org_id = l.org_id
                  where l.id = p_listing and oa.user_id = auth.uid())
      or public.is_admin();
$function$;

-- Enrolled in the listing (accepted, or enrolled straight away).
create or replace function public.listing_learner(p_listing uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from listing_enrollments
                  where listing_id = p_listing and user_id = auth.uid() and status = 'enrolled');
$function$;

-- Tell everyone on an organization's team.
create or replace function public.notify_org_team(p_org uuid, p_entity_type text, p_entity uuid, p_message text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  select oa.user_id, 'cohort', auth.uid(), p_entity_type, p_entity, left(p_message, 200), false
    from org_admins oa where oa.org_id = p_org and oa.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
$function$;

-- Listings: keep the cohort inside the provider's own organization, only an
-- approved provider publishes, and stamp updated_at.
create or replace function public.listings_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.group_id is not null and not exists (select 1 from groups where id = new.group_id and org_id = new.org_id) then
    raise exception 'That cohort belongs to another organization.';
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published')
     and not exists (select 1 from organizations where id = new.org_id and provider) then
    raise exception 'This organization is not approved to publish yet.';
  end if;
  if tg_op = 'UPDATE' and new.org_id <> old.org_id then raise exception 'A listing cannot move to another organization.'; end if;
  new.updated_at := now();
  return new;
end
$function$;
drop trigger if exists listings_guard on public.listings;
create trigger listings_guard before insert or update on public.listings
  for each row execute function public.listings_guard();

-- Lessons stay inside their own course, and their module inside it too.
create or replace function public.course_lessons_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (select 1 from course_modules where id = new.module_id and listing_id = new.listing_id) then
    raise exception 'That module belongs to another course.';
  end if;
  new.updated_at := now();
  return new;
end
$function$;
drop trigger if exists course_lessons_guard on public.course_lessons;
create trigger course_lessons_guard before insert or update on public.course_lessons
  for each row execute function public.course_lessons_guard();

-- ---------------------------------------------------------------------------
-- Row policies.
alter table public.provider_applications enable row level security;
alter table public.listings              enable row level security;
alter table public.listing_enrollments   enable row level security;
alter table public.course_modules        enable row level security;
alter table public.course_lessons        enable row level security;
alter table public.lesson_progress       enable row level security;

revoke all on public.provider_applications, public.listing_enrollments, public.course_modules,
              public.course_lessons, public.lesson_progress, public.listings from anon;
-- Applications and enrollments are only ever written through the functions.
revoke insert, update, delete on public.provider_applications, public.listing_enrollments from authenticated;

drop policy if exists provider_applications_select on public.provider_applications;
create policy provider_applications_select on public.provider_applications for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Published (and closed) listings are public; drafts only to their team.
grant select on public.listings to anon;
drop policy if exists listings_select_anon on public.listings;
create policy listings_select_anon on public.listings for select to anon
  using (status in ('published','closed'));
drop policy if exists listings_select on public.listings;
create policy listings_select on public.listings for select to authenticated
  using (status in ('published','closed') or public.is_org_admin(org_id) or public.is_admin());
drop policy if exists listings_insert on public.listings;
create policy listings_insert on public.listings for insert to authenticated
  with check (public.is_org_admin(org_id) and created_by = auth.uid());
drop policy if exists listings_update on public.listings;
create policy listings_update on public.listings for update to authenticated
  using (public.is_org_admin(org_id) or public.is_admin())
  with check (public.is_org_admin(org_id) or public.is_admin());
drop policy if exists listings_delete on public.listings;
create policy listings_delete on public.listings for delete to authenticated
  using (public.org_role(org_id) in ('owner','admin') or public.is_admin());

drop policy if exists listing_enrollments_select on public.listing_enrollments;
create policy listing_enrollments_select on public.listing_enrollments for select to authenticated
  using (user_id = auth.uid() or public.listing_team(listing_id));

-- Course content: the team writes it; the team and enrolled members read it.
drop policy if exists course_modules_select on public.course_modules;
create policy course_modules_select on public.course_modules for select to authenticated
  using (public.listing_team(listing_id) or public.listing_learner(listing_id));
drop policy if exists course_modules_write on public.course_modules;
create policy course_modules_write on public.course_modules for all to authenticated
  using (public.listing_team(listing_id)) with check (public.listing_team(listing_id));

drop policy if exists course_lessons_select on public.course_lessons;
create policy course_lessons_select on public.course_lessons for select to authenticated
  using (public.listing_team(listing_id) or public.listing_learner(listing_id));
drop policy if exists course_lessons_write on public.course_lessons;
create policy course_lessons_write on public.course_lessons for all to authenticated
  using (public.listing_team(listing_id)) with check (public.listing_team(listing_id));

-- Progress: your own, while enrolled, on a lesson of that same course. The
-- team sees its learners' progress.
drop policy if exists lesson_progress_select on public.lesson_progress;
create policy lesson_progress_select on public.lesson_progress for select to authenticated
  using (user_id = auth.uid() or public.listing_team(listing_id));
drop policy if exists lesson_progress_insert on public.lesson_progress;
create policy lesson_progress_insert on public.lesson_progress for insert to authenticated
  with check (user_id = auth.uid() and public.listing_learner(listing_id)
              and exists (select 1 from course_lessons cl where cl.id = lesson_id and cl.listing_id = lesson_progress.listing_id));
drop policy if exists lesson_progress_delete on public.lesson_progress;
create policy lesson_progress_delete on public.lesson_progress for delete to authenticated
  using (user_id = auth.uid());
revoke update on public.lesson_progress from authenticated;

-- ---------------------------------------------------------------------------
-- Becoming a provider.

-- Apply. One pending application at a time. Returns its id, or null when one
-- is already pending (or the caller already runs a provider organization).
create or replace function public.provider_apply(p_org_name text, p_kind text, p_offers text[], p_website text,
                                                 p_email text, p_about text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare aid uuid;
begin
  if auth.uid() is null then return null; end if;
  if exists (select 1 from provider_applications where user_id = auth.uid() and status = 'pending') then return null; end if;
  if exists (select 1 from org_admins oa join organizations o on o.id = oa.org_id
              where oa.user_id = auth.uid() and oa.role = 'owner' and o.provider) then return null; end if;
  insert into provider_applications (user_id, org_name, kind, offers, website_url, contact_email, about)
  values (auth.uid(), trim(p_org_name), p_kind, p_offers, nullif(trim(p_website), ''), nullif(lower(trim(p_email)), ''), trim(p_about))
  returning id into aid;
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  select p.id, 'system', auth.uid(), 'provider_applications', aid,
         'New provider application: ' || left(trim(p_org_name), 80), false
    from profiles p where p.is_admin and p.id <> auth.uid();
  return aid;
end
$function$;

-- Approve or reject (NoBossly admins). Approving creates the organization,
-- makes the applicant its owner and marks it a provider. Returns the new
-- organization's slug, '' on a rejection, null when not allowed.
create or replace function public.provider_decide(p_application uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare a provider_applications%rowtype; base text; s text; n int := 1; oid uuid;
begin
  if not public.is_admin() then return null; end if;
  select * into a from provider_applications where id = p_application and status = 'pending' for update;
  if not found then return null; end if;
  if not p_approve then
    update provider_applications set status = 'rejected', admin_note = nullif(left(trim(p_note), 500), ''),
           reviewed_by = auth.uid(), reviewed_at = now() where id = a.id;
    insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
    values (a.user_id, 'system', auth.uid(), 'provider_applications', a.id,
            'Your provider application for ' || left(a.org_name, 80) || ' was not approved.', false);
    return '';
  end if;
  base := left(trim(both '-' from regexp_replace(lower(a.org_name), '[^a-z0-9]+', '-', 'g')), 50);
  if char_length(base) < 2 then base := 'provider'; end if;
  s := base;
  while exists (select 1 from organizations where slug = s) loop
    n := n + 1; s := base || '-' || n;
  end loop;
  insert into organizations (name, slug, kind, website_url, contact_email, about, provider, created_by)
  values (a.org_name, s, a.kind, a.website_url, a.contact_email, a.about, true, auth.uid())
  returning id into oid;
  insert into org_admins (org_id, user_id, role) values (oid, a.user_id, 'owner') on conflict do nothing;
  update provider_applications set status = 'approved', org_id = oid, admin_note = nullif(left(trim(p_note), 500), ''),
         reviewed_by = auth.uid(), reviewed_at = now() where id = a.id;
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (a.user_id, 'system', auth.uid(), 'provider_applications', a.id,
          'You are approved as a provider: ' || left(a.org_name, 80) || '. Publish your first program or course.', false);
  return s;
end
$function$;

-- ---------------------------------------------------------------------------
-- Joining a listing.

-- Apply or enroll. Returns the resulting status ('applied', 'enrolled'), or
-- why not: 'closed', 'full', 'declined', 'removed', 'own' (it is your own
-- organization's listing), 'invalid'.
create or replace function public.listing_join(p_listing uuid, p_answers text[] default '{}')
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare l listings%rowtype; cur listing_enrollments%rowtype; qs jsonb; ans jsonb := '[]'::jsonb; i int; st text; eid uuid;
begin
  if auth.uid() is null then return 'invalid'; end if;
  select * into l from listings where id = p_listing;
  if not found or l.status <> 'published' then return case when found and l.status = 'closed' then 'closed' else 'invalid' end; end if;
  if exists (select 1 from org_admins where org_id = l.org_id and user_id = auth.uid()) then return 'own'; end if;
  if l.apply_by is not null and l.apply_by < current_date then return 'closed'; end if;
  select * into cur from listing_enrollments where listing_id = l.id and user_id = auth.uid();
  if found and cur.status in ('applied','enrolled') then return cur.status; end if;
  if found and cur.status in ('declined','removed') then return cur.status; end if;
  if l.join_mode = 'enroll' and l.capacity is not null
     and (select count(*) from listing_enrollments where listing_id = l.id and status = 'enrolled') >= l.capacity then
    return 'full';
  end if;
  qs := l.questions;
  for i in 0 .. jsonb_array_length(qs) - 1 loop
    ans := ans || jsonb_build_array(jsonb_build_object('q', qs ->> i,
             'a', left(trim(coalesce(p_answers[i + 1], '')), 2000)));
  end loop;
  st := case when l.join_mode = 'enroll' then 'enrolled' else 'applied' end;
  insert into listing_enrollments (listing_id, user_id, status, answers, decided_at)
  values (l.id, auth.uid(), st, ans, case when st = 'enrolled' then now() end)
  on conflict (listing_id, user_id) do update set status = excluded.status, answers = excluded.answers,
     created_at = now(), decided_at = excluded.decided_at, decided_by = null, note = null
  returning id into eid;
  if st = 'enrolled' and l.group_id is not null then
    insert into group_members (group_id, user_id, role, status) values (l.group_id, auth.uid(), 'member', 'active')
    on conflict (group_id, user_id) do update set status = 'active', joined_at = now()
      where group_members.status <> 'active';
  end if;
  perform public.notify_org_team(l.org_id, 'listing_enrollments', eid,
    (case when st = 'applied' then 'New application: ' else 'New enrollment: ' end) || left(l.title, 100));
  return st;
end
$function$;

-- The team accepts, declines or removes someone. Accepting enrolls them and
-- adds them to the listing's cohort.
create or replace function public.listing_decide(p_enrollment uuid, p_action text, p_note text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare e listing_enrollments%rowtype; l listings%rowtype; st text;
begin
  select * into e from listing_enrollments where id = p_enrollment for update;
  if not found or not public.listing_team(e.listing_id) then return null; end if;
  select * into l from listings where id = e.listing_id;
  if p_action = 'accept' and e.status = 'applied' then st := 'enrolled';
  elsif p_action = 'decline' and e.status = 'applied' then st := 'declined';
  elsif p_action = 'remove' and e.status = 'enrolled' then st := 'removed';
  else return null; end if;
  update listing_enrollments set status = st, note = nullif(left(trim(p_note), 500), ''),
         decided_at = now(), decided_by = auth.uid() where id = e.id;
  if l.group_id is not null then
    if st = 'enrolled' then
      insert into group_members (group_id, user_id, role, status) values (l.group_id, e.user_id, 'member', 'active')
      on conflict (group_id, user_id) do update set status = 'active', joined_at = now()
        where group_members.status <> 'active';
    elsif st = 'removed' then
      update group_members set status = 'removed' where group_id = l.group_id and user_id = e.user_id and role = 'member';
    end if;
  end if;
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (e.user_id, 'cohort', auth.uid(), 'listing_enrollments', e.id,
          case st when 'enrolled' then 'You''re in: ' when 'declined' then 'Not this time: ' else 'You were removed from: ' end
          || left(l.title, 100), false);
  return st;
end
$function$;

-- Withdraw your own application or enrollment.
create or replace function public.listing_withdraw(p_listing uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare l listings%rowtype; was text;
begin
  select status into was from listing_enrollments where listing_id = p_listing and user_id = auth.uid();
  if was is null or was not in ('applied','enrolled') then return false; end if;
  update listing_enrollments set status = 'withdrawn', decided_at = now() where listing_id = p_listing and user_id = auth.uid();
  select * into l from listings where id = p_listing;
  if was = 'enrolled' and l.group_id is not null then
    update group_members set status = 'left' where group_id = l.group_id and user_id = auth.uid() and role = 'member';
  end if;
  return true;
end
$function$;

-- ---------------------------------------------------------------------------
-- Public reads: the marketplace and a listing's page, signed in or not.

create or replace function public.marketplace_listings()
returns table (id uuid, slug text, kind text, title text, summary text, paths text[], format text, location text,
               price_cents integer, price_note text, join_mode text, starts_on date, apply_by date, status text,
               org_name text, org_slug text, org_kind text, lessons integer, created_at timestamptz)
language sql
stable security definer
set search_path to 'public'
as $function$
  select l.id, l.slug, l.kind, l.title, l.summary, l.paths, l.format, l.location, l.price_cents, l.price_note,
         l.join_mode, l.starts_on, l.apply_by, l.status, o.name, o.slug, o.kind,
         (select count(*)::int from course_lessons cl where cl.listing_id = l.id), l.created_at
    from listings l join organizations o on o.id = l.org_id
   where l.status = 'published' and o.provider
   order by l.created_at desc
   limit 500;
$function$;

-- One listing, for its public page: the listing, its provider, the course
-- outline (titles only), seats left, and the caller's own status. Null when
-- it is not published (unless the caller is on its team).
create or replace function public.listing_page(p_slug text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare l listings%rowtype; o organizations%rowtype; team boolean; mine jsonb; outline jsonb; taken int;
begin
  select * into l from listings where slug = p_slug;
  if not found then return null; end if;
  team := auth.uid() is not null and public.listing_team(l.id);
  if l.status = 'draft' and not team then return null; end if;
  select * into o from organizations where id = l.org_id;
  if not o.provider and not team then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('title', m.title, 'lessons',
           (select coalesce(jsonb_agg(jsonb_build_object('title', cl.title, 'minutes', cl.minutes) order by cl.position, cl.created_at), '[]'::jsonb)
              from course_lessons cl where cl.module_id = m.id)) order by m.position, m.created_at), '[]'::jsonb)
    into outline from course_modules m where m.listing_id = l.id;
  select count(*) into taken from listing_enrollments where listing_id = l.id and status = 'enrolled';
  if auth.uid() is not null then
    select jsonb_build_object('status', e.status, 'note', e.note) into mine
      from listing_enrollments e where e.listing_id = l.id and e.user_id = auth.uid();
  end if;
  return jsonb_build_object(
    'id', l.id, 'slug', l.slug, 'kind', l.kind, 'title', l.title, 'summary', l.summary, 'description', l.description,
    'paths', to_jsonb(l.paths), 'format', l.format, 'location', l.location, 'price_cents', l.price_cents,
    'price_note', l.price_note, 'external_url', l.external_url, 'join_mode', l.join_mode, 'questions', l.questions,
    'starts_on', l.starts_on, 'ends_on', l.ends_on, 'apply_by', l.apply_by, 'status', l.status,
    'seats_left', case when l.capacity is null then null else greatest(l.capacity - taken, 0) end,
    'has_cohort', l.group_id is not null,
    'org', jsonb_build_object('name', o.name, 'slug', o.slug, 'kind', o.kind, 'tagline', o.tagline,
                              'about', o.about, 'website_url', o.website_url),
    'outline', outline, 'mine', mine, 'team', team);
end
$function$;

-- What the caller has applied to or joined, for "My programs".
create or replace function public.my_listings()
returns table (enrollment_id uuid, status text, note text, created_at timestamptz, listing_id uuid, slug text, kind text,
               title text, org_name text, starts_on date, lessons integer, done integer)
language sql
stable security definer
set search_path to 'public'
as $function$
  select e.id, e.status, e.note, e.created_at, l.id, l.slug, l.kind, l.title, o.name, l.starts_on,
         (select count(*)::int from course_lessons cl where cl.listing_id = l.id),
         (select count(*)::int from lesson_progress lp where lp.listing_id = l.id and lp.user_id = auth.uid())
    from listing_enrollments e join listings l on l.id = e.listing_id join organizations o on o.id = l.org_id
   where e.user_id = auth.uid()
   order by e.created_at desc;
$function$;

-- Access.
revoke all on function public.listing_team(uuid)                                   from public, anon;
revoke all on function public.listing_learner(uuid)                                from public, anon;
revoke all on function public.notify_org_team(uuid, text, uuid, text)              from public, anon, authenticated;
revoke all on function public.listings_guard()                                     from public, anon, authenticated;
revoke all on function public.course_lessons_guard()                               from public, anon, authenticated;
revoke all on function public.provider_apply(text, text, text[], text, text, text) from public, anon;
revoke all on function public.provider_decide(uuid, boolean, text)                 from public, anon;
revoke all on function public.listing_join(uuid, text[])                           from public, anon;
revoke all on function public.listing_decide(uuid, text, text)                     from public, anon;
revoke all on function public.listing_withdraw(uuid)                               from public, anon;
revoke all on function public.marketplace_listings()                               from public;
revoke all on function public.listing_page(text)                                   from public;
revoke all on function public.my_listings()                                       from public, anon;
grant execute on function public.listing_team(uuid)                                   to authenticated;
grant execute on function public.listing_learner(uuid)                                to authenticated;
grant execute on function public.provider_apply(text, text, text[], text, text, text) to authenticated;
grant execute on function public.provider_decide(uuid, boolean, text)                 to authenticated;
grant execute on function public.listing_join(uuid, text[])                           to authenticated;
grant execute on function public.listing_decide(uuid, text, text)                     to authenticated;
grant execute on function public.listing_withdraw(uuid)                               to authenticated;
grant execute on function public.marketplace_listings()                               to anon, authenticated;
grant execute on function public.listing_page(text)                                   to anon, authenticated;
grant execute on function public.my_listings()                                        to authenticated;

commit;
