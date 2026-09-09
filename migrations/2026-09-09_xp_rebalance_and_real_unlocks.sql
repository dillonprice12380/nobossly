-- Two audit findings, one migration: what XP is worth, and what a level unlocks.
-- Every statement here is written to be safe to replay.
--
-- ---------------------------------------------------------------------------
-- 0. A trigger was promoting people on XP alone, ignoring the ladder entirely.
--
-- Found while applying the rest of this file. sync_user_xp() fires on every
-- xp_events insert and did two things:
--
--     xp_total     = xp_total + NEW.amount
--     current_level = GREATEST(1, FLOOR(SQRT((xp_total + NEW.amount)/100.0)) + 1)
--
-- The second line is a leftover from the XP-only levelling this product had
-- before the ladder existed. awardXP() checks ladders.meetsRung() before it
-- promotes anyone — the whole point of the gates is that XP is not enough — and
-- then this trigger overwrote current_level with a square root of the score.
--
-- It has been invisible because awardXP inserts the event and then immediately
-- UPDATEs the same row with its own, correct level, so the trigger's answer is
-- overwritten a few milliseconds later. The owner's account was sitting at
-- 1,260 XP: the trigger set them to Level 4 on their last award, and awardXP
-- put them back to Level 1, which is where the gates say they belong. Anything
-- that writes an xp_events row without that second UPDATE — this migration, a
-- backfill, a future job — gets the trigger's answer and keeps it.
--
-- The trigger keeps maintaining xp_total, which makes the event log the
-- authority on the score. It no longer has an opinion about levels.

create or replace function public.sync_user_xp()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- current_level is deliberately NOT set here. Levels are gated on real
  -- accomplishments, not on XP, and src/xp.js awardXP() is the only thing that
  -- knows the gates. See src/ladders.js.
  update public.profiles
  set xp_total = xp_total + new.amount
  where id = new.user_id;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 1. The self-claimed milestones were the whole economy.
--
-- Production said it plainly. Of the 1,260 XP ever awarded on this platform,
-- 1,200 came from three claims typed between 16:04:25 and 16:05:31 on one
-- afternoon — "Registered my business" (400), "Built a pitch deck" (300),
-- "Completed an accelerator program" (500). The other 60 came from actually
-- answering the Compass questionnaire and earning a follower.
--
-- A claim is a text box with a 30-character minimum and no verification. Real,
-- observable work pays 5-90: a Compass drawn is 25, drafting your own idea 15,
-- a peer review 60, a finished sprint 75. So the game was telling members that
-- the text box is the game, and that everything the software can actually see
-- is a rounding error next to it.
--
-- The twelve claims together paid 6,500 XP. The whole ladder to Level 10 costs
-- 6,000. You could out-earn the entire climb without the platform observing a
-- single thing you did.
--
-- Real-world milestones should still pay the most — they are the biggest things
-- that happen to a member, and the top five rungs are built out of them. They
-- just cannot be the only thing worth doing. Three tiers:
--
--   150  Setup. An afternoon of paperwork: registering, banking, getting paid,
--        a deck, a one-page plan.
--   300  A commercial result that took months: a profitable month, $1K MRR,
--        an accelerator finished.
--   450  The life change this platform exists for: going full-time, three $1k
--        months, three months of rent and a wage.
--
-- Total drops 6,500 -> 3,150, comfortably under the 6,000 the ladder costs, and
-- no single claim covers more than 45% of the gap to the rung it gates.
-- test/economy.js holds both properties against src/ladders.js.

update predefined_milestones pm
set xp_reward = s.new_xp
from (values
  ('registered-my-business', 150), ('opened-business-bank-account', 150),
  ('separate-your-business-money', 150), ('set-up-how-you-get-paid', 150),
  ('built-a-pitch-deck', 150), ('write-your-one-page-plan', 150),
  ('first-profitable-month', 300), ('1k-mrr', 300), ('completed-an-accelerator', 300),
  ('went-full-time', 450), ('three-1k-months', 450), ('three-months-rent-and-wages', 450)
) as s(slug, new_xp)
where pm.slug = s.slug and pm.xp_reward is distinct from s.new_xp;

