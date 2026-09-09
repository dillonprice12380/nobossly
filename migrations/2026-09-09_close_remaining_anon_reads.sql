-- Applied 2026-09-09. See the migration of the same name in the Supabase
-- migration history for the executed statements; this file is the record.
--
-- The rest of the anon-callable SECURITY DEFINER surface that reads or writes
-- something it should not. get_user_mrr(user_id) is the notable one: it
-- returned a named member's monthly revenue to anyone holding the public anon
-- key. get_user_karma is the same shape with less sensitive data.
-- get_or_create_conversation(a, b) let an anonymous caller open a DM thread
-- between two arbitrary members. The app calls none of the three.
--
-- Both grant paths again — PUBLIC by Postgres default and anon by Supabase —
-- since revoking either alone leaves the other.

revoke execute on function public.get_user_mrr(uuid) from public, anon, authenticated;
revoke execute on function public.get_user_karma(uuid) from public, anon, authenticated;
revoke execute on function public.get_or_create_conversation(uuid, uuid) from public, anon, authenticated;

-- These the app does call, so anon loses the grant and authenticated keeps it.
-- increment_blog_views stays readable by anon deliberately: it is called on
-- public blog pages by visitors who are not signed in.
revoke execute on function public.unread_message_count(uuid) from public, anon;
grant  execute on function public.unread_message_count(uuid) to authenticated;
revoke execute on function public.cohort_leaderboard(uuid) from public, anon;
grant  execute on function public.cohort_leaderboard(uuid) to authenticated;

revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_admin_user() from public, anon;
