-- The score belongs to the server now.
--
-- Every number the game is played for was writable by the player. awardXP()
-- runs under the member's own credentials, so everything it touches was
-- reachable from a hand-rolled request with their own token. Confirmed against
-- production, in a transaction that was rolled back, as an ordinary non-admin
-- member:
--
--     insert into xp_events (user_id, amount, reason)
--     values (me, 999999, 'I am very good at business');
--     -- xp_total: 999999
--
--     update profiles set xp_total = 500000, current_level = 10,
--                         tasks_completed = 4242 where id = me;
--     -- xp_total=500000 current_level=10 tasks_completed=4242
--
-- Two separate doors. xp_events had an INSERT policy of `auth.uid() = user_id`,
-- which checks who you are and never what you claim to have earned, and the
-- sync trigger dutifully added it up. And profiles' UPDATE policy had a USING
-- clause and no WITH CHECK at all, so owning the row meant owning every column
-- on it — the score, the level, the streak, the task count.
--
-- The rule from here: a member's client may assert INTENT. It may never assert
-- OUTCOME. "I completed this quest" is a request; how much that is worth, and
-- what rung it puts them on, is decided here.
--
-- ---------------------------------------------------------------------------
-- 1. The price list.
--
-- Amounts used to live as literals at 22 call sites in JS — `awardXP(..., 25,
-- 'Compass drawn', ...)` — which is fine until the call is something the member
-- can make themselves. Every award is a CODE now, and the code is what decides
-- the number.
--
-- A code either pays a fixed amount or reads xp_reward off the entity being
-- rewarded. The second kind still needs a ceiling: user_custom_challenges and
-- user_custom_milestones are the member's own rows, so their xp_reward is
-- exactly as trustworthy as anything else the client sends. max_amount is the
-- backstop, and it applies to fixed codes too so that a bad seed cannot mint.

create table if not exists xp_award_kinds (
  code          text primary key,
  amount        integer,          -- null: read it from the entity
  amount_from   text,             -- table to read xp_reward from
  max_amount    integer not null,
  description   text not null
);

alter table xp_award_kinds enable row level security;
drop policy if exists xp_award_kinds_read on xp_award_kinds;
create policy xp_award_kinds_read on xp_award_kinds for select using (true);

insert into xp_award_kinds (code, amount, amount_from, max_amount, description) values
  ('compass_drawn',           25,  null,                       25,  'Drew a Compass'),
  ('idea_drafted',            15,  null,                       15,  'Drafted their own idea'),
  ('blueprint_created',       50,  null,                       50,  'Created a launch blueprint'),
  ('blueprint_dispersed',     15,  null,                       15,  'Dispersed Week 1 actions to tasks'),
  ('quest_accepted',           5,  null,                        5,  'Accepted a quest'),
  ('quest_completed',       null,  'challenges',              200,  'Completed a curated quest'),
  ('custom_quest_completed',null,  'user_custom_challenges',  200,  'Completed a tailored or custom quest'),
  ('trophy',                null,  'predefined_milestones',   900,  'A trophy the sweep awarded'),
  ('milestone_claim',       null,  'predefined_milestones',   900,  'A real-world trophy they logged'),
  ('custom_goal',           null,  'user_custom_milestones',  200,  'An AI-tailored goal they ticked off'),
  ('peer_review_given',       60,  null,                       60,  'Gave a peer review'),
  ('win_featured',            25,  null,                       25,  'Their win was featured on the wall'),
  ('forum_thread',            10,  null,                       10,  'Started a forum thread'),
  ('forum_reply',              5,  null,                        5,  'Replied in the forum'),
  ('beta_joined',             15,  null,                       15,  'Joined a beta program'),
  ('sprint_started',          30,  null,                       30,  'Started a sprint'),
  ('sprint_task_done',        10,  null,                       10,  'Completed a sprint task'),
  ('task_done',               10,  null,                       10,  'Completed a task'),
  ('daily_checkin',           15,  null,                       15,  'Checked in for the day')
on conflict (code) do update set
  amount = excluded.amount, amount_from = excluded.amount_from,
  max_amount = excluded.max_amount, description = excluded.description;

-- ---------------------------------------------------------------------------
-- 2. The ladder, in the database.
--
-- current_level cannot be decided server-side unless the server knows the
-- ladder, and until now it lived only in src/ladders.js. Two copies of a
-- ten-rung, nine-path ladder is exactly the drift that has bitten this codebase
-- before, so this table is GENERATED from that file by
-- scripts/gen_ladder_sql.js and nothing else may write it. test/ladder-snapshot.js
-- re-runs the generator and diffs it against the seed below.
--
-- A gate is one string: "c:" or "m:" and the title, already lowercased and
-- trimmed the way ladders.gateKey() does it, so SQL and JS never have to agree
-- about whitespace.

