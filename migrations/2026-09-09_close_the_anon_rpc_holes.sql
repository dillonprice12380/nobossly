-- The ladder and the credit rail were both forgeable with the public anon key.
--
-- Three SECURITY DEFINER functions were EXECUTE-able by the `anon` role — the
-- key that ships in every browser — and each takes a target user id and an
-- amount as parameters:
--
--   award_xp(user_id, amount, ...)              insert arbitrary XP for anyone.
--                                               XP drives current_level, so the
--                                               whole ten-rung ladder is forgeable.
--
--   check_and_award_milestone(user_id, slug)    writes user_milestones, which is
--                                               exactly what achievedQuests()
--                                               reads to satisfy a rung gate.
--                                               Clears any gate for any account.
--
--   deduct_ai_credits(user_id, amount, ...)     p_amount is unconstrained, so
--                                               amount = -1000 runs
--                                               `balance - (-1000)`. It MINTS
--                                               credits, straight past the rail
--                                               added in 2026-09-09_ai_credit_rail.
--
-- All three are leftovers from an earlier architecture. The app calls none of
-- them: XP now runs through src/xp.js and credits through spend_ai_credits().
--
-- They are REVOKED rather than dropped. The `award-xp-and-notify` edge function
-- still calls the first two, with the service role key — that function is
-- itself unreferenced by the app, but revoking is reversible and dropping is
-- not, and revoking closes the hole just as completely: service_role is
-- unaffected by grants, so nothing that legitimately works stops working.
--
-- Also here: four SECURITY DEFINER views readable by anon. A definer view
-- bypasses RLS, and user_dashboard_stats exposes every member's XP, level,
-- streak, subscription_tier and ai_credits balance. Nothing in the app or the
-- database reads any of the four (checked pg_depend, pg_policy and the source).

-- --------------------------------------------------------------------------
-- 1. The three forgeable functions.

revoke execute on function public.award_xp(uuid, integer, text, text, uuid) from anon, authenticated;
revoke execute on function public.check_and_award_milestone(uuid, text) from anon, authenticated;
revoke execute on function public.deduct_ai_credits(uuid, integer, text) from anon, authenticated;

comment on function public.award_xp(uuid, integer, text, text, uuid) is
  'SUPERSEDED by awardXP() in src/xp.js. Kept only because the award-xp-and-notify edge function still calls it with the service role key. EXECUTE is revoked from anon and authenticated: it takes a target user id and an amount, so any caller could grant any account unlimited XP, and XP drives current_level.';

comment on function public.check_and_award_milestone(uuid, text) is
  'SUPERSEDED by src/milestones_engine.js. EXECUTE revoked from anon and authenticated: it writes user_milestones, which is what the ladder reads to decide whether a rung gate is cleared, so exposure meant any account could clear any gate.';

comment on function public.deduct_ai_credits(uuid, integer, text) is
  'SUPERSEDED by spend_ai_credits(). EXECUTE revoked from anon and authenticated: p_amount is unconstrained, so a negative amount added credits rather than removing them, bypassing the rail entirely.';

-- --------------------------------------------------------------------------
-- 2. Deleting accounts should not be an anonymous operation.
--
-- Lower severity than the above — it only removes accounts already flagged for
-- deletion more than seven days ago, so the worst case is accelerating a
-- deletion the member asked for. It still has no business being public.

revoke execute on function public.purge_deleted_accounts() from anon, authenticated;

-- --------------------------------------------------------------------------
-- 3. Anonymous callers should not be able to write into anyone's notifications.
--
-- The app calls both of these as an authenticated member, so `authenticated`
-- keeps its grant. (That a signed-in member can still push a notification to
-- another member is a real, separate issue — these take a target/actor id
-- rather than using auth.uid() — but closing it means changing the functions,
-- which is a behaviour change rather than a grant change.)

revoke execute on function public.push_notification(uuid, text, text, text, uuid) from anon;
revoke execute on function public.notify_social(uuid, text, text, uuid) from anon;

-- --------------------------------------------------------------------------
-- 4. The four unused SECURITY DEFINER views.

revoke select on public.user_dashboard_stats from anon, authenticated;
revoke select on public.public_profiles     from anon, authenticated;
revoke select on public.community_feed      from anon, authenticated;
revoke select on public.xp_leaderboard      from anon, authenticated;

