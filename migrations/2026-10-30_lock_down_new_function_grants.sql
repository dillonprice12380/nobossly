-- Applied 2026-10-30, after the two 2026-10-23 migrations.
-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- and authenticated directly, so "revoke ... from public" alone left these
-- callable by signed-out visitors. They already refused anyone without a
-- session, so nothing was exposed; this makes the grants say so too.
-- ensure_weekly_cohorts() is only ever run by pg_cron.
revoke execute on function public.ensure_weekly_cohorts() from anon, authenticated;
revoke execute on function public.cohort_waitlist_join(uuid) from anon;
revoke execute on function public.cohort_waitlist_leave(uuid) from anon;
revoke execute on function public.notify_admins_review(uuid) from anon;
revoke execute on function public.confirm_trophy_claim(uuid, boolean) from anon;
revoke execute on function public.trophy_claim_mark_awarded(uuid) from anon;
