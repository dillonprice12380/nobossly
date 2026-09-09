-- A sweep of every write in src/ against what the database actually accepts.
--
-- Prompted by two bugs of exactly this shape shipping unnoticed (the path
-- chooser and the Compass). Four more, each confirmed by running the real write
-- in a rolled-back transaction rather than by reading code.

-- 1. EVERY NOTIFICATION IN THE PRODUCT WAS FAILING.
--
-- notifications_type_check allowed eight types from an older feature set
-- (like/follow/comment/repost/mention/badge/milestone/system). The application
-- pushes eleven, and only 'milestone' was on that list. Level-ups, DMs, forum
-- replies, collaboration invites, task assignments, wins — every one rejected
-- by the database. Every caller swallows the error with
-- .then(() => {}, () => {}), which is why nobody ever saw one fail.
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type = any (array[
    'levels', 'message', 'milestone', 'wins', 'social', 'community',
    'challenges', 'forum_reply', 'collab_invite', 'collab_response',
    'task_assigned',
    'like', 'follow', 'comment', 'repost', 'mention', 'badge', 'system'
  ]));

comment on constraint notifications_type_check on notifications is
  'Must match the ntype values passed to push_notification() across src/. test/schema-drift.js fails if they diverge.';

-- 2. CUTTING AN IDEA FAILED. Dropping an idea on the evidence is a deliberate
-- move with its own trophy — ruling something out is the harder call. The write
-- sets status='dropped', which the constraint did not allow.
alter table generated_ideas drop constraint if exists generated_ideas_status_check;
alter table generated_ideas add constraint generated_ideas_status_check
  check (status = any (array['active', 'archived', 'converted', 'dropped']));

-- 3. THE COACH THREAD COULD NOT BE SAVED. src/routes/coach.js upserts
-- ai_conversations with context_type='coach'; the constraint listed 'cofounder',
-- from the since-retired ai-cofounder edge function. Every coach reply would
-- have been generated, charged for, and then lost.
alter table ai_conversations drop constraint if exists ai_conversations_context_type_check;
alter table ai_conversations add constraint ai_conversations_context_type_check
  check (context_type = any (array['coach', 'general', 'blueprint', 'sprint', 'idea', 'cofounder']));

-- 4. NOBODY COULD DEACTIVATE OR DELETE THEIR OWN ACCOUNT.
--
-- protect_profile_fields() reverted account_status on every non-admin update,
-- so /account/deactivate and /account/delete appeared to work — the member was
-- logged out and told it had happened — while the row stayed 'active'. The
-- constraint separately forbade the two values the app writes, which is how the
-- sweep found it; the trigger is why it looked like it had worked.
--
-- Locking that column is right for is_admin, subscription_tier,
-- subscription_status and is_lifetime: a member must never grant themselves
-- paid access. account_status is different — it is the one status a member
-- legitimately owns. They may deactivate, request deletion, or come back. Only
-- an admin may suspend, and only the purge job sets 'deleted'.
alter table profiles drop constraint if exists profiles_account_status_check;
alter table profiles add constraint profiles_account_status_check
  check (account_status = any (array['active', 'deactivated', 'pending_deletion', 'suspended', 'deleted']));

create or replace function protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    new.is_admin           := old.is_admin;
    new.subscription_tier  := old.subscription_tier;
    new.subscription_status := old.subscription_status;
    new.is_lifetime        := old.is_lifetime;

    if new.account_status is distinct from old.account_status
       and new.account_status not in ('active', 'deactivated', 'pending_deletion') then
      new.account_status := old.account_status;
    end if;
  end if;
  return new;
end $$;

comment on function protect_profile_fields() is
  'Stops a member editing the fields that decide what they have paid for. account_status was in that list until 2026-09-09, which meant Deactivate and Delete Account both silently did nothing. They may now set active/deactivated/pending_deletion on themselves; suspended and deleted remain admin-only.';
