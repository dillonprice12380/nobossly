-- The rest of the security audit: findings 5, 6, 9 and 10. (7 and 8 are in the
-- app — a redirect helper and the upload allowlist — with the bucket's own
-- limits at the bottom of this file.)
--
-- ---------------------------------------------------------------------------
-- 5. A friend request could be accepted by the person who sent it.
--
-- friends_update was `requester_id = auth.uid() or addressee_id = auth.uid()`,
-- which is right for reading and wrong for answering: A sends B a request, then
-- A sets status = 'accepted' and they are friends without B agreeing.
-- Reproduced against production. Friendship is not cosmetic here — notify_social
-- fans out to friends as well as followers, so a one-sided friendship is a
-- one-sided channel into somebody's notifications.
--
-- Every accept and decline in the app is already made by the addressee
-- (src/routes/social.js), so the rule is simply that.

create or replace function public.friendships_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if public.is_admin() then return new; end if;
  -- Who the friendship is between never changes.
  new.requester_id := old.requester_id;
  new.addressee_id := old.addressee_id;
  -- Answering a request belongs to the person who received it.
  if new.status is distinct from old.status and auth.uid() is distinct from old.addressee_id then
    new.status := old.status;
  end if;
  return new;
end $function$;

drop trigger if exists friendships_guard_trg on friendships;
create trigger friendships_guard_trg before update on friendships
for each row execute function public.friendships_guard();

-- ---------------------------------------------------------------------------
-- 6. You could file your own verification request, at any rung.
--
-- Levels 8 and up open a verification_request that an admin reviews, and
-- approving it sets verified_level -- which now decides the Level 3 showcase and
-- the Level 7 mentor listing. The row was inserted from src/xp.js under the
-- member's own credentials, so it could just as easily be inserted by hand:
-- reproduced by filing one at level 10 with no rungs behind it. vr_own_update_
-- pending then let the level be edited while it sat in the queue.
--
-- award_xp_for already computes the level from the ladder, so it files the
-- request itself now and the member's INSERT goes away. What stays is the
-- evidence: a member may attach a link, a redacted screenshot or a note to
-- their own pending request, and nothing else on it.

create or replace function public.verification_requests_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if public.is_admin() then return new; end if;
  new.user_id := old.user_id;
  new.level   := old.level;      -- the ladder decides this, not the applicant
  new.status  := old.status;     -- and a person decides this
  return new;
end $function$;

drop trigger if exists verification_requests_guard_trg on verification_requests;
create trigger verification_requests_guard_trg before update on verification_requests
for each row execute function public.verification_requests_guard();

drop policy if exists vr_own_insert on verification_requests;

-- Filed by the same function that worked out the level. Unique(user_id, level)
-- keeps it idempotent, exactly as the JS insert relied on.
create or replace function public.award_xp_for(
  p_code text, p_entity_type text default null, p_entity_id uuid default null,
  p_label text default null, p_target uuid default null)
returns jsonb language plpgsql security definer set search_path to 'public'
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
    execute format('select coalesce(xp_reward, 0) from %I where id = $1', v_kind.amount_from)
      into v_amount using p_entity_id;
    if v_amount is null then raise exception '% has no row %', v_kind.amount_from, p_entity_id; end if;
  end if;
  v_amount := greatest(0, least(v_amount, v_kind.max_amount));

  v_reason := left(coalesce(nullif(btrim(p_label), ''), v_kind.description), 200);
  select coalesce(current_level, 1) into v_was_level from profiles where id = v_user;

  perform set_config('app.trusted_write', 'on', true);
  insert into xp_events (user_id, amount, reason, entity_type, entity_id)
  values (v_user, v_amount, v_reason, p_entity_type, p_entity_id);

  v_level := level_reached(v_user);
  update profiles set
    current_level  = v_level,
    verified_level = case when v_level <= 7 then greatest(coalesce(verified_level, 1), v_level)
                          else coalesce(verified_level, 1) end,
    last_active_at = now()
  where id = v_user;
  select coalesce(xp_total, 0) into v_after from profiles where id = v_user;

  -- Rungs 8 and up wait for a person. The request is filed here, from the level
  -- this function just worked out, so the rung on it is the rung they reached.
  if v_level >= 8 and v_level > v_was_level then
    insert into verification_requests (user_id, level) values (v_user, v_level)
    on conflict do nothing;
  end if;
  perform set_config('app.trusted_write', 'off', true);

  return jsonb_build_object('amount', v_amount, 'xp_total', v_after,
                            'level', v_level, 'leveled_up', v_level > v_was_level);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Every peer review was readable by everybody, signed out included.
