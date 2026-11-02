-- Applied live 2026-11-02 (run by hand in the SQL Editor).
--
-- Keeps emails, phone numbers and street addresses out of member-written text,
-- in the database as well as in the app (src/personal_info_filter.js), so a
-- write that goes straight to the API with a member's token is refused too.
--
-- The patterns mirror the JS ones. Both were run against the same 28 sample
-- sentences on 2026-11-01 (18 that must match, 10 ordinary sentences that must
-- not — "3 hours on the road", "unit 3 of the course", dates, prices, links)
-- and agreed on every one. test/personal-info.js holds the samples.
--
-- Links and social handles are allowed: members share their business sites.

-- ---------------------------------------------------------------------------
-- The check. Plain (not SECURITY DEFINER) and immutable. The triggers below run
-- as the member writing, so `authenticated` keeps EXECUTE; nobody signed out
-- writes to these tables.
create or replace function public.contains_personal_info(p_text text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select coalesce(p_text, '') <> '' and (
       p_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
    or p_text ~* '[a-z0-9._%+-]+\s*[([{]?\s*(at|@)\s*[)\]}]?\s*[a-z0-9-]+\s*[([{]?\s*(dot|\.)\s*[)\]}]?\s*(com|net|org|io|co|edu|gov|us|uk|ca|me|info|biz|app|dev)\y'
    or p_text ~* '(\+?1[\s.-]?)?\(?\y\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\y'
    or p_text ~* '\+\d[\d\s().-]{8,}\d'
    or p_text ~* '\y\d{10,15}\y'
    or p_text ~* '\y(zero|oh|one|two|three|four|five|six|seven|eight|nine)([\s,.-]+(zero|oh|one|two|three|four|five|six|seven|eight|nine)){6,}\y'
    or p_text ~* '\y\d{1,6}\s+((?!(on|the|in|to|a|an|of|down|up|my|your|our|their|at|for|from|with|by|this|that|and|or|hours?|days?|weeks?|months?|years?|miles?|minutes?|times?)\y)[a-z0-9.''-]+\s+){1,4}(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln)\y'
    or p_text ~* '\yp\.?\s*o\.?\s*box\s*\d+'
    or p_text ~* '\y(apt|apartment|suite|ste)\.?\s*#?\s*\d+[a-z]?\y|\yunit\s*#\s*\d+[a-z]?\y'
  );
$function$;

revoke all on function public.contains_personal_info(text) from public, anon;
grant execute on function public.contains_personal_info(text) to authenticated;

-- ---------------------------------------------------------------------------
-- One trigger function for every table: it is told which columns to read.
-- Fires on INSERT and on UPDATE OF the text columns only, so marking a message
-- read or bumping a reply count never re-checks text written before this.
create or replace function public.refuse_personal_info()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  col text;
  val text;
begin
  foreach col in array tg_argv loop
    execute format('select ($1).%I::text', col) into val using new;
    if public.contains_personal_info(val) then
      raise exception 'Please remove emails, phone numbers and street addresses. Use NoBossly messages to connect.'
        using errcode = 'check_violation', hint = 'personal_info';
    end if;
  end loop;
  return new;
end
$function$;

revoke all on function public.refuse_personal_info() from public, anon, authenticated;

drop trigger if exists messages_refuse_personal_info on public.messages;
create trigger messages_refuse_personal_info
  before insert or update of content on public.messages
  for each row execute function public.refuse_personal_info('content');

drop trigger if exists group_posts_refuse_personal_info on public.group_posts;
create trigger group_posts_refuse_personal_info
  before insert or update of body on public.group_posts
  for each row execute function public.refuse_personal_info('body');

drop trigger if exists forum_threads_refuse_personal_info on public.forum_threads;
create trigger forum_threads_refuse_personal_info
  before insert or update of title, body, body_html on public.forum_threads
  for each row execute function public.refuse_personal_info('title', 'body', 'body_html');

drop trigger if exists forum_replies_refuse_personal_info on public.forum_replies;
create trigger forum_replies_refuse_personal_info
  before insert or update of body, body_html on public.forum_replies
  for each row execute function public.refuse_personal_info('body', 'body_html');

-- ---------------------------------------------------------------------------
-- Refused writes, for admin review (3+ in a day is the threshold to look at).
-- What kind of detail and where — never the text itself.
create table if not exists public.filter_hits (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('email', 'phone', 'address')),
  context    text not null check (char_length(context) <= 40),
  created_at timestamptz not null default now()
);
create index if not exists filter_hits_user_day on public.filter_hits (user_id, created_at desc);

alter table public.filter_hits enable row level security;
drop policy if exists filter_hits_insert_own on public.filter_hits;
create policy filter_hits_insert_own on public.filter_hits
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists filter_hits_admin_read on public.filter_hits;
create policy filter_hits_admin_read on public.filter_hits
  for select to authenticated using (public.is_admin());
revoke all on public.filter_hits from anon;
