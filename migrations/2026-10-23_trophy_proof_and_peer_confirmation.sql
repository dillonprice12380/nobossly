-- Real-world trophies need proof before they pay out.
--
-- Until now any self-claimed trophy unlocked on a 30-character note, including
-- the 300-450 XP ones that gate the top rungs ("Went full-time on my business",
-- "Three $1k months in a row"). Now:
--   * every claimable trophy needs a proof link someone else could check
--     (a live site, a public listing, a registry lookup, a shared screenshot);
--   * trophies worth 300 XP or more also need another member to confirm them.
--     The claim waits in trophy_claims until a member at Level 3+ (or an
--     admin) who is not the claimant confirms it; only then is the trophy —
--     and its XP — awarded.

create table if not exists public.trophy_claims (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  milestone_id  uuid not null references public.predefined_milestones(id) on delete cascade,
  note          text not null,
  proof_url     text not null,
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'declined')),
  confirmed_by  uuid references public.profiles(id) on delete set null,
  confirmed_at  timestamptz,
  -- XP is awarded by the claimant's own client on their next visit (award_xp_for
  -- only awards to the caller), which then sets this.
  xp_awarded    boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (user_id, milestone_id)
);
alter table public.trophy_claims enable row level security;
-- Signed-in members can see pending claims (to confirm them) and their own.
drop policy if exists trophy_claims_read on public.trophy_claims;
create policy trophy_claims_read on public.trophy_claims
  for select to authenticated using (status = 'pending' or user_id = auth.uid());

create or replace function public.claim_trophy_for(p_milestone_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  d predefined_milestones;
  v_note text := left(btrim(coalesce(p_note, '')), 2000);
  v_proof text;
  v_paid boolean;
begin
  if v_user is null then raise exception 'not signed in'; end if;
  select * into d from predefined_milestones
   where id = p_milestone_id and is_active and is_claimable;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_claimable'); end if;
  if length(v_note) < 30 then
    return jsonb_build_object('ok', false, 'reason', 'needs_note', 'title', d.title);
  end if;
  v_proof := substring(v_note from 'https?://[^\s<>"]+');
  if v_proof is null then
    return jsonb_build_object('ok', false, 'reason', 'needs_proof_link', 'title', d.title);
  end if;
  if exists (select 1 from user_milestones
              where user_id = v_user and predefined_milestone_id = d.id) then
    return jsonb_build_object('ok', false, 'reason', 'already', 'title', d.title);
  end if;

  if d.xp_reward >= 300 then
    insert into trophy_claims (user_id, milestone_id, note, proof_url)
    values (v_user, d.id, v_note, left(v_proof, 500))
    on conflict (user_id, milestone_id) do update
      set note = excluded.note, proof_url = excluded.proof_url, status = 'pending',
          confirmed_by = null, confirmed_at = null, created_at = now();
    return jsonb_build_object('ok', false, 'reason', 'pending_confirmation', 'title', d.title);
  end if;

  v_paid := is_paid_member(v_user);
  insert into user_milestones (user_id, predefined_milestone_id, emoji, custom_description,
                               date_achieved, pinned)
  values (v_user, d.id, d.emoji, v_note, current_date, coalesce(v_paid, false));
  return jsonb_build_object('ok', true, 'title', d.title, 'emoji', d.emoji,
                            'xp_reward', d.xp_reward);
end;
$function$;

-- Confirm (or decline) someone else's claim. Confirming awards the trophy.
create or replace function public.confirm_trophy_claim(p_claim uuid, p_confirm boolean)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_me uuid := auth.uid();
  c trophy_claims;
  d predefined_milestones;
  v_level int;
begin
  if v_me is null then raise exception 'not signed in'; end if;
  select coalesce(current_level, 1) into v_level from profiles where id = v_me;
  if not public.is_admin() and coalesce(v_level, 1) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'level_too_low');
  end if;
  select * into c from trophy_claims where id = p_claim and status = 'pending' for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if c.user_id = v_me then return jsonb_build_object('ok', false, 'reason', 'own_claim'); end if;
  select * into d from predefined_milestones where id = c.milestone_id;

  update trophy_claims set status = case when p_confirm then 'confirmed' else 'declined' end,
         confirmed_by = v_me, confirmed_at = now()
   where id = c.id;

  if p_confirm and not exists (select 1 from user_milestones
                                where user_id = c.user_id and predefined_milestone_id = c.milestone_id) then
    insert into user_milestones (user_id, predefined_milestone_id, emoji, custom_description,
                                 date_achieved, pinned)
    values (c.user_id, d.id, d.emoji, c.note, current_date, coalesce(is_paid_member(c.user_id), false));
  end if;

  insert into notifications (user_id, type, actor_id, entity_type, entity_id, message, is_read)
  values (c.user_id, 'milestone', v_me, 'milestones', d.id,
          case when p_confirm
               then 'A member confirmed your trophy “' || d.title || '” — it is yours.'
               else 'Your trophy claim “' || d.title || '” was not confirmed. Add clearer proof and claim it again.' end,
          false);
  return jsonb_build_object('ok', true, 'title', d.title);
end;
$function$;
revoke all on function public.confirm_trophy_claim(uuid, boolean) from public;
grant execute on function public.confirm_trophy_claim(uuid, boolean) to authenticated;

-- Called by the claimant's client once it has awarded the XP for a confirmed claim.
create or replace function public.trophy_claim_mark_awarded(p_claim uuid)
returns void language sql security definer set search_path to 'public'
as $function$
  update trophy_claims set xp_awarded = true
   where id = p_claim and user_id = auth.uid() and status = 'confirmed'
$function$;
revoke all on function public.trophy_claim_mark_awarded(uuid) from public;
grant execute on function public.trophy_claim_mark_awarded(uuid) to authenticated;
