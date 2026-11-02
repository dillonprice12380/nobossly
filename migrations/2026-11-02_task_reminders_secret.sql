-- Applied live 2026-11-02 (run through the Supabase MCP; verified: the
-- function answers 401 without the secret or with a wrong one, 200 with it).
--
-- The task-reminders edge function has verify_jwt off because pg_cron has no
-- user token, so anyone who knew its address could trigger it. It now
-- requires a shared secret, sent by the cron job as the x-cron-secret header
-- and kept in public.app_secrets, which only the service role and SECURITY
-- DEFINER functions can read. The function's code is in
-- supabase/functions/task-reminders/index.ts (deployed as version 5).
--
-- The secret is generated in the database and never appears in the repo.

insert into public.app_secrets (key, value)
values ('cron_task_reminders', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- RLS already hid every row (no policies); remove the table privileges too.
revoke all on public.app_secrets from anon, authenticated;

select cron.alter_job((select jobid from cron.job where jobname = 'daily-task-reminders'), command := $cmd$ select net.http_post(
       url := 'https://wzuptydjilpqafhwtbwq.supabase.co/functions/v1/task-reminders',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'x-cron-secret', (select value from public.app_secrets where key = 'cron_task_reminders')),
       body := '{}'::jsonb
     ); $cmd$);
