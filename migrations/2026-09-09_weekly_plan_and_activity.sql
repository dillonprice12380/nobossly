-- Two tables: the thing the subscription is actually for, and the thing that
-- makes the community visible.
--
-- WEEKLY PLANS
--
-- Every paid feature in the product until now produced a document — a
-- blueprint, a list of challenges, a budget. You generate it once and you are
-- done, which is why none of them hold a subscription past the month it was
-- bought in. The weekly plan is the opposite by construction: it is dated, it
-- reads last week before writing this week, and it is worthless in arrears.
--
-- It is also the one AI feature here that could not be replicated by pasting
-- your situation into a general chatbot, because it is written from the ladder:
-- your rung, the specific gate blocking the next one, and the hours you told us
-- you actually have after work.
--
-- ACTIVITY EVENTS
--
-- notify_social() already fans achievements out to followers, but only as
-- notifications — they land in the bell, get marked read, and are gone. There
-- was nowhere to go and see what the people you follow have been doing.
--
-- Worse, the one achievement most worth seeing was never fanned out at all:
-- awardXP() pushes a LEVEL UP notification to the member themselves and to
-- nobody else, so in a product whose whole spine is a ten-rung ladder, reaching
-- a rung was the single least visible thing you could do.

-- --------------------------------------------------------------------------

create table if not exists weekly_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  week_of     date not null,
  level       int,
  rung_title  text,
  gate_summary text,
  hours       text,
  intro       text,
  items       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, week_of)
);

comment on table weekly_plans is
  'One plan per member per week (Monday-anchored). items is [{title, why, day, minutes, done}] — `done` is ticked by the member, and next week''s plan is written having read it.';

comment on column weekly_plans.gate_summary is
  'The rung gate this week is aimed at, in words, captured at generation time. Kept on the row rather than recomputed so a plan still reads correctly after the member clears the gate it was written for.';

create index if not exists weekly_plans_user_idx on weekly_plans (user_id, week_of desc);

alter table weekly_plans enable row level security;
drop policy if exists weekly_plans_own on weekly_plans;
create policy weekly_plans_own on weekly_plans for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --------------------------------------------------------------------------

create table if not exists activity_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  kind        text not null check (kind in ('level','challenge','milestone','badge','win','idea','streak','sprint','compass')),
  title       text not null,
  emoji       text,
  level       int,
  entity_type text,
  entity_id   uuid,
  created_at  timestamptz not null default now()
);

comment on table activity_events is
  'The follower feed. One row per real achievement, written alongside the existing notify_social() fan-out rather than replacing it: notifications are a nudge you clear, this is a place you go and look.';

create index if not exists activity_events_user_idx on activity_events (user_id, created_at desc);
create index if not exists activity_events_recent_idx on activity_events (created_at desc);

alter table activity_events enable row level security;

-- Readable when it is yours, when you follow them, or when their profile is
-- public — and never across a block in either direction. Achievements are the
-- part of a profile that stays visible even when it is set to private (see the
-- Help Center: "Private profiles only reveal your username, level, awards and
-- badges"), so following someone is enough.
drop policy if exists activity_events_visible on activity_events;
create policy activity_events_visible on activity_events for select using (
  (
    user_id = auth.uid()
    or exists (select 1 from follows f
                where f.follower_id = auth.uid() and f.following_id = activity_events.user_id)
    or exists (select 1 from profiles p
                where p.id = activity_events.user_id and p.profile_is_public)
  )
  and not exists (
    select 1 from user_blocks b
     where (b.blocker_id = auth.uid() and b.blocked_id = activity_events.user_id)
        or (b.blocker_id = activity_events.user_id and b.blocked_id = auth.uid())
  )
);

drop policy if exists activity_events_own_insert on activity_events;
create policy activity_events_own_insert on activity_events for insert
  with check (auth.uid() = user_id);

drop policy if exists activity_events_own_delete on activity_events;
create policy activity_events_own_delete on activity_events for delete
  using (auth.uid() = user_id);
