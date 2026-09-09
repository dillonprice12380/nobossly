-- The last two tables the player could write for themselves.
--
-- The score moved to the server in 2026-09-09_the_score_is_server_owned.sql,
-- and level_reached() decides a rung by reading challenge_completions and
-- user_milestones. Which made those two tables the new soft spot: both had an
-- INSERT policy of `auth.uid() = user_id`, so a member could write the row that
-- says they finished a quest without finishing it, and level_reached() would
-- believe them. It is a more visible lie than a silent number — a forged
-- completion shows on their profile — but it is the same lie.
--
-- user_milestones was worse than an insert. It also carried UPDATE and DELETE
-- policies that nothing in the app has ever used, and one of its columns,
-- custom_title, is matched directly against a gate title by level_reached().
-- So a member could take a trophy they legitimately hold and retitle it into
-- whichever gate they were short of.
--
-- Same rule as the score: the client asks, the server decides. Four functions,
-- each of which re-derives the condition rather than trusting that a route
-- checked it.
--
-- ---------------------------------------------------------------------------
-- 1. Finishing a quest you actually took on.

create or replace function public.complete_quest_for(p_challenge_id uuid, p_proof text default '')
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  a challenge_acceptances; c challenges;
  v_proof text := btrim(coalesce(p_proof, ''));
  v_flagged boolean; v_new boolean := false;
begin
  if v_user is null then raise exception 'not signed in'; end if;

  select * into a from challenge_acceptances
   where challenge_id = p_challenge_id and user_id = v_user;
  if not found or a.status is distinct from 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not_active');
  end if;
  select * into c from challenges where id = p_challenge_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_challenge'); end if;

  -- The same bar the route used to check, now where it cannot be skipped.
  if coalesce(c.requires_proof, false) and length(v_proof) < 25 then
    return jsonb_build_object('ok', false, 'reason', 'needs_proof', 'title', c.title);
  end if;

  -- Suspiciously fast big-quest completions are flagged for review, not
  -- blocked — a real 30-day push finished in a day is worth a human look.
  v_flagged := coalesce(c.requires_proof, false)
               and coalesce(c.xp_reward, 0) >= 150
               and a.accepted_at is not null
               and a.accepted_at > now() - interval '1 day';

  update challenge_acceptances set status = 'completed', completed_at = now() where id = a.id;

  if not exists (select 1 from challenge_completions
                  where user_id = v_user and challenge_id = p_challenge_id) then
    insert into challenge_completions (user_id, challenge_id, proof_note, flagged)
    values (v_user, p_challenge_id, v_proof, v_flagged);
    v_new := true;
  end if;

  return jsonb_build_object('ok', true, 'was_new', v_new, 'flagged', v_flagged,
                            'title', c.title, 'emoji', c.emoji, 'badge_id', c.badge_id,
                            'requires_proof', coalesce(c.requires_proof, false));
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The two quests peer review completes on your behalf.
--
-- These are not "complete any quest by name" — that would hand back the hole
-- with a nicer signature. Each branch names one quest and re-counts the rows
-- that earn it: a review you wrote, or three reviews other people wrote about
-- your work. SESSIONS_NEEDED lives in src/routes/reviews.js as 3 and here as 3;
-- test/completions-integrity.js holds them together.

