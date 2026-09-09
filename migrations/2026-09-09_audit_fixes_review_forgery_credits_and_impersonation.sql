-- Four findings from the security audit, all reproduced against production as
-- an ordinary non-admin member before being closed.
--
-- ---------------------------------------------------------------------------
-- 1 & 2. Peer reviews could be written for you, and rewritten about you.
--
-- A peer_reviews row is one of two things: a REQUEST (request_id is null, the
-- member asking for feedback) or a REVIEW of one (request_id set, somebody
-- answering). Both policies treated the table as one shape:
--
--     insert with check (auth.uid() = submitter_id or auth.uid() = reviewer_id)
--     update using      (auth.uid() = submitter_id or auth.uid() = reviewer_id)
--
-- The submitter_id branch is there so you can post your own request. But
-- peer_reviews_bind_submitter() copies submitter_id onto a review from its
-- parent request — so on your OWN request, submitter_id is you, the branch
-- passes, and you may insert a review naming ANYONE as its reviewer.
--
-- Reproduced: three of my own requests, three reviews attributed to three real
-- members saying "Outstanding. Best idea I have seen." — after which
-- complete_review_quest_for('gate') returned ok, clearing Level 2's peer-review
-- gate. The peer_reviews_no_self_review CHECK did fire and does work; it
-- compares reviewer to submitter, and never either of them to the caller.
--
-- The update policy was the same shape and the same mistake: a review reading
-- "Honestly, this will not work." (rating 1) was rewritten by the person whose
-- work it was into "Amazing, I would invest today." (rating 5), still
-- attributed to the reviewer.
--
-- So each row type gets the rule that actually belongs to it. You own your
-- request; the reviewer owns their review; nobody owns anybody else's words.

drop policy if exists peer_reviews_insert on peer_reviews;
create policy peer_reviews_insert on peer_reviews for insert with check (
  case when request_id is null
       then submitter_id = auth.uid() and reviewer_id is null   -- posting your own request
       else reviewer_id = auth.uid()                            -- answering someone's
  end
);

drop policy if exists peer_reviews_update on peer_reviews;
create policy peer_reviews_update on peer_reviews for update
using (
  case when request_id is null then submitter_id = auth.uid() else reviewer_id = auth.uid() end
) with check (
  case when request_id is null then submitter_id = auth.uid() else reviewer_id = auth.uid() end
);

-- The request's status used to be written by whichever REVIEWER happened to
-- finish — a cross-user update, and the only reason the old policy needed to
-- let a non-owner touch the row at all. It is derived here instead, which is
-- what it always was: pending until somebody answers, in_review while answers
-- are coming, completed once there are three.

create or replace function public.peer_reviews_sync_request_status()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_done integer;
begin
  if new.request_id is null then return new; end if;
  select count(*) into v_done from peer_reviews
   where request_id = new.request_id and status = 'completed';
  update peer_reviews
     set status = case when v_done >= 3 then 'completed' else 'in_review' end,
         updated_at = now()
   where id = new.request_id and status <> 'withdrawn';
  return new;
end;
$function$;

drop trigger if exists peer_reviews_sync_request_status_trg on peer_reviews;
create trigger peer_reviews_sync_request_status_trg
after insert on peer_reviews
for each row execute function public.peer_reviews_sync_request_status();

-- ---------------------------------------------------------------------------
-- 3. Credits could be refunded that were never spent.
--
-- refund_ai_credits(p_kind) is granted to authenticated and acts on auth.uid().
-- It added the cost of p_kind back to the balance, capped at the plan cap, and
-- nothing anywhere checked that a spend had happened. Reproduced: balance
-- drained to 0, three calls took it to 18, forty-three calls took it to 20 —
-- the cap. Spend to zero, refund to cap, repeat. Unlimited AI, billed to us.
--
-- The refund exists for one narrow case: src/credits.js charges before the call
-- and refunds when the call throws, seconds later. So a refund now has to point
-- at a real, recent, not-yet-refunded spend of that same kind. Outside that
-- window there is nothing to give back.

