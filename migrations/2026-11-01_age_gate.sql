-- NOT APPLIED, written for review.
--
-- NoBossly is 18+. Signups give a date of birth (signup form, or the username
-- step after a social sign-in) and are refused below 18 in the app — see
-- src/age.js. This adds the column to keep it on the profile.
--
-- Until this is applied the app keeps the date on the auth user
-- (raw_user_meta_data.date_of_birth) and copies it across on the member's next
-- visit; the backfill below does the same for everyone at once.
--
-- The terms and privacy additions at the end are PLACEHOLDER WORDING for
-- Dillon's lawyer to check before this is applied.

alter table public.profiles add column if not exists date_of_birth date;

alter table public.profiles drop constraint if exists profiles_date_of_birth_plausible;
alter table public.profiles add constraint profiles_date_of_birth_plausible
  check (date_of_birth is null or (date_of_birth >= date '1900-01-01' and date_of_birth <= current_date));

comment on column public.profiles.date_of_birth is
  'Given at signup; never shown to other members. Nullable for accounts from before the 18+ gate (2026-11-01).';

-- Copy dates given at signup before this column existed.
update public.profiles p
   set date_of_birth = (u.raw_user_meta_data->>'date_of_birth')::date
  from auth.users u
 where u.id = p.id
   and p.date_of_birth is null
   and (u.raw_user_meta_data->>'date_of_birth') ~ '^\d{4}-\d{2}-\d{2}$'
   and (u.raw_user_meta_data->>'date_of_birth')::date between date '1900-01-01' and current_date;

-- Once given, a date of birth is not edited from the browser; an admin can
-- correct one. (Otherwise the 18+ check at signup could be undone afterwards.)
create or replace function public.date_of_birth_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if old.date_of_birth is not null and new.date_of_birth is distinct from old.date_of_birth
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.is_admin() then
    new.date_of_birth := old.date_of_birth;
  end if;
  return new;
end
$function$;
revoke all on function public.date_of_birth_guard() from public, anon, authenticated;

drop trigger if exists profiles_date_of_birth_guard on public.profiles;
create trigger profiles_date_of_birth_guard
  before update of date_of_birth on public.profiles
  for each row execute function public.date_of_birth_guard();

-- ---------------------------------------------------------------------------
-- PLACEHOLDER WORDING — for legal review before applying.
update public.cms_contents
   set body = body || '<h3>Who can use NoBossly</h3><p>NoBossly is for people 18 and older. By creating an account you confirm that you are at least 18. Accounts we find belong to someone under 18 are removed, along with their content.</p>'
 where slug = 'terms' and type = 'page' and body not ilike '%Who can use NoBossly%';

update public.cms_contents
   set body = body || '<h3>Age</h3><p>NoBossly is for people 18 and older. We ask for your date of birth at signup only to confirm that; it is never shown to other members. If we learn an account belongs to someone under 18, we delete the account and its data.</p>'
 where slug = 'privacy' and type = 'page' and body not ilike '%<h3>Age</h3>%';
