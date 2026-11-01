-- NOT APPLIED, written for review.
--
-- Path dashboards, step 1: the storage every tailored dashboard is built from
-- (docs/path-dashboards.md). Four member-owned tables, path setup answers on
-- the profile, and the survey maker on the existing (unused) survey tables.
--
-- All of it is private to the member who owns it. Nothing here is public
-- except a published survey's questions, and only through survey_public().

begin;

-- ---------------------------------------------------------------------------
-- Path setup: the subpath (column exists) and the few path questions that
-- shape the dashboard, asked right after a path is chosen.
alter table public.profiles add column if not exists path_answers jsonb not null default '{}'::jsonb;
alter table public.profiles drop constraint if exists profiles_path_answers_size;
alter table public.profiles add constraint profiles_path_answers_size
  check (jsonb_typeof(path_answers) = 'object' and pg_column_size(path_answers) < 8000);

-- ---------------------------------------------------------------------------
-- The building blocks. Kinds, boards, metrics and checklists are named by the
-- path configs in src/path_dashboards/ and src/workspace/, so new ones need no
-- migration; the database only holds the shape and the owner.
create table if not exists public.workspace_docs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  title       text not null default '' check (char_length(title) <= 120),
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 200000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists workspace_docs_owner on public.workspace_docs (user_id, kind, updated_at desc);

create table if not exists public.pipeline_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  board       text not null check (board ~ '^[a-z][a-z0-9_]{1,39}$'),
  stage       text not null check (stage ~ '^[a-z][a-z0-9_]{1,39}$'),
  title       text not null check (char_length(title) between 1 and 160),
  value       numeric check (value is null or value between -100000000 and 100000000),
  due_on      date,
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 20000),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pipeline_items_owner on public.pipeline_items (user_id, board, stage, position);

create table if not exists public.metric_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  metric      text not null check (metric ~ '^[a-z][a-z0-9_]{1,39}$'),
  period      date not null,
  value       numeric not null check (value between -1000000000 and 1000000000),
  note        text check (note is null or char_length(note) <= 200),
  created_at  timestamptz not null default now(),
  unique (user_id, metric, period)
);
create index if not exists metric_entries_owner on public.metric_entries (user_id, metric, period desc);

create table if not exists public.checklist_progress (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  checklist   text not null check (checklist ~ '^[a-z][a-z0-9_]{1,39}$'),
  item        text not null check (item ~ '^[a-z][a-z0-9_]{1,39}$'),
  done_at     timestamptz,
  due_on      date,
  note        text check (note is null or char_length(note) <= 200),
  primary key (user_id, checklist, item)
);

-- updated_at stays honest without trusting the client.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  return new;
end
$function$;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

drop trigger if exists workspace_docs_touch on public.workspace_docs;
create trigger workspace_docs_touch before update on public.workspace_docs
  for each row execute function public.touch_updated_at();
drop trigger if exists pipeline_items_touch on public.pipeline_items;
create trigger pipeline_items_touch before update on public.pipeline_items
  for each row execute function public.touch_updated_at();

-- Owner-only, for every operation.
alter table public.workspace_docs     enable row level security;
alter table public.pipeline_items     enable row level security;
alter table public.metric_entries     enable row level security;
alter table public.checklist_progress enable row level security;
revoke all on public.workspace_docs, public.pipeline_items, public.metric_entries, public.checklist_progress from anon;

drop policy if exists workspace_docs_own on public.workspace_docs;
create policy workspace_docs_own on public.workspace_docs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists pipeline_items_own on public.pipeline_items;
create policy pipeline_items_own on public.pipeline_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists metric_entries_own on public.metric_entries;
create policy metric_entries_own on public.metric_entries for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists checklist_progress_own on public.checklist_progress;
create policy checklist_progress_own on public.checklist_progress for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Survey maker, on the existing surveys / survey_responses tables (0 rows).
--
-- surveys used to be readable by anyone (select policy `true`) and had no
-- draft state; responses had to come from a signed-in member. A survey is now
-- private to its creator, can be shared by a code, and anyone with the link
-- can answer once — through survey_submit(), which checks every answer.

alter table public.surveys add column if not exists share_code text;
alter table public.surveys add column if not exists max_responses integer not null default 1000
  check (max_responses between 1 and 10000);
create unique index if not exists surveys_share_code on public.surveys (share_code) where share_code is not null;

alter table public.surveys drop constraint if exists surveys_status_check;
alter table public.surveys alter column status set default 'draft';
alter table public.surveys add constraint surveys_status_check
  check (status = any (array['draft','active','closed','archived']));
alter table public.surveys drop constraint if exists surveys_shape;
alter table public.surveys add constraint surveys_shape check (
  char_length(title) between 1 and 160
  and (description is null or char_length(description) <= 2000)
  and jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) <= 40
  and pg_column_size(questions) < 60000
  and (share_code is null or share_code ~ '^[A-Za-z0-9_-]{10,40}$'));

drop policy if exists surveys_select on public.surveys;
create policy surveys_select on public.surveys for select to authenticated
  using (creator_id = auth.uid() or public.is_admin());
drop policy if exists surveys_insert on public.surveys;
create policy surveys_insert on public.surveys for insert to authenticated
  with check (creator_id = auth.uid());