-- XP already banked at the old rate, written to the log as its own correcting
-- event rather than as a silent adjustment. One account is affected (the
-- owner's, -600). The milestone records themselves stay, and nobody is demoted:
-- awardXP never lowers current_level either, so a rung once reached is kept.
-- The NOT EXISTS makes a replay a no-op.

insert into xp_events (user_id, amount, reason, entity_type)
select um.user_id, s.new_xp - s.old_xp,
       'XP rebalance: ' || s.slug || ' repriced', 'predefined_milestones'
from user_milestones um
join predefined_milestones pm on pm.id = um.predefined_milestone_id
join (values
  ('registered-my-business', 400, 150), ('opened-business-bank-account', 300, 150),
  ('separate-your-business-money', 300, 150), ('set-up-how-you-get-paid', 400, 150),
  ('built-a-pitch-deck', 300, 150), ('write-your-one-page-plan', 300, 150),
  ('first-profitable-month', 600, 300), ('1k-mrr', 900, 300),
  ('completed-an-accelerator', 500, 300), ('went-full-time', 700, 450),
  ('three-1k-months', 900, 450), ('three-months-rent-and-wages', 900, 450)
) as s(slug, old_xp, new_xp) on s.slug = pm.slug
where s.new_xp <> s.old_xp
  and not exists (
    select 1 from xp_events e
    where e.user_id = um.user_id
      and e.reason = 'XP rebalance: ' || s.slug || ' repriced');

-- The log is the score. Resyncing from it repairs any drift between the two —
-- including the first run of this migration, which subtracted the correction
-- once in its own UPDATE and once more through the trigger above.

update profiles p
set xp_total = coalesce((select sum(e.amount) from xp_events e where e.user_id = p.id), 0)
where p.xp_total is distinct from
      coalesce((select sum(e.amount) from xp_events e where e.user_id = p.id), 0);

-- ---------------------------------------------------------------------------
-- 2. verified_level was written and read by nothing.
--
-- awardXP sets it (1-7 automatically, 8+ only when an admin approves the
-- verification request), admin.js writes it on approval, and then the one
-- unlock the software actually delivers — the Level 3 showcase — checked
-- current_level instead. So approving a verification changed nothing a member
-- could see, and rejecting one changed nothing either.
--
-- src/unlocks.js now reads verified_level. Backfill first, so that nobody who
-- already has their build showing loses it the moment that ships. `dillon` sat
-- at 0, which predates the column's default.
--
-- And once the column decides something, it has to stop being self-writable.
-- awardXP runs as the member's own client, so profiles.verified_level is
-- reachable from a hand-rolled PATCH the same way every other column on the row
-- is. That was harmless while nothing read it. Now that Level 3's showcase and
-- Level 7's mentor listing both hang off it, an unclamped column means a member
-- can grant themselves the admin approval that levels 8+ are supposed to
-- require. The clamp below encodes the policy the code already states: rungs
-- 1-7 self-verify up to the level you have actually reached, 8 and above move
-- only when an admin says so.
--
-- Not fixed here, and worth its own pass: current_level and xp_total are on the
-- same row and are written by awardXP under the member's own credentials, so
-- the score itself is still client-writable. Closing that means moving the
-- award path behind a SECURITY DEFINER function, which is a larger change than
-- this migration.

update profiles
set verified_level = greatest(coalesce(verified_level, 1), least(coalesce(current_level, 1), 7))
where coalesce(verified_level, 0) < least(coalesce(current_level, 1), 7);

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- 3. Level 7's "Mentor track" was a promise with nothing behind it.
--
-- awardXP opens a verification_request at level 8 and above. Level 7 opened
-- nothing, so "you become eligible to mentor members on lower rungs, arranged
-- with you directly" was arranged with nobody — no queue, no admin screen, no
-- notification to a human. src/unlocks.js exists specifically to stop that, and
-- it had one in it.
--
-- Rather than build a coordination queue for a thing no person is staffed to
-- coordinate, the unlock becomes something the software delivers: at
-- verified_level 7 a member is listed as a mentor in the directory and on their
-- profile, where anyone below them can find and message them. That also gives
-- verified_level its second real job.
--
-- Being advertised as available to help is a commitment made in public, so it
-- is declinable. Default true because it is earned, not requested.

alter table profiles add column if not exists mentor_available boolean not null default true;

comment on column profiles.mentor_available is
  'Level 7+ members are listed as mentors unless they turn this off in profile settings. Read via unlocks.isMentor(), which also requires verified_level >= 7.';
