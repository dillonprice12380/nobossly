-- email_log's email_type CHECK predates the re-engagement nudges and the
-- task-reminders edge function. Every 'resume_questionnaire', 'comeback' and
-- 'task_reminder' row was rejected (HTTP 400), so the once-per-member guard,
-- which reads email_log, never saw a previous send: each sweep re-sent.
-- Applied live 2026-10-31.

alter table public.email_log drop constraint email_log_email_type_check;
alter table public.email_log add constraint email_log_email_type_check check (email_type = any (array[
  'welcome','weekly_brief','subscription_confirmed','milestone_achieved','streak_reminder',
  'badge_earned','notification_digest','custom',
  'resume_questionnaire','comeback','task_reminder'
]));