--
-- peer_reviews_select was `true`. There are no rows yet, so nothing has been
-- exposed, but a review carries the member's idea and somebody's candid opinion
-- of it. The queue does need to be browsable -- that is the whole feature -- so
-- the two row types get different answers again: an open REQUEST is visible to
-- signed-in members, because that is the queue they are picking from; a REVIEW
-- is between the person who asked and the person who answered.

-- A signed-out visitor cannot execute is_admin(), so a policy that reaches it
-- raises "permission denied for function is_admin" instead of hiding the row.
-- That is not hypothetical: wins_select is `approved = true or auth.uid() =
-- user_id or is_admin()`, an approved win short-circuits, and the first
-- UNAPPROVED one would have turned the public Wins wall into an error for
-- signed-out visitors. There are no wins yet, so it has never fired. The
-- function answers false for anon by construction — auth.uid() is null — so
-- letting anon evaluate it discloses nothing and closes the whole class.
grant execute on function public.is_admin() to anon;
grant execute on function public.is_admin_user() to anon;

-- The policy below does not lean on that grant either: a signed-out visitor is
-- turned away before either branch is evaluated.
drop policy if exists peer_reviews_select on peer_reviews;
create policy peer_reviews_select on peer_reviews for select using (
  auth.uid() is not null
  and case when request_id is null
           then true                          -- the queue, for members
           else submitter_id = auth.uid() or reviewer_id = auth.uid() or is_admin()
      end
);

-- ---------------------------------------------------------------------------
-- 10. Any member could notify any other member, with any text.
--
-- push_notification does check that you are signed in and stamps actor_id from
-- auth.uid(), and notifications_type_check bounds the type -- so a message is
-- attributable and cannot pretend to be a system category. What it could do was
-- go to anyone, any number of times.
--
-- The legitimate cross-user notifications are all event-shaped: somebody
-- reviewed your work, invited you to a project, sent you a message, assigned
-- you a task. None of them come anywhere near thirty an hour. A relationship
-- test would be the stronger rule, but it is thirteen different relationships
-- and a wrong one fails silently as a notification that never arrives; a
-- ceiling ends mass abuse without that risk. Worth revisiting if the abuse it
-- still allows -- one unpleasant message to one person, signed -- matters more
-- later than a missed notification does.

create or replace function public.push_notification(
  target_user uuid, ntype text, nmessage text,
  nentity_type text default null, nentity_id uuid default null)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_recent integer;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if target_user is distinct from auth.uid() and not is_admin() then
    select count(*) into v_recent from notifications
     where actor_id = auth.uid() and user_id <> auth.uid()
       and created_at > now() - interval '1 hour';
    if v_recent >= 30 then
      raise exception 'too many notifications sent in the last hour';
    end if;
  end if;
  insert into public.notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (target_user, ntype, auth.uid(), nentity_type, nentity_id, nmessage, false);
end $function$;

-- ---------------------------------------------------------------------------
-- 8 (the storage half). The uploads bucket was public with no ceiling on size
-- and no restriction on type, and the app was handing it a content type the
-- client had chosen. See src/routes/uploads.js for the other half.

update storage.buckets
set file_size_limit = 8388608,
    allowed_mime_types = array[
      'image/png','image/jpeg','image/gif','image/webp',
      'application/pdf','text/plain','text/csv','text/markdown',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip'
    ]
where id = 'uploads';