comment on view public.user_dashboard_stats is
  'UNUSED and unreadable by anon/authenticated as of 2026-09-09. A SECURITY DEFINER view bypasses RLS, and this one selected every member''s xp_total, current_level, streak_days, subscription_tier and ai_credits balance. Nothing in the app or the database referenced it. Safe to drop once you are sure.';

comment on view public.public_profiles is 'UNUSED. SELECT revoked from anon/authenticated 2026-09-09 — a SECURITY DEFINER view bypasses RLS and nothing referenced this one.';
comment on view public.community_feed  is 'UNUSED. SELECT revoked from anon/authenticated 2026-09-09 — superseded by activity_events and the /feed route.';
comment on view public.xp_leaderboard  is 'UNUSED. SELECT revoked from anon/authenticated 2026-09-09.';

-- --------------------------------------------------------------------------
-- 5. A correction to the credit rail's own migration.
--
-- 2026-09-09_ai_credit_rail.sql did `revoke all ... from public` and described
-- that as closing the door. It did not: Supabase grants EXECUTE to anon and
-- authenticated EXPLICITLY on functions in the exposed schema, and revoking
-- PUBLIC leaves those in place. The advisor still listed all three as
-- anon-executable.
--
-- Not exploitable — every one returns {ok:false, reason:'auth'} when auth.uid()
-- is null — but the grant has to name anon to actually be gone.

revoke execute on function public.spend_ai_credits(text, boolean) from anon;
revoke execute on function public.refund_ai_credits(text) from anon;
revoke execute on function public.ai_credit_status() from anon;

-- --------------------------------------------------------------------------
-- 6. Applied as a second step: revoking from anon and authenticated was NOT
--    enough, and the verification query caught it.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and PUBLIC is
-- a separate grant path from the role-specific grants Supabase adds.
-- has_function_privilege('anon', …) stayed true after the revokes above,
-- because the PUBLIC grant was still standing. Both have to go.
--
-- That is the exact mirror of the bug in 2026-09-09_ai_credit_rail.sql, which
-- revoked only PUBLIC and left the anon grant — two halves of the same
-- misunderstanding, found from opposite ends.
--
-- service_role is not subject to grants, so the award-xp-and-notify edge
-- function (the only remaining caller of the first two) keeps working.

revoke execute on function public.award_xp(uuid, integer, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.check_and_award_milestone(uuid, text) from public, anon, authenticated;
revoke execute on function public.deduct_ai_credits(uuid, integer, text) from public, anon, authenticated;
revoke execute on function public.purge_deleted_accounts() from public, anon, authenticated;

-- The app calls these two as an authenticated member, so the grant is
-- re-issued to `authenticated` after clearing PUBLIC.
revoke execute on function public.push_notification(uuid, text, text, text, uuid) from public, anon, authenticated;
grant  execute on function public.push_notification(uuid, text, text, text, uuid) to authenticated;
revoke execute on function public.notify_social(uuid, text, text, uuid) from public, anon, authenticated;
grant  execute on function public.notify_social(uuid, text, text, uuid) to authenticated;

revoke execute on function public.spend_ai_credits(text, boolean) from public, anon;
revoke execute on function public.refund_ai_credits(text) from public, anon;
revoke execute on function public.ai_credit_status() from public, anon;
grant  execute on function public.spend_ai_credits(text, boolean) to authenticated;
grant  execute on function public.refund_ai_credits(text) to authenticated;
grant  execute on function public.ai_credit_status() to authenticated;

-- Verified after applying:
--   award_xp, check_and_award_milestone, deduct_ai_credits,
--   purge_deleted_accounts   → anon false, authenticated false, service true
--   push_notification, notify_social, spend/refund/status
--                            → anon false, authenticated true, service true
--   the four views           → anon false, authenticated false, service true
--
-- Advisor before → after: security_definer_view 4 (ERROR) → 0;
-- anon-executable definer functions 37 → 28; authenticated 38 → 34.
-- What remains is almost entirely trigger functions, which PostgREST cannot
-- usefully invoke, plus the two secret-guarded Stripe functions (see below).