create or replace function public.refund_ai_credits(p_kind text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_user    uuid := auth.uid();
  v_cost    int;
  v_cap     int;
  v_balance int;
  v_plan    text;
  v_prof    profiles%rowtype;
  v_spends  int;
  v_refunds int;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'auth');
  end if;

  select * into v_prof from profiles where id = v_user;
  if v_prof.id is null then
    return jsonb_build_object('ok', false, 'reason', 'auth');
  end if;

  -- A refund must answer a spend. The window matches how the rail actually
  -- works: charge, call, refund on throw -- all inside a few seconds.
  select count(*) into v_spends from ai_spend
   where user_id = v_user and kind = p_kind and created_at > now() - interval '15 minutes';
  select count(*) into v_refunds from ai_spend
   where user_id = v_user and kind = p_kind || ':refund' and created_at > now() - interval '15 minutes';
  if v_spends <= v_refunds then
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_refund');
  end if;

  v_plan := case
    when v_prof.is_admin or v_prof.is_lifetime then 'paid'
    when v_prof.subscription_status in ('active','canceled','trialing')
         and v_prof.subscription_period_end is not null
         and v_prof.subscription_period_end > now() then 'paid'
    when v_prof.subscription_status = 'active'
         and v_prof.subscription_period_end is null then 'paid'
    else 'free'
  end;

  select monthly into v_cap from ai_credit_plans where plan = v_plan;
  if v_cap is null then v_cap := 20; end if;

  select cost into v_cost from ai_credit_costs where kind = p_kind;
  if v_cost is null then v_cost := 1; end if;

  -- least() keeps a refund from ever pushing a balance above the plan cap, so a
  -- repeated fail/refund loop cannot mint credits.
  update ai_credits
     set balance = least(balance + v_cost, v_cap),
         total_used = greatest(coalesce(total_used, 0) - v_cost, 0),
         updated_at = now()
   where user_id = v_user
  returning balance into v_balance;

  if v_balance is null then
    return jsonb_build_object('ok', false, 'reason', 'no_row');
  end if;

  -- Logged as a negative row so the spend history still reconciles and a
  -- pattern of failures is visible rather than silently smoothed over. It is
  -- also what the check above counts, so a refund can only ever answer once.
  insert into ai_spend (user_id, kind, cost, plan, balance_after)
  values (v_user, p_kind || ':refund', -v_cost, v_plan, v_balance);

  return jsonb_build_object('ok', true, 'refunded', v_cost, 'balance', v_balance);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Anyone could speak to anyone's followers, as them.
--
-- notify_social(actor uuid, ...) fans a message out to everyone following
-- `actor` and everyone they are friends with. `actor` was a parameter, and the
-- function never looked at auth.uid() at all. Reproduced: a message reading
-- "I have moved my new course to bargain-course.example -- grab it free"
-- planted in another member's followers' inboxes, as activity from them.
--
-- Every call site in src/ already passes the acting member. The one case where
-- the actor is somebody else is an admin featuring a win, which can level its
-- owner up and announce it for them -- so admins keep that, and nobody else
-- gets it.

create or replace function public.notify_social(actor uuid, nmessage text, netype text, neid uuid)
returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare cnt integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if actor is distinct from auth.uid() and not is_admin() then
    raise exception 'cannot post activity as another member';
  end if;
  with targets as (
    select follower_id as uid from follows where following_id = actor
    union
    select case when requester_id = actor then addressee_id else requester_id end
    from friendships where status = 'accepted' and (requester_id = actor or addressee_id = actor)
  )
  insert into notifications (user_id, type, message, entity_type, entity_id, is_read)
  select uid, 'social', nmessage, netype, neid, false from targets where uid <> actor limit 200;
  get diagnostics cnt = row_count;
  return cnt;
end $function$;
