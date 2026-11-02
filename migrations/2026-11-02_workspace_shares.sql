-- Applied live 2026-11-02 (run in the SQL Editor in three parts; verified: table, RLS, 9 functions, grants, email type).
--
-- Sharing a worksheet (a canvas, a plan, a persona…) read-only, for members
-- who are part of an accelerator cohort — a group under an organization — or
-- on a program's team. Two ways:
--
--   1. With someone in your cohort, picked by name. It appears under "Shared
--      with you" for them, and they get a notification.
--   2. By email: a read-only link with a long random token, which works
--      without an account and expires after 30 days.
--
-- Either can be revoked at any time. A share is live, not a copy: the
-- recipient sees the worksheet as it is now. workspace_docs stays owner-only;
-- recipients only ever read a shared document through shared_doc() or
-- shared_doc_by_token(), which check the share first.

begin;

create table if not exists public.workspace_shares (
  id             uuid primary key default gen_random_uuid(),
  doc_id         uuid not null references public.workspace_docs(id) on delete cascade,
  owner_id       uuid not null references public.profiles(id) on delete cascade,
  recipient_id   uuid references public.profiles(id) on delete cascade,
  email          text check (email is null or (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  token          text unique check (token is null or token ~ '^[a-f0-9]{48,64}$'),
  note           text check (note is null or char_length(note) <= 500),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  last_viewed_at timestamptz,
  -- Exactly one of: a member, or an email with its link token.
  check ((recipient_id is not null and email is null and token is null)
      or (recipient_id is null and email is not null and token is not null and expires_at is not null))
);
create index if not exists workspace_shares_doc on public.workspace_shares (doc_id, created_at desc);
create index if not exists workspace_shares_recipient on public.workspace_shares (recipient_id, created_at desc) where recipient_id is not null;
create unique index if not exists workspace_shares_once on public.workspace_shares (doc_id, recipient_id)
  where recipient_id is not null and revoked_at is null;

alter table public.workspace_shares enable row level security;
revoke all on public.workspace_shares from anon;
-- Written only through the functions below.
revoke insert, update, delete on public.workspace_shares from authenticated;

drop policy if exists workspace_shares_select on public.workspace_shares;
create policy workspace_shares_select on public.workspace_shares for select to authenticated
  using (owner_id = auth.uid() or recipient_id = auth.uid());

-- People the caller may share with: everyone in the caller's cohorts (active
-- members, plus the program team of each cohort's organization), not the
-- caller. Empty when the caller is in no cohort.
create or replace function public.share_candidates()
returns table (user_id uuid, username text, display_name text, cohort text)
language sql
stable security definer
set search_path to 'public'
as $function$
  with mine as (
    select g.id, g.name, g.org_id from groups g
     where g.org_id is not null and public.group_role(g.id) is not null
  ), people as (
    select m.user_id, mine.name as cohort from mine join group_members m on m.group_id = mine.id and m.status = 'active'
    union
    select oa.user_id, mine.name from mine join org_admins oa on oa.org_id = mine.org_id
  )
  select distinct on (p.id) p.id, p.username, p.display_name, people.cohort
    from people join profiles p on p.id = people.user_id
   where p.id <> auth.uid() and coalesce(p.account_status, 'active') = 'active'
   order by p.id, people.cohort;
$function$;

-- Whether the caller may share at all (in a cohort, or on a program team).
create or replace function public.can_share_docs()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from groups g where g.org_id is not null and public.group_role(g.id) is not null)
      or exists (select 1 from org_admins where user_id = auth.uid());
$function$;

-- Share with a member of one of your cohorts. Returns the share id, or null
-- when not allowed (not your document, or they are not in your cohorts).
create or replace function public.doc_share_member(p_doc uuid, p_recipient uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare d workspace_docs%rowtype; sid uuid;
begin
  if auth.uid() is null then return null; end if;
  select * into d from workspace_docs where id = p_doc and user_id = auth.uid();
  if not found then return null; end if;
  if not exists (select 1 from public.share_candidates() c where c.user_id = p_recipient) then return null; end if;
  select id into sid from workspace_shares
   where doc_id = p_doc and recipient_id = p_recipient and revoked_at is null;
  if sid is not null then return sid; end if;   -- already shared: no second notification
  insert into workspace_shares (doc_id, owner_id, recipient_id, note)
  values (p_doc, auth.uid(), p_recipient, nullif(left(trim(p_note), 500), ''))
  returning id into sid;
  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (p_recipient, 'cohort', auth.uid(), 'workspace_shares', sid,
          'Shared with you: "' || left(coalesce(nullif(d.title, ''), 'a worksheet'), 80) || '"', false);
  return sid;
end
$function$;

-- Share by email: returns the link token, or null when not allowed. At most
-- 20 email shares a day per member, so this cannot be used to send spam.
create or replace function public.doc_share_email(p_doc uuid, p_email text, p_note text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare tok text; n int;
begin
  if auth.uid() is null or not public.can_share_docs() then return null; end if;
  if not exists (select 1 from workspace_docs where id = p_doc and user_id = auth.uid()) then return null; end if;
  select count(*) into n from workspace_shares
   where owner_id = auth.uid() and email is not null and created_at > now() - interval '24 hours';
  if n >= 20 then return null; end if;
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into workspace_shares (doc_id, owner_id, email, token, note, expires_at)
  values (p_doc, auth.uid(), lower(trim(p_email)), tok, nullif(left(trim(p_note), 500), ''), now() + interval '30 days');
  return tok;
end
$function$;

create or replace function public.doc_share_revoke(p_share uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update workspace_shares set revoked_at = now()
   where id = p_share and owner_id = auth.uid() and revoked_at is null;
  return found;
end
$function$;

-- What a document looks like to someone it was shared with.
create or replace function public.shared_doc_json(p_share workspace_shares)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'share_id', p_share.id, 'kind', d.kind, 'title', d.title, 'data', d.data, 'updated_at', d.updated_at,
    'owner', coalesce(nullif(p.display_name, ''), p.username), 'note', p_share.note)
    from workspace_docs d join profiles p on p.id = d.user_id
   where d.id = p_share.doc_id;
$function$;

-- Open a document shared with you (by id). Null if it is not yours to see.
create or replace function public.shared_doc(p_share uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare s workspace_shares%rowtype;
begin
  select * into s from workspace_shares
   where id = p_share and recipient_id = auth.uid() and revoked_at is null;
  if not found then return null; end if;
  update workspace_shares set last_viewed_at = now() where id = s.id;
  return public.shared_doc_json(s);
end
$function$;

-- Open a document from an emailed link. Works signed out. Null when the link
-- is unknown, revoked or expired.
create or replace function public.shared_doc_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare s workspace_shares%rowtype;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{48,64}$' then return null; end if;
  select * into s from workspace_shares
   where token = p_token and revoked_at is null and expires_at > now();
  if not found then return null; end if;
  update workspace_shares set last_viewed_at = now() where id = s.id;
  return public.shared_doc_json(s);
end
$function$;

-- Documents shared with the caller, newest first, for "Shared with you".
create or replace function public.shared_with_me()
returns table (share_id uuid, kind text, title text, owner text, shared_at timestamptz, updated_at timestamptz)
language sql
stable security definer
set search_path to 'public'
as $function$
  select s.id, d.kind, d.title, coalesce(nullif(p.display_name, ''), p.username), s.created_at, d.updated_at
    from workspace_shares s
    join workspace_docs d on d.id = s.doc_id
    join profiles p on p.id = s.owner_id
   where s.recipient_id = auth.uid() and s.revoked_at is null
   order by s.created_at desc;
$function$;

revoke all on function public.share_candidates()                      from public, anon;
revoke all on function public.can_share_docs()                        from public, anon;
revoke all on function public.doc_share_member(uuid, uuid, text)      from public, anon;
revoke all on function public.doc_share_email(uuid, text, text)       from public, anon;
revoke all on function public.doc_share_revoke(uuid)                  from public, anon;
revoke all on function public.shared_doc_json(workspace_shares)       from public, anon, authenticated;
revoke all on function public.shared_doc(uuid)                        from public, anon;
revoke all on function public.shared_doc_by_token(text)               from public;
revoke all on function public.shared_with_me()                        from public, anon;
grant execute on function public.share_candidates()                   to authenticated;
grant execute on function public.can_share_docs()                     to authenticated;
grant execute on function public.doc_share_member(uuid, uuid, text)   to authenticated;
grant execute on function public.doc_share_email(uuid, text, text)    to authenticated;
grant execute on function public.doc_share_revoke(uuid)               to authenticated;
grant execute on function public.shared_doc(uuid)                     to authenticated;
grant execute on function public.shared_doc_by_token(text)            to anon, authenticated;
grant execute on function public.shared_with_me()                     to authenticated;

-- The email that carries a share link.
alter table public.email_log drop constraint if exists email_log_email_type_check;
alter table public.email_log add constraint email_log_email_type_check check (email_type = any (array[
  'welcome','weekly_brief','subscription_confirmed','milestone_achieved','streak_reminder','badge_earned',
  'notification_digest','custom','resume_questionnaire','comeback','task_reminder','doc_share']));

commit;
