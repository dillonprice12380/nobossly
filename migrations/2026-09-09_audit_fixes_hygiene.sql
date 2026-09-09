-- The last of the security audit: the low-severity items.
--
-- ---------------------------------------------------------------------------
-- 11. Admin was granted by matching an email address.
--
-- auto_promote_admin() fires before a profile is inserted and sets is_admin
-- when the new row's auth.users email is dillonprice@nobossly.com. Everyone in
-- the table today is confirmed, so nothing is wrong right now, and the domain
-- is the owner's — but the check never asked whether the address had been
-- proven. If email confirmation were ever off, or turned off, signing up with
-- that address would be enough.
--
-- It asks now. The trade-off is that a fresh signup no longer gets admin at the
-- moment the profile is created — email/password signups are unconfirmed at
-- that instant — so if the owner's account is ever recreated, admin has to be
-- granted deliberately. That is the right way round for granting admin.
--
-- Stricter still would be pinning the promotion to one user id, so no future
-- signup could inherit it at all. That is worth doing if this address is ever
-- retired.

create or replace function public.auto_promote_admin()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if exists (
    select 1 from auth.users u
     where u.id = new.id
       and lower(u.email) = 'dillonprice@nobossly.com'
       and u.email_confirmed_at is not null
  ) then
    new.is_admin := true;
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- 12. process_task_reminders() can be run by anyone, signed in or not.
--
-- NOT CLOSED, and the attempt to close it broke production for fourteen
-- minutes. I revoked it, having called it dead: the daily reminder EMAIL is a
-- pg_cron job that calls the task-reminders edge function, which queries under
-- the service role and never touches this function. Both of those are true.
--
-- What I did not do was grep the Node app. server.js:217 runs its own
-- setInterval every ten minutes and calls this through the ANON client — the
-- in-app task_due notifications, which are a different feature from the daily
-- email. The logs are unambiguous: 200 at 21:07 UTC, then 401 every ten minutes
-- from 21:21, which is exactly when the revoke landed.
--
-- Restored. What a caller can actually do here is run the sweep earlier than
-- scheduled; it is idempotent through the reminded_* flags and only ever
-- notifies a task's own owner about their own task, which is why this was the
-- weakest item on the audit. Closing it properly means putting the sweep behind
-- the service role key or a shared secret in app_secrets — both need a
-- deployment env var set first, so it is the owner's call rather than a silent
-- trade of a working feature for a marginal gain.

grant execute on function public.process_task_reminders() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 15. pg_net's HTTP functions were executable by every role.
--
-- The advisor flags pg_net for living in the public schema. The schema is the
-- cosmetic half; the part that matters is that net.http_get, net.http_post and
-- net.http_delete were granted to anon and authenticated. PostgREST only
-- exposes the public schema, so there is no route to them from the API today —
-- but that is one exposed-schema setting away from being an SSRF primitive
-- reachable by anyone with a signed-out session.
--
-- NOT dropped and NOT moved, which was the first instinct: nothing in any
-- function body references net.http, but cron job 1 does —
--
--     select net.http_post(url := '…/functions/v1/task-reminders', …)
--
-- — so dropping pg_net would have silently ended the daily reminder emails, and
-- moving it to another schema would have broken that command's net.http_post.
-- The job runs as postgres, which is not subject to these grants.
--
-- AND NOT REVOKED EITHER, because it cannot be — from here. The statements
-- were written, run, and reported success while changing nothing:
--
--     net.http_post acl: {=X/supabase_admin, supabase_admin=X/supabase_admin}
--
-- The first entry is the grant to PUBLIC, and it was made by supabase_admin.
-- Only the grantor can revoke it, `postgres` may not `set role supabase_admin`
-- ("permission denied to set role"), and a revoke you lack the grant option for
-- is a no-op rather than an error. This is the second time in this codebase
-- that a grant migration has reported success and done nothing; the lesson both
-- times was to re-read has_function_privilege afterwards rather than trust the
-- statement.
--
-- What actually holds the line today is that PostgREST only serves the schemas
-- the project exposes — public and graphql_public — and `net` is not one of
-- them. There is no override on the authenticator role, so that is the project
-- setting. So: do not add `net` to Exposed Schemas (Settings -> API), and if
-- this needs to be properly closed, it is a question for Supabase support.
--
-- Left as a comment rather than as SQL, so that replaying this file does not
-- reproduce the false success.

-- ---------------------------------------------------------------------------
-- 14. Six functions had a mutable search_path.
--
-- All six are SECURITY INVOKER, so they run as whoever called them and a
-- shadowed table would gain that caller nothing they could not already reach.
-- It is still free to pin, and it means none of them can become a problem later
-- by being made SECURITY DEFINER. ALTER rather than CREATE OR REPLACE so the
-- bodies are untouched.

alter function public.set_updated_at() set search_path to 'public';
alter function public.guide_location_filter_ids(text) set search_path to 'public';
alter function public.count_guides(text, text, text) set search_path to 'public';
alter function public.guide_facets(text, text, text) set search_path to 'public';
alter function public.list_guides(text, text, text, integer, integer) set search_path to 'public';
alter function public.similar_location_guides(uuid, integer) set search_path to 'public';

-- ---------------------------------------------------------------------------
-- 13. Leaked-password protection is a dashboard setting, not SQL.
--
-- Supabase Auth can check new passwords against HaveIBeenPwned and refuse the
-- ones that appear in known breaches. It is off. There is no migration for it:
-- Authentication -> Policies -> "Prevent use of leaked passwords" in the
-- project dashboard. Left here so the audit and the schema tell the same story.
