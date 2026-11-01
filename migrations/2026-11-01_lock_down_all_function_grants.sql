-- NOT APPLIED, written for review.
--
-- The Supabase security advisor reported 36 SECURITY DEFINER functions in
-- `public` callable by `anon` and 55 by `authenticated`. Supabase's default
-- privileges grant EXECUTE to both on every new function, so most of these
-- were never meant to be callable by anyone.
--
-- Rules applied here:
--   * Trigger and event-trigger functions: revoked from both. A trigger fires
--     whatever the writer's privileges; EXECUTE only matters for calling the
--     function directly through /rest/v1/rpc, which nothing should do.
--   * Called by the server with the service key (billing, task reminders):
--     revoked from both. src/routes/billing.js and server.js now use
--     serviceClient() for these (the anon fallback is gone).
--   * Retired AI-credit functions: revoked from both.
--   * Called by Express with the member's own session: kept for
--     `authenticated`, revoked from `anon`.
--   * Must stay anonymous: affiliate_go (outbound affiliate clicks),
--     increment_blog_views, log_app_error (errors on public pages), proof_page
--     (public Proof Pages), and is_admin — is_admin() is used inside the row
--     policies of tables visitors read (forum, profiles, posts, cms_contents),
--     and a policy calls its functions as the reader. It returns false for
--     anyone not signed in.
--
-- Differences from the restructure brief, all because Express calls these with
-- the member's session and revoking them would break a page:
--   premium_save (every tool save), admin_save_affiliate and
--   admin_affiliate_clicks (the admin affiliates page — both check is_admin()
--   inside), record_win_activity (the wins page). Kept for `authenticated`.
--
-- is_admin_user() and my_collab_project_ids() are used only in policies on
-- tables that signed-in members read, so `anon` loses them safely.

-- ---------------------------------------------------------------------------
-- Trigger and event-trigger functions: nobody calls these directly.
revoke execute on function public.auto_promote_admin()                from public, anon, authenticated;
revoke execute on function public.bootstrap_new_user()                from public, anon, authenticated;
revoke execute on function public.friendships_guard()                 from public, anon, authenticated;
revoke execute on function public.give_starter_credits()              from public, anon, authenticated;
revoke execute on function public.handle_new_user()                   from public, anon, authenticated;
revoke execute on function public.peer_reviews_bind_submitter()       from public, anon, authenticated;
revoke execute on function public.peer_reviews_sync_request_status()  from public, anon, authenticated;
revoke execute on function public.protect_profile_fields()            from public, anon, authenticated;
revoke execute on function public.rls_auto_enable()                   from public, anon, authenticated;
revoke execute on function public.sync_beta_tester_count()            from public, anon, authenticated;
revoke execute on function public.sync_guide_votes()                  from public, anon, authenticated;
revoke execute on function public.sync_post_comment_count()           from public, anon, authenticated;
revoke execute on function public.sync_post_likes()                   from public, anon, authenticated;
revoke execute on function public.sync_post_repost_count()            from public, anon, authenticated;
revoke execute on function public.sync_survey_response_count()        from public, anon, authenticated;
revoke execute on function public.sync_user_xp()                      from public, anon, authenticated;
revoke execute on function public.update_conversation_last_message()  from public, anon, authenticated;
revoke execute on function public.update_sprint_task_counts()         from public, anon, authenticated;
revoke execute on function public.update_streak_on_checkin()          from public, anon, authenticated;
revoke execute on function public.verification_requests_guard()       from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Server-only (service key) and retired functions.
revoke execute on function public.apply_subscription(text, uuid, text, text, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke execute on function public.find_user_by_stripe_sub(text, text) from public, anon, authenticated;
revoke execute on function public.process_task_reminders()            from public, anon, authenticated;
revoke execute on function public.spend_ai_credits(text, boolean)     from public, anon, authenticated;
revoke execute on function public.refund_ai_credits(text)             from public, anon, authenticated;
revoke execute on function public.ai_credit_status()                  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Member RPCs: signed-in members only.
revoke execute on function public.admin_affiliate_clicks()            from public, anon;
revoke execute on function public.admin_save_affiliate(text, text, text, text, boolean) from public, anon;
revoke execute on function public.has_premium(uuid)                   from public, anon;
revoke execute on function public.is_admin_user()                     from public, anon;
revoke execute on function public.level_reached(uuid)                 from public, anon;
revoke execute on function public.my_collab_project_ids()             from public, anon;
revoke execute on function public.premium_save(text, jsonb)           from public, anon;
revoke execute on function public.record_win_activity(uuid)           from public, anon;

grant execute on function public.admin_affiliate_clicks()             to authenticated;
grant execute on function public.admin_save_affiliate(text, text, text, text, boolean) to authenticated;
grant execute on function public.has_premium(uuid)                    to authenticated;
grant execute on function public.is_admin_user()                      to authenticated;
grant execute on function public.level_reached(uuid)                  to authenticated;
grant execute on function public.my_collab_project_ids()              to authenticated;
grant execute on function public.premium_save(text, jsonb)            to authenticated;
grant execute on function public.record_win_activity(uuid)            to authenticated;

-- Already authenticated-only and called by Express; restated so this file is
-- the one place that says who may call what.
grant execute on function public.push_notification(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.notify_social(uuid, text, text, uuid) to authenticated;
grant execute on function public.unread_message_count(uuid)            to authenticated;
grant execute on function public.award_xp_for(text, text, uuid, text, uuid) to authenticated;
grant execute on function public.bump_streak_for()                     to authenticated;
grant execute on function public.claim_trophy_for(uuid, text)          to authenticated;
grant execute on function public.complete_quest_for(uuid, text)        to authenticated;
grant execute on function public.complete_review_quest_for(text)       to authenticated;
grant execute on function public.confirm_trophy_claim(uuid, boolean)   to authenticated;
grant execute on function public.cohort_leaderboard(uuid)              to authenticated;
grant execute on function public.cohort_waitlist_join(uuid)            to authenticated;
grant execute on function public.cohort_waitlist_leave(uuid)           to authenticated;
grant execute on function public.sweep_trophies_for()                  to authenticated;
grant execute on function public.trophy_claim_mark_awarded(uuid)       to authenticated;
grant execute on function public.notify_admins_review(uuid)            to authenticated;
grant execute on function public.is_paid_member(uuid)                  to authenticated;

-- ---------------------------------------------------------------------------
-- Deliberately left callable by `anon` (see the header): affiliate_go,
-- increment_blog_views, log_app_error, proof_page, is_admin.
