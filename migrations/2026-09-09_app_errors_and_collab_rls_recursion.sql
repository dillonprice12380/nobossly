-- ---------------------------------------------------------------------------
-- 1. Collaborations and the task team are dead, and have been.
--
-- Every read of collab_members and collab_projects fails with
--
--     infinite recursion detected in policy for relation "collab_members"
--
-- which PostgREST returns as a 500. Reproduced against production as the
-- owner's own account; the 500s are in the edge logs going back as far as they
-- are kept.
--
-- The policies reference each other, and one references itself:
--
--   collab_members_select : user_id = auth.uid()
--                        OR project_id IN (select id from collab_projects
--                                           where owner_id = auth.uid())
--                        OR project_id IN (select project_id from collab_members m2
--                                           where m2.user_id = auth.uid() ...)
--   collab_projects_select: owner_id = auth.uid()
--                        OR id IN (select project_id from collab_members
--                                   where user_id = auth.uid())
--
-- Reading collab_members evaluates a subquery on collab_members, whose rows are
-- themselves subject to the same policy. Postgres stops it rather than looping,
-- and the feature has simply never worked -- src/routes/tasks.js getTeam()
-- swallows the failure into an empty list, so it reads as "you have no
-- teammates" instead of an error.
--
-- The way out of a recursive policy is a SECURITY DEFINER function: it does the
-- membership lookup with RLS off, so the policy never re-enters the table it is
-- protecting. Same rules as before, expressed once.

create or replace function public.my_collab_project_ids()
returns setof uuid language sql stable security definer set search_path to 'public'
as $function$
  select id from collab_projects where owner_id = auth.uid()
  union
  select project_id from collab_members
   where user_id = auth.uid() and status = 'accepted';
$function$;

revoke all on function public.my_collab_project_ids() from public;
grant execute on function public.my_collab_project_ids() to authenticated;

drop policy if exists collab_members_select on collab_members;
create policy collab_members_select on collab_members for select using (
  user_id = auth.uid() or project_id in (select my_collab_project_ids())
);

drop policy if exists collab_members_update on collab_members;
create policy collab_members_update on collab_members for update using (
  user_id = auth.uid()
  or project_id in (select id from collab_projects where owner_id = auth.uid())
);

drop policy if exists collab_members_delete on collab_members;
create policy collab_members_delete on collab_members for delete using (
  user_id = auth.uid()
  or project_id in (select id from collab_projects where owner_id = auth.uid())
);

-- collab_projects only needed the one leg that pointed back at collab_members.
drop policy if exists collab_projects_select on collab_projects;
create policy collab_projects_select on collab_projects for select using (
  owner_id = auth.uid() or id in (select my_collab_project_ids())
);

-- ---------------------------------------------------------------------------
-- 2. Somewhere to put the errors nobody can see.
--
-- Three times today a page has failed in production with "Oops. Something went
-- wrong." and there has been no way to find out why: the app is not on Supabase
-- so its logs are not in this project, it writes nothing to the database, and
-- console.error goes to a host nobody in this session can reach. Every
-- diagnosis so far has come from reading Supabase's edge logs and inferring,
-- which works when the failure is a bad query and not at all when it is a
-- TypeError in a route.
--
-- So the error handler writes here, and the page shows the reference. Insert
-- only, through a function, so a stack trace cannot be read back by the person
-- who triggered it -- admins read the table, nobody else does.

create table if not exists app_errors (
  id          uuid primary key default gen_random_uuid(),
  ref         text not null,
  user_id     uuid,
  path        text,
  method      text,
  message     text,
  stack       text,
  created_at  timestamptz not null default now()
);
create index if not exists app_errors_created_idx on app_errors (created_at desc);
create index if not exists app_errors_ref_idx on app_errors (ref);

alter table app_errors enable row level security;
drop policy if exists app_errors_admin_read on app_errors;
create policy app_errors_admin_read on app_errors for select using (is_admin());

create or replace function public.log_app_error(
  p_ref text, p_path text, p_method text, p_message text, p_stack text)
returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  insert into app_errors (ref, user_id, path, method, message, stack)
  values (left(p_ref, 20), auth.uid(), left(p_path, 300), left(p_method, 10),
          left(p_message, 2000), left(p_stack, 8000));
  -- Keep it a diagnostic buffer, not a table that grows for ever.
  delete from app_errors where created_at < now() - interval '30 days';
end $function$;

revoke all on function public.log_app_error(text, text, text, text, text) from public;
grant execute on function public.log_app_error(text, text, text, text, text) to anon, authenticated;
