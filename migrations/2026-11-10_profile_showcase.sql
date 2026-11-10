-- Applied live 2026-11-10 (run in the SQL Editor; returned true. Verified: business_name, offers, links and privacy on profiles).
--
-- Profiles (2026-11-10): a business showcase and privacy controls.
--
--  * business_name, offers ([{ title, price }], up to six) and links
--    ([{ kind, url }], up to six) make a business card on the profile.
--  * privacy ({ location, links, business, results, posts, activity, follows }:
--    each true or false, missing means shown) decides what other members see.
--    The profile's own row stays readable as before; the page simply leaves
--    out what the member chose to hide.
--  * Photos use the existing public "avatars" bucket, where members can only
--    write their own folder. No storage change.
-- Members already update their own profile row (protect_profile_fields covers
-- billing, XP and admin fields only), so no new grant or policy is needed.

alter table public.profiles add column if not exists business_name text
  check (business_name is null or char_length(business_name) <= 80);
alter table public.profiles add column if not exists offers jsonb
  check (offers is null or (jsonb_typeof(offers) = 'array' and jsonb_array_length(offers) <= 6 and pg_column_size(offers) <= 2000));
alter table public.profiles add column if not exists links jsonb
  check (links is null or (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 6 and pg_column_size(links) <= 2000));
alter table public.profiles add column if not exists privacy jsonb
  check (privacy is null or (jsonb_typeof(privacy) = 'object' and pg_column_size(privacy) <= 500));

select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
         and column_name in ('business_name', 'offers', 'links', 'privacy')) = 4 as ok;
