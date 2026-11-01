-- NOT APPLIED, written for review.
-- PREREQUISITE: a full database backup taken AFTER the Phase 0 code is live
-- (Supabase dashboard → Database → Backups, or pg_dump). Dropped tables do not
-- come back without one.
--
-- Removes what is left of the AI era: the Compass, generated ideas,
-- blueprints, the questionnaire, the fit-test library, AI credits and AI
-- memory. Nothing in src/ reads these tables any more (the last reads, in
-- src/guidance.js, admin.js, members.js and budget.js, were removed in the
-- same PR as this file). Row counts on 2026-11-01: founder_compasses 1,
-- ai_credits 15, ai_credit_plans 2, ai_credit_costs 13, ai_memory 13,
-- generation_jobs 2, questionnaire_responses 2, fit_criteria_library 46,
-- business_taxonomy 144, founder_levels 10, guide_h2_backup 13; the rest 0.
--
-- No CASCADE anywhere: if something still depends on one of these, the drop
-- fails and says what, rather than taking it along silently.

begin;

-- ---------------------------------------------------------------------------
-- 1. Two live functions still touch these tables. Rewrite them first.

-- Runs on every new profile. It also created an ai_memory row.
create or replace function public.bootstrap_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.user_subscriptions (user_id, tier, status)
  values (new.id, 'free', 'inactive')
  on conflict (user_id) do nothing;

  insert into public.streaks (user_id, current_streak, longest_streak)
  values (new.id, 0, 0)
  on conflict (user_id) do nothing;

  return new;
end;
$function$;
revoke all on function public.bootstrap_new_user() from public, anon, authenticated;

-- Auto-awarded trophies: the AI metrics (ideas, questionnaire, blueprints,
-- idea fit, cut ideas, signals) are 0 for everyone now. Same body otherwise.
create or replace function public.sweep_trophies_for()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  p profiles; m jsonb; d record; v_paid boolean; fresh jsonb := '[]'::jsonb; v_have numeric;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select * into p from profiles where id = v_user;
  if not found then raise exception 'no profile'; end if;
  v_paid := is_paid_member(v_user);

  m := jsonb_build_object(
    'ideas',        0,
    'questionnaire',0,
    'blueprints',   0,
    'idea_fit_pct', 0,
    'ideas_cut',    0,
    'signals',      0,
    'tasks',        (select count(*) from sprint_tasks where user_id = v_user and status = 'done'),
    'checkins',     (select count(*) from daily_checkins where user_id = v_user),
    'followers',    (select count(*) from follows where following_id = v_user),
    'challenges',   (select count(*) from challenge_completions where user_id = v_user),
    'posts',        (select (select count(*) from forum_threads where user_id = v_user)
                          + (select count(*) from forum_replies where user_id = v_user)),
    'sprints_started', (select count(*) from sprints where user_id = v_user),
    'sprints_done', (select count(*) from sprints where user_id = v_user
                       and (status = 'completed'
                            or (coalesce(tasks_total, 0) > 0 and coalesce(tasks_done, 0) >= tasks_total))),
    'streak',       greatest(coalesce(p.streak_days, 0), coalesce(p.longest_streak, 0)),
    'profile',      case when coalesce(p.display_name, '') <> '' and coalesce(p.bio, '') <> '' then 1 else 0 end
  );

  for d in select * from predefined_milestones
            where is_active and auto_kind is not null
              and not exists (select 1 from user_milestones um
                               where um.user_id = v_user and um.predefined_milestone_id = predefined_milestones.id)
  loop
    v_have := coalesce((m ->> d.auto_kind)::numeric, 0);
    continue when v_have < coalesce(d.auto_target, 1);
    begin
      insert into user_milestones (user_id, predefined_milestone_id, emoji, date_achieved, pinned)
      values (v_user, d.id, d.emoji, current_date, v_paid);
      fresh := fresh || to_jsonb(d.id);
    exception when unique_violation then
      null;
    end;
  end loop;

  return jsonb_build_object('fresh', fresh, 'metrics', m);
end;
$function$;
revoke all on function public.sweep_trophies_for() from public, anon;
grant execute on function public.sweep_trophies_for() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Views from before the relaunch, built on these tables. Nothing in the app
--    reads them.
drop view if exists public.community_feed;
drop view if exists public.public_profiles;
drop view if exists public.user_dashboard_stats;
drop view if exists public.xp_leaderboard;

-- ---------------------------------------------------------------------------
-- 3. AI-credit functions and the trigger that handed out starter credits.
drop trigger if exists on_profile_created_give_credits on public.profiles;
drop function if exists public.give_starter_credits();
drop function if exists public.spend_ai_credits(text, boolean);
drop function if exists public.refund_ai_credits(text);
drop function if exists public.ai_credit_status();
drop function if exists public.deduct_ai_credits(uuid, integer, text);

-- ---------------------------------------------------------------------------
-- 4. Columns elsewhere that pointed at generated ideas or blueprints. All
--    null or unused; no code reads them.
alter table public.sprints          drop column if exists idea_id;
alter table public.sprints          drop column if exists blueprint_id;
alter table public.collab_requests  drop column if exists idea_id;
alter table public.beta_programs    drop column if exists idea_id;
alter table public.surveys          drop column if exists idea_id;
alter table public.revenue_entries  drop column if exists idea_id;

-- ---------------------------------------------------------------------------
-- 5. The tables. One statement, so foreign keys between them don't matter.
drop table if exists
  public.idea_signals,
  public.idea_versions,
  public.blueprints,
  public.founder_compasses,
  public.generated_ideas,
  public.ai_credits,
  public.ai_credit_plans,
  public.ai_credit_costs,
  public.ai_spend,
  public.ai_memory,
  public.ai_conversations,
  public.ai_reading_lists,
  public.generation_jobs,
  public.questionnaire_responses,
  public.fit_criteria_library,
  public.business_taxonomy,
  public.founder_levels,
  public.guide_h2_backup;

commit;
