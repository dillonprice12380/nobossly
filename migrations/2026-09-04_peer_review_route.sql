-- Applied 2026-09-04. The on-platform route to "Get 3 Feedback Sessions".
--
-- peer_reviews already existed with a full schema and ZERO rows — nothing had
-- ever written to it. This wires it up as a second route to the quest. The
-- off-site route (talk to three people, upload a proof note) is untouched: a
-- founder with a real network should not be pushed through a forum.
--
-- One table, two kinds of row, distinguished by request_id:
--   REQUEST — request_id null, reviewer_id null. "Here is my idea, review it."
--   REVIEW  — request_id points at the request; reviewer_id is the reviewer.
--
-- This count gates a level, so the guards below are in the DATABASE rather than
-- only in the route. RLS is the real boundary — anyone with the publishable key
-- can post rows directly, and every one of these was reachable that way.

alter table peer_reviews add column if not exists request_id uuid references peer_reviews(id) on delete cascade;
create index if not exists peer_reviews_request_idx on peer_reviews (request_id);
create index if not exists peer_reviews_submitter_idx on peer_reviews (submitter_id, status);

-- Level 1's gate is about the IDEA itself. The existing types were all
-- artefacts a founder makes later — blueprint, landing page, pitch deck.
alter table peer_reviews drop constraint if exists peer_reviews_review_type_check;
alter table peer_reviews add constraint peer_reviews_review_type_check
  check (review_type = any (array['idea','blueprint','landing_page','pitch_deck','copy','pricing','general']));

-- No reviewing yourself.
alter table peer_reviews drop constraint if exists peer_reviews_no_self_review;
alter table peer_reviews add constraint peer_reviews_no_self_review
  check (reviewer_id is null or reviewer_id <> submitter_id);

-- One review per person per request, or a single reviewer could walk a founder
-- through the gate by submitting three times.
create unique index if not exists peer_reviews_one_per_reviewer
  on peer_reviews (request_id, reviewer_id) where request_id is not null and reviewer_id is not null;

-- A review inherits submitter_id, title and review_type from the request it
-- answers. The insert policy has to let a reviewer write a row whose
-- submitter_id belongs to someone else — that is what a review IS — so without
-- this trigger anyone could post rows crediting an arbitrary account. Taking
-- the title and type from the parent too means a review can never claim to be
-- about something other than what it reviews.
create or replace function peer_reviews_bind_submitter() returns trigger
language plpgsql security definer set search_path = public as $$
declare parent record;
begin
  if new.request_id is null then
    return new;                      -- a request stands on its own
  end if;
  select submitter_id, title, review_type into parent
    from peer_reviews where id = new.request_id and request_id is null;
  if parent.submitter_id is null then
    raise exception 'peer review must point at a real request';
  end if;
  new.submitter_id := parent.submitter_id;
  new.title := parent.title;
  new.review_type := parent.review_type;
  return new;
end $$;

drop trigger if exists peer_reviews_bind_submitter_trg on peer_reviews;
create trigger peer_reviews_bind_submitter_trg
  before insert or update on peer_reviews
  for each row execute function peer_reviews_bind_submitter();

-- Reading is open to signed-in members: a queue nobody can browse has no
-- reviewers in it, and posting here is a choice to show the idea.
drop policy if exists peer_reviews_insert on peer_reviews;
create policy peer_reviews_insert on peer_reviews for insert
  with check (auth.uid() = submitter_id or auth.uid() = reviewer_id);

drop policy if exists peer_reviews_update on peer_reviews;
create policy peer_reviews_update on peer_reviews for update
  using (auth.uid() = submitter_id or auth.uid() = reviewer_id);

-- A request can be withdrawn while unanswered; a review is permanent.
drop policy if exists peer_reviews_delete on peer_reviews;
create policy peer_reviews_delete on peer_reviews for delete
  using (auth.uid() = submitter_id and reviewer_id is null);

-- ---------- the Coach ----------
insert into guidance_rules (key, priority, conditions, message, cta_label, cta_href, category, cooldown_days, active)
values
  ('needs_feedback_sessions', 89, '{"fit_complete": true, "signals_count": {"gte": 3}}'::jsonb,
   'Your idea passes its own test and the demand is evidenced. Now put it in front of three people — post it for peer review here, or talk to three off-site and log it.',
   'Get it reviewed', '/reviews', 'onboarding', 2, true),
  ('review_someone', 45, '{"has_compass": true}'::jsonb,
   'Someone is waiting for feedback on their idea. Giving a review is +60 XP, clears a quest, and is how you get yours answered.',
   'Open the queue', '/reviews', 'community', 3, true)
on conflict (key) do update set
  priority = excluded.priority, conditions = excluded.conditions, message = excluded.message,
  cta_label = excluded.cta_label, cta_href = excluded.cta_href, category = excluded.category,
  cooldown_days = excluded.cooldown_days, active = true;

-- Verify the guards after any change here. Each insert must be refused:
--
--   begin;
--   -- self-review, duplicate reviewer, orphan request, review-of-a-review
--   -- and a forged submitter_id (which must be rewritten to the request owner)
--   rollback;
--
-- The full probe is in the session transcript; the short version is that all
-- five were confirmed blocked or rewritten against this schema before shipping.
