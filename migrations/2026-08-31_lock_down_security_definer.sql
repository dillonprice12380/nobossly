-- Security advisor cleanup for the NoBossly project.
--
-- NOT YET APPLIED. Every statement below touches production behaviour, and two
-- of them will break live features if they run in the wrong order. Read the
-- prerequisites on each section before you run it. Apply one section at a time
-- and check the app in between.
--
-- Source: Supabase advisors, 31 Aug 2026 —
--   4  ERROR  security_definer_view
--   65 WARN   {anon,authenticated}_security_definer_function_executable
--   6  WARN   function_search_path_mutable
--   1  WARN   extension_in_public (pg_net)
--   1  WARN   auth_leaked_password_protection


-- ===========================================================================
-- 1. apply_subscription — the one that actually matters
-- ===========================================================================
-- This function grants paid access. It is EXECUTE-able by `anon`, so anybody
-- holding the publishable key (it ships in .env.example, it is public by
-- design) can call it over /rest/v1/rpc/apply_subscription. The only thing
-- standing in the way is the p_secret value.
--
-- PREREQUISITE: SUPABASE_SERVICE_ROLE_KEY must be set in the production
-- environment. src/routes/billing.js now prefers the service-role client for
-- this call and falls back to anon when the key is missing — so if you revoke
-- before setting the key, checkout will start failing.
--
-- Verify first:
--   1. Set SUPABASE_SERVICE_ROLE_KEY and redeploy.
--   2. Confirm the log line "SUPABASE_SERVICE_ROLE_KEY unset" does NOT appear.
--   3. Run one test-mode checkout end to end.
-- Then run:

REVOKE EXECUTE ON FUNCTION public.apply_subscription(
  text, uuid, text, text, text, text, timestamptz, boolean
) FROM anon, authenticated;

-- Rollback if checkout breaks:
--   GRANT EXECUTE ON FUNCTION public.apply_subscription(
--     text, uuid, text, text, text, text, timestamptz, boolean
--   ) TO anon, authenticated;


-- ===========================================================================
-- 2. Pin search_path on SECURITY DEFINER functions
-- ===========================================================================
-- A mutable search_path on a SECURITY DEFINER function lets a caller shadow the
-- objects it references. Pinning it is safe and reversible, and changes no
-- behaviour as long as every reference in the body is schema-qualified or lives
-- in public/pg_catalog. Run these one at a time and smoke-test each feature.

ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_catalog;

-- Repeat for the remaining five flagged functions. List them with:
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid)
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
--                     WHERE c LIKE 'search_path=%');


-- ===========================================================================
-- 3. SECURITY DEFINER views  (TEST ON A BRANCH FIRST)
-- ===========================================================================
-- public_profiles, community_feed, user_dashboard_stats and xp_leaderboard all
-- run as their owner, so they bypass the RLS on the tables beneath them. Turning
-- on security_invoker makes each caller's own RLS apply instead.
--
-- THIS CAN EMPTY THE VIEWS. If the underlying tables' policies don't grant the
-- reads these views depend on (a leaderboard reading every user's xp_total is
-- exactly the case that breaks), the view returns nothing and the member
-- directory, community feed and leaderboard all go blank.
--
-- Do this on a Supabase branch, confirm each surface still renders, and add the
-- explicit read policies the views need before promoting.

-- ALTER VIEW public.public_profiles      SET (security_invoker = on);
-- ALTER VIEW public.community_feed       SET (security_invoker = on);
-- ALTER VIEW public.user_dashboard_stats SET (security_invoker = on);
-- ALTER VIEW public.xp_leaderboard       SET (security_invoker = on);


-- ===========================================================================
-- 4. Remaining anon-executable SECURITY DEFINER functions
-- ===========================================================================
-- Lower severity than apply_subscription, but each is callable by anyone with
-- the publishable key. Each needs its call site moved off the anon client
-- BEFORE the revoke, so they are listed rather than executed:
--
--   push_notification(uuid,text,text,text,uuid)  — write notifications to any
--       user. Called from routes on the user's own client; would need a
--       caller-identity check inside the function rather than a revoke.
--   notify_social(uuid,text,text,uuid)           — same shape, social fan-out.
--   unread_message_count(uuid)                   — leaks a per-user count for
--       any uuid. Should read auth.uid() instead of taking uid as an argument.
--   process_task_reminders()                     — triggers reminder sends.
--       Called from server.js on the anon client; move to the service-role
--       client first, then revoke from anon and authenticated.


-- ===========================================================================
-- 5. Dashboard settings — not SQL
-- ===========================================================================
-- Enable leaked-password protection (checks new passwords against
-- HaveIBeenPwned):  Dashboard → Authentication → Policies → Password protection.
-- The signup and reset flows both benefit; nothing in the app needs changing.
--
-- pg_net lives in the public schema. Moving it is disruptive and low value here
-- — note it, leave it, revisit if the extension is ever used directly.


-- ===========================================================================
-- Not a finding
-- ===========================================================================
-- The advisor's "RLS enabled, no policy" notice on public.app_secrets is the
-- correct configuration: no policy means no anon or authenticated access at
-- all, and only the service role can read it. Leave it exactly as it is.