create or replace function public.complete_review_quest_for(p_which text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_title text; v_note text; v_ok boolean := false; v_n integer; c challenges;
begin
  if v_user is null then raise exception 'not signed in'; end if;

  if p_which = 'giver' then
    v_title := 'Give a Peer Review';
    select count(*) into v_n from peer_reviews
     where reviewer_id = v_user and status = 'completed';
    v_ok := v_n >= 1;
    v_note := 'Reviewed a peer''s work on NoBossly.';
  elsif p_which = 'gate' then
    v_title := 'Get 3 Feedback Sessions';
    select count(*) into v_n from peer_reviews
     where submitter_id = v_user and status = 'completed' and request_id is not null;
    v_ok := v_n >= 3;
    v_note := v_n || ' peer reviews received on NoBossly.';
  else
    raise exception 'unknown review quest %', p_which;
  end if;

  if not v_ok then return jsonb_build_object('ok', false, 'reason', 'not_yet', 'have', v_n); end if;

  select * into c from challenges where title = v_title;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_challenge'); end if;
  if exists (select 1 from challenge_completions where user_id = v_user and challenge_id = c.id) then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;

  insert into challenge_completions (user_id, challenge_id, proof_note)
  values (v_user, c.id, v_note);
  update challenge_acceptances set status = 'completed', completed_at = now()
   where user_id = v_user and challenge_id = c.id and status = 'active';

  return jsonb_build_object('ok', true, 'challenge_id', c.id, 'title', c.title, 'have', v_n);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2b. Whether somebody is on a paid plan.
--
-- Both functions below need it, only to decide whether a trophy is pinned to
-- the member's public profile — cosmetic, but it used to be passed in by the
-- route from the member's own client, and a value the client supplies is a
-- value the client chooses. This mirrors planOf() in src/middleware/auth.js
-- exactly, including the two cases that are easy to miss: a cancelled
-- subscription is paid until the period it was paid for actually ends, and an
-- active one with no end date is paid.
-- test/completions-integrity.js holds the two in step.

create or replace function public.is_paid_member(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select coalesce((
    select case
      when p.is_admin or p.is_lifetime then true
      when p.subscription_status in ('active', 'canceled', 'trialing')
           and p.subscription_period_end is not null
           and p.subscription_period_end > now() then true
      when p.subscription_status = 'active' and p.subscription_period_end is null then true
      else false
    end
    from profiles p where p.id = p_user), false);
$function$;

-- ---------------------------------------------------------------------------
-- 3. Logging a real-world trophy.
--
-- Self-attested by design — nothing in the app can see that somebody
-- registered a business — but the written account is the standard, and it was
-- enforced in JS next to an insert the member could make without it. `pinned`
-- was passed in by the route from the member's own plan; the server reads the
-- plan itself now.

create or replace function public.claim_trophy_for(p_milestone_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  d predefined_milestones; v_note text := left(btrim(coalesce(p_note, '')), 2000); v_paid boolean;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select * into d from predefined_milestones
   where id = p_milestone_id and is_active and is_claimable;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_claimable'); end if;
  if length(v_note) < 30 then
    return jsonb_build_object('ok', false, 'reason', 'needs_note', 'title', d.title);
  end if;
  if exists (select 1 from user_milestones
              where user_id = v_user and predefined_milestone_id = d.id) then
    return jsonb_build_object('ok', false, 'reason', 'already', 'title', d.title);
  end if;

  v_paid := is_paid_member(v_user);

  insert into user_milestones (user_id, predefined_milestone_id, emoji, custom_description,
                               date_achieved, pinned)
  values (v_user, d.id, d.emoji, v_note, current_date, coalesce(v_paid, false));

  return jsonb_build_object('ok', true, 'title', d.title, 'emoji', d.emoji,
                            'xp_reward', d.xp_reward);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The sweep.
--
-- Every active definition carries auto_kind + auto_target, and the engine
-- computed the member's real numbers in JS and inserted whatever was newly
-- satisfied. The insert had to move here; the counting followed it, because
-- leaving computeMetrics() in JS would have meant two implementations of the
-- same fifteen numbers — the trophy case's progress bars disagreeing with what
-- it actually awards is exactly the drift this codebase keeps finding.
--
-- So this returns the metrics as well, and src/milestones_engine.js renders
-- those rather than counting anything itself. One implementation.
--
-- Each kind is counted the way the JS counted it, and the two that are not
-- plain counts keep their reasons: idea_fit_pct is the best percentage reached
-- on ANY idea (so revising into a worse score never takes a trophy back), and
-- signals are counted per idea (three pieces of evidence for ONE idea, not one
-- each on three).

create or replace function public.sweep_trophies_for()
returns jsonb language plpgsql security definer set search_path to 'public'
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
    'ideas',        (select count(*) from generated_ideas where user_id = v_user),
    -- Only completed runs count: a half-answered questionnaire has not produced
    -- the answers the Compass needs, and this trophy gates leaving Level 1.
    'questionnaire',(select count(*) from questionnaire_responses where user_id = v_user and completed),
    'blueprints',   (select count(*) from blueprints where user_id = v_user),
    'idea_fit_pct', (select coalesce(max(best_fit_pct), 0) from generated_ideas where user_id = v_user),
    'ideas_cut',    (select count(*) from generated_ideas where user_id = v_user and cut_at is not null),
    'signals',      (select coalesce(max(c), 0) from (
                       select count(*) c from idea_signals where user_id = v_user group by idea_id) s),
    'tasks',        (select count(*) from sprint_tasks where user_id = v_user and status = 'done'),
    'checkins',     (select count(*) from daily_checkins where user_id = v_user),
    'followers',    (select count(*) from follows where following_id = v_user),
    'challenges',   (select count(*) from challenge_completions where user_id = v_user),
    'posts',        (select (select count(*) from forum_threads where user_id = v_user)
                          + (select count(*) from forum_replies where user_id = v_user)),
    'sprints_started', (select count(*) from sprints where user_id = v_user),
    -- Nothing flips a sprint to 'completed' automatically yet, so a sprint with
    -- every task done counts as done — the honest reading either way.
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
      null;                                  -- raced with another request
    end;
  end loop;

  return jsonb_build_object('fresh', fresh, 'metrics', m);
end;
$function$;

revoke all on function public.is_paid_member(uuid) from public, anon;
revoke all on function public.complete_quest_for(uuid, text) from public, anon;
revoke all on function public.complete_review_quest_for(text) from public, anon;
revoke all on function public.claim_trophy_for(uuid, text) from public, anon;
revoke all on function public.sweep_trophies_for() from public, anon;
grant execute on function public.is_paid_member(uuid) to authenticated;
grant execute on function public.complete_quest_for(uuid, text) to authenticated;
grant execute on function public.complete_review_quest_for(text) to authenticated;
grant execute on function public.claim_trophy_for(uuid, text) to authenticated;
grant execute on function public.sweep_trophies_for() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The doors.
--
-- SELECT stays: a member reads their own completions and trophies, and the
-- functions above are SECURITY DEFINER so they write regardless. The UPDATE and
-- DELETE policies on user_milestones go with the insert — nothing in the app
-- has ever used them, and UPDATE is what let custom_title be retitled into a
-- gate.

drop policy if exists completions_insert on challenge_completions;
drop policy if exists user_milestones_insert on user_milestones;
drop policy if exists user_milestones_update on user_milestones;
drop policy if exists user_milestones_delete on user_milestones;
