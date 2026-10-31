-- is_paid_member() mirrors planOf() in src/middleware/auth.js. When NoBossly
-- went free, planOf() became "always paid", but this function kept checking
-- the old subscription columns, so a trophy earned by a free member was saved
-- unpinned while the app treated that same member as fully paid. It now
-- answers the way planOf() does: every member counts. Applied live 2026-10-31.

create or replace function public.is_paid_member(p_user uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from profiles p where p.id = p_user);
$function$;

revoke all on function public.is_paid_member(uuid) from public, anon;
grant execute on function public.is_paid_member(uuid) to authenticated;
