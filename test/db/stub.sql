do $$ begin create role anon; exception when duplicate_object then null; end $$; do $$ begin create role authenticated; exception when duplicate_object then null; end $$; do $$ begin create role service_role; exception when duplicate_object then null; end $$;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth, public to anon, authenticated;
create table profiles(id uuid primary key, is_admin bool default false, onboarding_completed bool default true, account_status text default 'active', last_active_at timestamptz, help_offer text[] default '{}', help_need text[] default '{}', display_name text, username text);
create function is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false) $$;
create function is_admin_user() returns boolean language sql stable security definer set search_path to 'public' as $$ select public.is_admin() $$;
create table groups(id uuid primary key default gen_random_uuid(), name text not null, slug text unique not null, description text, owner_id uuid references profiles on delete cascade, created_at timestamptz default now());
create table group_members(group_id uuid references groups on delete cascade, user_id uuid references profiles on delete cascade, role text not null default 'member' check (role in ('owner','member')), joined_at timestamptz default now(), primary key(group_id,user_id));
create table group_posts(id uuid primary key default gen_random_uuid(), group_id uuid references groups on delete cascade, user_id uuid references profiles, body text not null, created_at timestamptz default now());
create table notifications(id uuid primary key default gen_random_uuid(), user_id uuid, type text, actor_id uuid, entity_type text, entity_id uuid, message text, is_read bool, created_at timestamptz default now(), constraint notifications_type_check check (type is not null));
create table reports(id uuid primary key default gen_random_uuid(), target_type text, constraint reports_target_type_check check (true));
create table user_blocks(blocker_id uuid, blocked_id uuid, created_at timestamptz default now());
create table help_posts(id uuid primary key default gen_random_uuid(), author_id uuid, group_id uuid references groups, kind text, title text, body text, category text, status text default 'open', partner_id uuid, closed_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
create table help_responses(id uuid primary key default gen_random_uuid(), post_id uuid references help_posts, responder_id uuid, message text, status text default 'pending', created_at timestamptz default now());
create function contains_personal_info(text) returns boolean language sql as $$ select false $$;
create function touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
alter table groups enable row level security; alter table group_members enable row level security; alter table group_posts enable row level security; alter table help_posts enable row level security; alter table notifications enable row level security;
grant all on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
create table workspace_docs(id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles on delete cascade, kind text not null, title text, data jsonb not null default '{}', created_at timestamptz default now(), updated_at timestamptz default now());
alter table workspace_docs enable row level security;
create policy workspace_docs_own on workspace_docs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create table email_log(id uuid primary key default gen_random_uuid(), user_id uuid, to_email text, email_type text, subject text, status text, constraint email_log_email_type_check check (email_type is not null));
-- Challenges (the weekly community challenge, migrations/2026-11-08).
create table challenges(id uuid primary key default gen_random_uuid(), slug text unique, title text, description text, emoji text, challenge_type text, xp_reward integer, badge_id uuid, criteria jsonb, starts_at timestamptz, ends_at timestamptz, is_active boolean default true, position smallint, created_at timestamptz default now(), is_cohort boolean default false, requires_proof boolean default false, min_level integer default 1, max_level integer default 10);
create table cohort_waitlist(user_id uuid not null, cohort_id uuid not null references challenges(id) on delete cascade, created_at timestamptz not null default now(), primary key (user_id, cohort_id));
insert into challenges(slug, title, description, emoji, is_cohort, starts_at, ends_at) values
  ('weekly-cohort-2026-11-02', 'Weekly Sprint Cohort — week of Nov 2', 'Start a 7-day sprint on Monday alongside everyone else in the cohort. Pick one thing that moves your business forward, break it into tasks, and check in as you go.', '🏃', true, '2026-11-02', '2026-11-09'),
  ('validate', 'Validate your idea', 'Curated quest.', '🔬', false, null, null);
-- Supabase Vault, just enough of it (migrations/2026-11-08_stripe_connection.sql).
create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as $$ insert into vault.secrets(secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null) returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
revoke all on schema vault from public;
-- The income log (revenue_entries), as live.
create table if not exists revenue_entries(id uuid primary key default gen_random_uuid(), user_id uuid references profiles on delete cascade, entry_type text default 'revenue', amount numeric, currency text, entry_date date, source text, description text, is_recurring boolean default false, created_at timestamptz default now(), updated_at timestamptz default now());
alter table revenue_entries enable row level security;
create policy revenue_own on revenue_entries for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on revenue_entries to authenticated;
alter role service_role bypassrls;  -- as on Supabase
-- The Q&A forum, as live (2026-11-08): anyone reads, authors write their own.
create table forum_categories(id uuid primary key default gen_random_uuid(), slug text unique, name text, position int default 0, is_locked bool default false);
create table forum_threads(id uuid primary key default gen_random_uuid(), category_id uuid references forum_categories, user_id uuid references profiles on delete cascade, title text not null, body text, body_html text, tags text[] default '{}', is_pinned bool default false, is_locked bool default false, reply_count int default 0, view_count int default 0, last_reply_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(), edited_at timestamptz);
create table forum_replies(id uuid primary key default gen_random_uuid(), thread_id uuid references forum_threads on delete cascade, user_id uuid references profiles on delete cascade, body text, body_html text, created_at timestamptz default now(), updated_at timestamptz default now(), edited_at timestamptz);
alter table forum_threads enable row level security; alter table forum_replies enable row level security;
create policy forum_threads_read on forum_threads for select using (true);
create policy forum_threads_insert on forum_threads for insert with check (auth.uid() = user_id);
create policy forum_threads_update on forum_threads for update using (auth.uid() = user_id or is_admin());
create policy forum_threads_delete on forum_threads for delete using (auth.uid() = user_id or is_admin());
create policy forum_replies_read on forum_replies for select using (true);
create policy forum_replies_insert on forum_replies for insert with check (auth.uid() = user_id);
create policy forum_replies_update on forum_replies for update using (auth.uid() = user_id or is_admin());
create policy forum_replies_delete on forum_replies for delete using (auth.uid() = user_id or is_admin());
grant select, insert, update, delete on forum_categories, forum_threads, forum_replies to anon, authenticated;
-- Business expenses on the Money page, as live.
create table expenses(id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles on delete cascade, category text not null, amount numeric not null, note text, spent_at date not null default current_date, created_at timestamptz not null default now());
alter table expenses enable row level security;
create policy expenses_own on expenses for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on expenses to authenticated;
alter table profiles add column if not exists path text;