-- Only the two things SQL has to decide with. Rung titles and emoji stay in
-- src/ladders.js, because nothing here renders a rung.
create table if not exists ladder_rungs (
  path         text    not null,
  level        integer not null,
  xp_required  integer not null default 0,
  min_gates    integer,            -- null: every gate is required
  gates        jsonb   not null default '[]'::jsonb,
  primary key (path, level)
);

alter table ladder_rungs enable row level security;
drop policy if exists ladder_rungs_read on ladder_rungs;
create policy ladder_rungs_read on ladder_rungs for select using (true);

-- >>> GENERATED BY scripts/gen_ladder_sql.js — DO NOT EDIT BY HAND >>>
--!ladder-seed-start
insert into ladder_rungs (path, level, xp_required, min_gates, gates) values
  ('creator', 1, 0, null, '[]'::jsonb),
  ('creator', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('creator', 3, 300, null, '["m:blueprint built","c:publish 12 pieces in 30 days","m:sprint 1 completed"]'::jsonb),
  ('creator', 4, 600, null, '["c:5 customer conversations","c:pitch 25 brands or collaborators"]'::jsonb),
  ('creator', 5, 1000, null, '["c:make your first sale","m:set up how you get paid"]'::jsonb),
  ('creator', 6, 1500, null, '["c:earn your first $100","m:separate your business money","c:collect 5 pieces of audience proof"]'::jsonb),
  ('creator', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('creator', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('creator', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('creator', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('freelancer', 1, 0, null, '[]'::jsonb),
  ('freelancer', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('freelancer', 3, 300, null, '["m:blueprint built","c:publish a portfolio that wins work","m:sprint 1 completed"]'::jsonb),
  ('freelancer', 4, 600, null, '["c:5 customer conversations","c:do 25 outreach touches"]'::jsonb),
  ('freelancer', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('freelancer', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('freelancer', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('freelancer', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('freelancer', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('freelancer', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('consultant', 1, 0, null, '[]'::jsonb),
  ('consultant', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('consultant', 3, 300, null, '["m:blueprint built","c:price one offer by the outcome","m:sprint 1 completed"]'::jsonb),
  ('consultant', 4, 600, null, '["c:5 customer conversations","c:do 25 outreach touches"]'::jsonb),
  ('consultant', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('consultant', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('consultant', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('consultant', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('consultant', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('consultant', 10, 6000, null, '["m:$1k mrr","c:document your playbook"]'::jsonb),
  ('local_service', 1, 0, null, '[]'::jsonb),
  ('local_service', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('local_service', 3, 300, null, '["m:blueprint built","c:get your google business profile live and verified","m:sprint 1 completed"]'::jsonb),
  ('local_service', 4, 600, null, '["c:5 customer conversations","c:quote 10 jobs in two weeks"]'::jsonb),
  ('local_service', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('local_service', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('local_service', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('local_service', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('local_service', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('local_service', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('brick_mortar', 1, 0, null, '[]'::jsonb),
  ('brick_mortar', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('brick_mortar', 3, 300, null, '["m:blueprint built","c:test the concept without the lease","m:sprint 1 completed"]'::jsonb),
  ('brick_mortar', 4, 600, null, '["c:5 customer conversations","c:count footfall at three sites"]'::jsonb),
  ('brick_mortar', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('brick_mortar', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('brick_mortar', 7, 2200, null, '["c:serve 100 paying customers","c:automate one process"]'::jsonb),
  ('brick_mortar', 8, 3000, null, '["c:cover a month''s rent from takings","m:built a pitch deck"]'::jsonb),
  ('brick_mortar', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('brick_mortar', 10, 6000, null, '["m:three months of covering rent and paying yourself","c:document your playbook"]'::jsonb),
  ('online_store', 1, 0, null, '[]'::jsonb),
  ('online_store', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('online_store', 3, 300, null, '["m:blueprint built","c:list your first product properly","m:sprint 1 completed"]'::jsonb),
  ('online_store', 4, 600, null, '["c:5 customer conversations","c:work out your true unit margin"]'::jsonb),
  ('online_store', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('online_store', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('online_store', 7, 2200, null, '["c:reach 50 paying customers","c:automate one process"]'::jsonb),
  ('online_store', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('online_store', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('online_store', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('physical_product', 1, 0, null, '[]'::jsonb),
  ('physical_product', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('physical_product', 3, 300, null, '["m:blueprint built","c:make one by hand and sell it","m:sprint 1 completed"]'::jsonb),
  ('physical_product', 4, 600, null, '["c:5 customer conversations","c:get three manufacturing quotes"]'::jsonb),
  ('physical_product', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('physical_product', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('physical_product', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('physical_product', 8, 3000, null, '["c:hit a $1k month","m:built a pitch deck"]'::jsonb),
  ('physical_product', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('physical_product', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('software', 1, 0, null, '[]'::jsonb),
  ('software', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('software', 3, 300, null, '["m:blueprint built","c:ship something usable in 30 days","m:sprint 1 completed"]'::jsonb),
  ('software', 4, 600, null, '["c:5 customer conversations","c:watch 5 people use it without helping"]'::jsonb),
  ('software', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('software', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('software', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('software', 8, 3000, null, '["c:hit a $1k month","m:built a pitch deck"]'::jsonb),
  ('software', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('software', 10, 6000, null, '["m:$1k mrr","c:document your playbook"]'::jsonb),
  ('exploring', 1, 0, null, '[]'::jsonb),
  ('exploring', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('exploring', 3, 300, null, '["m:blueprint built","c:ship something","m:sprint 1 completed"]'::jsonb),
  ('exploring', 4, 600, null, '["c:5 customer conversations","c:interview 5 people in a field you are curious about"]'::jsonb),
  ('exploring', 5, 1000, null, '["c:make your first sale","m:set up how you get paid"]'::jsonb),
  ('exploring', 6, 1500, null, '["c:earn your first $100","m:separate your business money","c:collect 5 testimonials"]'::jsonb),
  ('exploring', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('exploring', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('exploring', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('exploring', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb),
  ('default', 1, 0, null, '[]'::jsonb),
  ('default', 2, 100, null, '["m:compass questions answered","m:passes your own test","m:three real signals","c:get 3 feedback sessions","c:validate your idea"]'::jsonb),
  ('default', 3, 300, null, '["m:blueprint built","c:ship something","m:sprint 1 completed"]'::jsonb),
  ('default', 4, 600, null, '["c:5 customer conversations","c:do 25 outreach touches"]'::jsonb),
  ('default', 5, 1000, null, '["c:make your first sale","m:registered my business"]'::jsonb),
  ('default', 6, 1500, null, '["c:earn your first $100","m:opened a business bank account","c:collect 5 testimonials"]'::jsonb),
  ('default', 7, 2200, null, '["c:reach 10 paying customers","c:automate one process"]'::jsonb),
  ('default', 8, 3000, null, '["c:hit a $1k month","m:write your one-page plan"]'::jsonb),
  ('default', 9, 4000, 2, '["m:completed an accelerator program","m:had my first profitable month","m:went full-time on my business"]'::jsonb),
  ('default', 10, 6000, null, '["m:three $1k months in a row","c:document your playbook"]'::jsonb)
on conflict (path, level) do update set
  xp_required = excluded.xp_required, min_gates = excluded.min_gates, gates = excluded.gates;
--!ladder-seed-end
-- <<< GENERATED <<<

-- ---------------------------------------------------------------------------
-- 3. What rung a member is actually on.
--
-- The same rule src/ladders.js meetsRung() applies, evaluated against rows
-- rather than against anything the client said: enough XP for the rung, and
-- either every gate or min_gates of them. Levels never go down — awardXP has
-- always worked that way, and taking a rung back off someone because a
-- definition moved would be worse than the drift.

create or replace function public.level_reached(p_user uuid)
returns integer
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_path text; v_xp integer; v_current integer; v_level integer; r record; v_hits integer; v_need integer;
begin
  select coalesce(path, 'default'), coalesce(xp_total, 0), coalesce(current_level, 1)
    into v_path, v_xp, v_current from profiles where id = p_user;
  if not found then return 1; end if;
  if not exists (select 1 from ladder_rungs where path = v_path) then v_path := 'default'; end if;

  v_level := 1;
  for r in select * from ladder_rungs where path = v_path and level > 1 order by level loop
    exit when v_xp < r.xp_required;
    select count(*) into v_hits
    from jsonb_array_elements_text(r.gates) as gate
    where (left(gate, 2) = 'c:' and exists (
            select 1 from challenge_completions cc join challenges c on c.id = cc.challenge_id
            where cc.user_id = p_user and lower(btrim(c.title)) = substr(gate, 3)))
       or (left(gate, 2) = 'm:' and exists (
            select 1 from user_milestones um
            left join predefined_milestones pm on pm.id = um.predefined_milestone_id
            where um.user_id = p_user
              and (lower(btrim(pm.title)) = substr(gate, 3)
                or lower(btrim(um.custom_title)) = substr(gate, 3))));
    v_need := least(coalesce(r.min_gates, jsonb_array_length(r.gates)), jsonb_array_length(r.gates));
    exit when v_hits < v_need;
    v_level := r.level;
  end loop;
  return greatest(v_level, v_current);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The one door XP comes through.
--
-- Always acts on auth.uid(). The old award_xp() took a p_user_id, which is why
-- it was revoked from every role earlier and stayed dead; this one cannot be
-- pointed at somebody else unless the caller is an admin, which is only for
-- "your win was featured on the wall" — an award a moderator makes to the
-- member whose win it was.
--
-- app.trusted_write is set transaction-locally here and read by
-- protect_profile_fields(). It is not reachable from PostgREST: a client can
-- only call the functions that are granted to it, and this is the one that
-- sets it.

create or replace function public.award_xp_for(
  p_code text, p_entity_type text default null, p_entity_id uuid default null,
  p_label text default null, p_target uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid; v_kind xp_award_kinds; v_amount integer; v_reason text;
  v_level integer; v_was_level integer; v_after integer;
begin
  v_user := auth.uid();
  if p_target is not null and p_target <> v_user then
    if not is_admin() then raise exception 'not allowed to award to another member'; end if;
    v_user := p_target;
  end if;
  if v_user is null then raise exception 'not signed in'; end if;

  select * into v_kind from xp_award_kinds where code = p_code;
  if not found then raise exception 'unknown award code %', p_code; end if;

  if v_kind.amount is not null then
    v_amount := v_kind.amount;
  elsif p_entity_id is null then
    raise exception '% needs the row it is rewarding', p_code;
  else
    -- Read the reward off the entity. Only these tables, named by the code, so
    -- the parameter can never select a table.
    execute format('select coalesce(xp_reward, 0) from %I where id = $1', v_kind.amount_from)
      into v_amount using p_entity_id;
    if v_amount is null then raise exception '% has no row %', v_kind.amount_from, p_entity_id; end if;
  end if;
  v_amount := greatest(0, least(v_amount, v_kind.max_amount));

  v_reason := coalesce(nullif(btrim(p_label), ''), v_kind.description);
  v_reason := left(v_reason, 200);

  select coalesce(current_level, 1) into v_was_level from profiles where id = v_user;

  perform set_config('app.trusted_write', 'on', true);
  insert into xp_events (user_id, amount, reason, entity_type, entity_id)
  values (v_user, v_amount, v_reason, p_entity_type, p_entity_id);   -- the trigger adds it up

  v_level := level_reached(v_user);
  update profiles set
    current_level  = v_level,
    -- Rungs 1-7 self-verify; 8+ waits for a human, as it always has.
    verified_level = case when v_level <= 7 then greatest(coalesce(verified_level, 1), v_level)
                          else coalesce(verified_level, 1) end,
    last_active_at = now()
  where id = v_user;
  select coalesce(xp_total, 0) into v_after from profiles where id = v_user;
  perform set_config('app.trusted_write', 'off', true);

  return jsonb_build_object('amount', v_amount, 'xp_total', v_after,
                            'level', v_level, 'leveled_up', v_level > v_was_level);
end;
$function$;

revoke all on function public.award_xp_for(text, text, uuid, text, uuid) from public, anon;
grant execute on function public.award_xp_for(text, text, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Both doors, closed.

-- xp_events: readable by its owner, written only by award_xp_for (which is
-- SECURITY DEFINER and so is not subject to RLS at all).
drop policy if exists xp_events_insert on xp_events;

-- profiles: the row stays theirs to edit. The score columns stop being part of
-- it. The trusted flag is what tells the difference between award_xp_for's
-- update and a hand-rolled PATCH, and only award_xp_for and the XP trigger can
-- set it.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare trusted boolean := coalesce(current_setting('app.trusted_write', true), 'off') = 'on';
begin
  if not public.is_admin() then
    new.is_admin           := old.is_admin;
    new.subscription_tier  := old.subscription_tier;
    new.subscription_status := old.subscription_status;
    new.is_lifetime        := old.is_lifetime;

    -- A member owns their own account_status, but only these transitions.
    -- 'suspended' and 'deleted' stay admin-only: suspension is a moderation
    -- decision, and 'deleted' is set by the purge job.
    if new.account_status is distinct from old.account_status
       and new.account_status not in ('active', 'deactivated', 'pending_deletion') then
      new.account_status := old.account_status;
    end if;

    -- Levels 1-7 self-verify, and only as far as the rung actually reached.
    -- 8 and above are an admin decision, so a non-admin cannot move the column
    -- past 7 in either direction -- including downward, which would revoke an
    -- approval that a person granted.
    if new.verified_level is distinct from old.verified_level
       and (new.verified_level > least(coalesce(new.current_level, 1), 7)
            or coalesce(old.verified_level, 1) > 7) then
      new.verified_level := old.verified_level;
    end if;

    -- The score. Nothing outside award_xp_for, bump_streak_for and the XP
    -- trigger may move any of it. last_checkin_date and streak_freeze_used_month
    -- are in here too: the streak is computed FROM them, so leaving them open
    -- would just move the forgery one column across.
    --
    -- tasks_completed is locked with the rest even though nothing increments it
    -- — the profile has been rendering "0 tasks done" for everyone since the
    -- column was added. That is its own bug, and not this migration's; locking
    -- it now means whatever fixes it has to go through the same door.
    if not trusted then
      new.xp_total                 := old.xp_total;
      new.current_level            := old.current_level;
      new.streak_days              := old.streak_days;
      new.longest_streak           := old.longest_streak;
      new.tasks_completed          := old.tasks_completed;
      new.last_checkin_date        := old.last_checkin_date;
      new.streak_freeze_used_month := old.streak_freeze_used_month;
    end if;
  end if;
  return new;
end $function$;

-- The XP trigger writes xp_total, so it has to be trusted too. It only ever
-- adds the amount on an xp_events row, and that table is now insertable by
-- award_xp_for alone.
create or replace function public.sync_user_xp()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare was text := coalesce(current_setting('app.trusted_write', true), 'off');
begin
  -- current_level is deliberately NOT set here. Levels are gated on real
  -- accomplishments, not on XP; level_reached() is what decides them.
  perform set_config('app.trusted_write', 'on', true);
  update public.profiles
  set xp_total = xp_total + new.amount
  where id = new.user_id;
  perform set_config('app.trusted_write', was, true);
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The streak.
--
-- bumpStreak() read last_checkin_date, worked out whether yesterday counted,
-- and wrote the answer — all under the member's own credentials, and all from
-- columns they could set first. Locking streak_days without locking
-- last_checkin_date would have moved the forgery one column across rather than
-- closing it, so the whole calculation comes here.
--
-- The rules are unchanged from the JS: checking in twice in a day does nothing,
-- yesterday continues the run, and one missed day a month is covered by the
-- freeze. Called only by the daily check-in, exactly as before — the streak is
-- check-in discipline, not "did anything at all happen today".

create or replace function public.bump_streak_for()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_today date := current_date;
  p profiles; v_streak integer; v_freeze text := null;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select * into p from profiles where id = v_user;
  if not found then raise exception 'no profile'; end if;
  if p.last_checkin_date = v_today then
    return jsonb_build_object('streak', coalesce(p.streak_days, 0), 'already', true);
  end if;

  if p.last_checkin_date = v_today - 1 then
    v_streak := coalesce(p.streak_days, 0) + 1;
  elsif p.last_checkin_date = v_today - 2
        and coalesce(p.streak_freeze_used_month, '') is distinct from to_char(v_today, 'YYYY-MM') then
    v_streak := coalesce(p.streak_days, 0) + 1;         -- the freeze covers one missed day
    v_freeze := to_char(v_today, 'YYYY-MM');
  else
    v_streak := 1;
  end if;

  perform set_config('app.trusted_write', 'on', true);
  update profiles set
    streak_days = v_streak,
    longest_streak = greatest(coalesce(longest_streak, 0), v_streak),
    last_checkin_date = v_today,
    streak_freeze_used_month = coalesce(v_freeze, streak_freeze_used_month)
  where id = v_user;
  perform set_config('app.trusted_write', 'off', true);

  return jsonb_build_object('streak', v_streak, 'already', false,
                            'froze', v_freeze is not null);
end;
$function$;

revoke all on function public.bump_streak_for() from public, anon;
grant execute on function public.bump_streak_for() to authenticated;
