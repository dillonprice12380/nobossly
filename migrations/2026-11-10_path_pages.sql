-- NOT APPLIED. Run in the Supabase SQL Editor; it ends with one row, ok = true.
--
-- Path pages (2026-11-10):
--
--  * profiles.saved_paths keeps a member's setup answers for the paths they
--    switched away from ({ "<path>": { "subpath": ..., "answers": {...} } }),
--    so switching back brings them back. Members already update their own
--    profile row, so no new grant or policy is needed.
--  * path_community(path) is what a path's public page shows about its
--    community: how many members are on it, their questions from the last 90
--    days (title, reply count, whether it was answered; no names), and how many
--    co-working sessions are coming up for that path or for everyone. Counts and
--    titles only: thread titles are already public, and no member, private
--    profile or co-working link is exposed.

begin;

alter table public.profiles add column if not exists saved_paths jsonb
  check (saved_paths is null or (jsonb_typeof(saved_paths) = 'object' and pg_column_size(saved_paths) <= 12000));

create or replace function public.path_community(p_path text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  since timestamptz := now() - interval '90 days';
  out jsonb;
begin
  if coalesce(p_path, '') !~ '^[a-z_]{2,40}$' then return null; end if;
  with members as (
    select id from public.profiles where path = p_path and account_status = 'active'
  ), threads as (
    select t.id, t.title, t.reply_count, t.accepted_reply_id, t.created_at
      from public.forum_threads t join members m on m.id = t.user_id
     where t.created_at >= since
  ), sessions as (
    select starts_at from public.coworking_sessions
     where cancelled_at is null and starts_at + make_interval(mins => minutes) > now()
       and (path is null or path = p_path)
  )
  select jsonb_build_object(
    'members', (select count(*) from members),
    'questions', (select count(*) from threads),
    'replied', (select count(*) from threads where reply_count > 0),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', left(title, 140), 'replies', coalesce(reply_count, 0),
                                                            'answered', accepted_reply_id is not null, 'created_at', created_at) order by created_at desc)
                          from (select * from threads order by created_at desc limit 3) r), '[]'::jsonb),
    'sessions', (select count(*) from sessions),
    'next_session_at', (select min(starts_at) from sessions)
  ) into out;
  return out;
end $function$;
revoke all on function public.path_community(text) from public;
grant execute on function public.path_community(text) to anon, authenticated;

commit;

select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'saved_paths') = 1
   and has_function_privilege('anon', 'public.path_community(text)', 'execute')
   and (public.path_community('freelancer') ? 'members')
   and public.path_community('not a path') is null as ok;