drop policy if exists surveys_update on public.surveys;
create policy surveys_update on public.surveys for update to authenticated
  using (creator_id = auth.uid()) with check (creator_id = auth.uid());
drop policy if exists surveys_delete on public.surveys;
create policy surveys_delete on public.surveys for delete to authenticated
  using (creator_id = auth.uid());
revoke all on public.surveys from anon;

-- Someone outside NoBossly can answer: no member id, a visitor key instead
-- (a hash the app derives per survey from a long-lived cookie).
alter table public.survey_responses alter column responder_id drop not null;
alter table public.survey_responses add column if not exists visitor_key text
  check (visitor_key is null or visitor_key ~ '^[a-f0-9]{32,64}$');
create unique index if not exists survey_responses_visitor on public.survey_responses (survey_id, visitor_key)
  where visitor_key is not null;
alter table public.survey_responses drop constraint if exists survey_responses_answers_size;
alter table public.survey_responses add constraint survey_responses_answers_size
  check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) < 40000);

-- Only survey_submit() writes responses; creators read their own surveys'.
drop policy if exists survey_responses_insert on public.survey_responses;
revoke insert, update, delete on public.survey_responses from anon, authenticated;
revoke select on public.survey_responses from anon;

-- A published survey's public face: title, description and questions. Nothing
-- about the creator beyond a display name.
create or replace function public.survey_public(p_code text)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', s.id, 'title', s.title, 'description', s.description, 'questions', s.questions,
    'status', s.status, 'by', coalesce(p.display_name, p.username))
    from surveys s join profiles p on p.id = s.creator_id
   where s.share_code = p_code and s.status in ('active', 'closed')
     and coalesce(p.account_status, 'active') = 'active';
$function$;

-- One answer per visitor (or member) per survey, only while it is open, only
-- to the questions it asks, and only up to its response cap.
create or replace function public.survey_submit(p_code text, p_answers jsonb, p_visitor text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  s surveys%rowtype;
  q jsonb;
  a jsonb;
  clean jsonb := '{}'::jsonb;
  qid text; qtype text; opts jsonb;
begin
  select * into s from surveys where share_code = p_code;
  if not found or s.status <> 'active' then return 'closed'; end if;
  if s.deadline is not null and s.deadline < current_date then return 'closed'; end if;
  if s.response_count >= s.max_responses then return 'full'; end if;
  if p_visitor is null or p_visitor !~ '^[a-f0-9]{32,64}$' then return 'invalid'; end if;
  if auth.uid() is not null and exists (select 1 from survey_responses where survey_id = s.id and responder_id = auth.uid()) then
    return 'duplicate';
  end if;
  if exists (select 1 from survey_responses where survey_id = s.id and visitor_key = p_visitor) then
    return 'duplicate';
  end if;
  if jsonb_typeof(p_answers) <> 'object' then return 'invalid'; end if;

  -- Keep only answers to real questions, shaped the way each type expects.
  for q in select * from jsonb_array_elements(s.questions) loop
    qid := q->>'id'; qtype := q->>'type'; opts := coalesce(q->'options', '[]'::jsonb);
    a := p_answers->qid;
    if a is null or a = 'null'::jsonb then
      if coalesce((q->>'required')::boolean, false) then return 'missing'; end if;
      continue;
    end if;
    if qtype in ('short_text', 'long_text') then
      if jsonb_typeof(a) <> 'string' then return 'invalid'; end if;
      if btrim(a #>> '{}') = '' then
        if coalesce((q->>'required')::boolean, false) then return 'missing'; end if;
        continue;
      end if;
      clean := clean || jsonb_build_object(qid, left(a #>> '{}', case when qtype = 'short_text' then 300 else 3000 end));
    elsif qtype in ('single_choice', 'yes_no') then
      if jsonb_typeof(a) <> 'string' then return 'invalid'; end if;
      if qtype = 'yes_no' and (a #>> '{}') not in ('yes', 'no') then return 'invalid'; end if;
      if qtype = 'single_choice' and not (opts ? (a #>> '{}')) then return 'invalid'; end if;
      clean := clean || jsonb_build_object(qid, a);
    elsif qtype = 'multi_choice' then
      if jsonb_typeof(a) <> 'array' then return 'invalid'; end if;
      if exists (select 1 from jsonb_array_elements_text(a) v where not (opts ? v)) then return 'invalid'; end if;
      if coalesce((q->>'required')::boolean, false) and jsonb_array_length(a) = 0 then return 'missing'; end if;
      clean := clean || jsonb_build_object(qid, a);
    elsif qtype = 'rating' then
      if jsonb_typeof(a) <> 'number' or (a #>> '{}')::numeric not in (1, 2, 3, 4, 5) then return 'invalid'; end if;
      clean := clean || jsonb_build_object(qid, a);
    end if;
  end loop;

  insert into survey_responses (survey_id, responder_id, visitor_key, answers)
  values (s.id, auth.uid(), p_visitor, clean);
  return 'ok';
exception when unique_violation then
  return 'duplicate';
end
$function$;

revoke all on function public.survey_public(text) from public;
revoke all on function public.survey_submit(text, jsonb, text) from public;
grant execute on function public.survey_public(text) to anon, authenticated;
grant execute on function public.survey_submit(text, jsonb, text) to anon, authenticated;

commit;
