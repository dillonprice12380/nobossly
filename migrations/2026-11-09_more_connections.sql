-- Applied live 2026-11-09 (run in the SQL Editor; returned true. Verified: bank_connections and bank_transactions with RLS on, the four providers, account_label and meta, expenses.external_id; members cannot run payment_connection_store or bank_connection_secret or read sync_cursor; anon cannot read the inbox).
--
-- More connections for the income log (2026-11-09), beside Stripe
-- (migrations/2026-11-08_stripe_connection.sql):
--
--  * Shopify, Gumroad and Square sit in payment_connections, one each per
--    member. Shopify uses the member's own read-only Dev Dashboard app (client
--    ID and secret); Gumroad and Square use "Connect with…" (OAuth, read-only
--    scopes). Their secrets go in Supabase Vault like Stripe's. The server
--    verifies what the member gave it, then stores it with
--    payment_connection_store(), which only the service role may call.
--  * Banks, through Plaid, sit in bank_connections: a member can connect up to
--    five. A bank account mixes business and personal money, so its
--    transactions are never logged on their own. They land in
--    bank_transactions, an inbox the member goes through: income, expense or
--    not business.
--  * expenses.external_id ties an expense to the bank transaction it came
--    from, so the same transaction cannot be logged twice.

begin;

-- 1. More providers on payment_connections ---------------------------------
alter table public.payment_connections drop constraint if exists payment_connections_provider_check;
alter table public.payment_connections add constraint payment_connections_provider_check
  check (provider in ('stripe', 'shopify', 'gumroad', 'square'));
alter table public.payment_connections add column if not exists account_label text
  check (account_label is null or char_length(account_label) <= 80);
alter table public.payment_connections add column if not exists meta jsonb
  check (meta is null or (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 2000));
grant select (account_label) on public.payment_connections to authenticated;

-- The server stores (or replaces) a connection's secret once it has checked it.
create or replace function public.payment_connection_store(p_user uuid, p_provider text, p_secret text, p_label text, p_meta jsonb)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  conn public.payment_connections;
  sid uuid;
  s text := coalesce(p_secret, '');
begin
  if p_provider not in ('shopify', 'gumroad', 'square') then raise exception 'unknown provider'; end if;
  if char_length(s) < 8 or char_length(s) > 4000 then raise exception 'that secret does not look right'; end if;
  select * into conn from public.payment_connections where user_id = p_user and provider = p_provider for update;
  if found and conn.secret_id is not null then
    perform vault.update_secret(conn.secret_id, s);
    sid := conn.secret_id;
  else
    sid := vault.create_secret(s, 'payment_connection_' || p_provider || '_' || p_user::text, 'Read-only ' || p_provider || ' access for a NoBossly member');
  end if;
  insert into public.payment_connections (user_id, provider, key_hint, account_label, meta, secret_id, status, last_error)
  values (p_user, p_provider, null, left(p_label, 80), p_meta, sid, 'active', null)
  on conflict (user_id, provider) do update
    set account_label = excluded.account_label, meta = excluded.meta, secret_id = excluded.secret_id, status = 'active', last_error = null
  returning id into conn.id;
  return conn.id;
end $function$;
revoke all on function public.payment_connection_store(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_connection_store(uuid, text, text, text, jsonb) to service_role;

-- 2. Banks (Plaid) ---------------------------------------------------------
create table if not exists public.bank_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  provider       text not null default 'plaid' check (provider in ('plaid')),
  item_id        text not null unique check (char_length(item_id) <= 120),
  institution    text check (institution is null or char_length(institution) <= 120),
  accounts       jsonb check (accounts is null or (jsonb_typeof(accounts) = 'array' and pg_column_size(accounts) <= 4000)),
  secret_id      uuid,
  status         text not null default 'active' check (status in ('active', 'error')),
  last_error     text check (last_error is null or char_length(last_error) <= 300),
  last_synced_at timestamptz,
  sync_cursor    text check (sync_cursor is null or char_length(sync_cursor) <= 2000),
  created_at     timestamptz not null default now()
);
create index if not exists bank_connections_owner on public.bank_connections (user_id);
alter table public.bank_connections enable row level security;
revoke all on public.bank_connections from anon, authenticated;
grant select, insert, update, delete on public.bank_connections to service_role;
grant select (id, user_id, provider, institution, accounts, status, last_error, last_synced_at, created_at)
  on public.bank_connections to authenticated;
drop policy if exists bank_connections_own on public.bank_connections;
create policy bank_connections_own on public.bank_connections for select to authenticated using (user_id = auth.uid());

create or replace function public.bank_connection_store(p_user uuid, p_item text, p_institution text, p_accounts jsonb, p_token text)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  c public.bank_connections;
  sid uuid;
begin
  if coalesce(p_token, '') !~ '^access-[a-z]+-[A-Za-z0-9-]{8,200}$' then raise exception 'that access token does not look right'; end if;
  select * into c from public.bank_connections where item_id = p_item for update;
  if found and c.user_id <> p_user then raise exception 'that bank is connected to another member'; end if;
  if not found and (select count(*) from public.bank_connections where user_id = p_user) >= 5 then
    raise exception 'five banks at most';
  end if;
  if found and c.secret_id is not null then
    perform vault.update_secret(c.secret_id, p_token);
    sid := c.secret_id;
  else
    sid := vault.create_secret(p_token, 'bank_connection_' || p_item, 'Read-only bank access for a NoBossly member');
  end if;
  insert into public.bank_connections (user_id, item_id, institution, accounts, secret_id, status, last_error)
  values (p_user, p_item, left(p_institution, 120), p_accounts, sid, 'active', null)
  on conflict (item_id) do update
    set institution = excluded.institution, accounts = excluded.accounts, secret_id = excluded.secret_id, status = 'active', last_error = null
  returning id into c.id;
  return c.id;
end $function$;

create or replace function public.bank_connection_secret(p_id uuid)
returns text language sql security definer set search_path to 'public'
as $function$
  select s.decrypted_secret from vault.decrypted_secrets s
    join public.bank_connections c on c.secret_id = s.id
   where c.id = p_id
$function$;

-- A member disconnects a bank: the token leaves the Vault; what they already
-- logged stays, and the inbox items still waiting go.
create or replace function public.bank_disconnect(p_id uuid)
returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  c public.bank_connections;
begin
  if uid is null then raise exception 'sign in first'; end if;
  select * into c from public.bank_connections where id = p_id and user_id = uid for update;
  if not found then return false; end if;
  if c.secret_id is not null then delete from vault.secrets where id = c.secret_id; end if;
  delete from public.bank_transactions where connection_id = c.id and status = 'new';
  delete from public.bank_connections where id = c.id;
  return true;
end $function$;

revoke all on function public.bank_connection_store(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.bank_connection_secret(uuid) from public, anon, authenticated;
revoke all on function public.bank_disconnect(uuid) from public, anon;
grant execute on function public.bank_connection_store(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.bank_connection_secret(uuid) to service_role;
grant execute on function public.bank_disconnect(uuid) to authenticated;

-- 3. The bank inbox ---------------------------------------------------------
create table if not exists public.bank_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  connection_id uuid references public.bank_connections(id) on delete set null,
  external_id   text not null check (char_length(external_id) <= 120),
  posted_on     date not null,
  amount        numeric(12,2) not null check (amount > 0 and amount <= 100000000),
  direction     text not null check (direction in ('in', 'out')),
  name          text check (name is null or char_length(name) <= 200),
  merchant      text check (merchant is null or char_length(merchant) <= 120),
  category      text check (category is null or char_length(category) <= 80),
  account_label text check (account_label is null or char_length(account_label) <= 80),
  pending       boolean not null default false,
  status        text not null default 'new' check (status in ('new', 'income', 'expense', 'ignored')),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, external_id)
);
create index if not exists bank_transactions_inbox on public.bank_transactions (user_id, status, posted_on desc);
alter table public.bank_transactions enable row level security;
revoke all on public.bank_transactions from anon, authenticated;
grant select, insert, update, delete on public.bank_transactions to service_role;
grant select on public.bank_transactions to authenticated;
grant update (status, decided_at) on public.bank_transactions to authenticated;
drop policy if exists bank_transactions_read on public.bank_transactions;
create policy bank_transactions_read on public.bank_transactions for select to authenticated using (user_id = auth.uid());
drop policy if exists bank_transactions_decide on public.bank_transactions;
create policy bank_transactions_decide on public.bank_transactions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 4. Expenses can say where they came from ---------------------------------
alter table public.expenses add column if not exists external_id text
  check (external_id is null or char_length(external_id) <= 120);
do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_external') then
    alter table public.expenses add constraint expenses_external unique (user_id, external_id);
  end if;
end $do$;

commit;

select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'payment_connections' and column_name in ('account_label', 'meta')) = 2
   and to_regclass('public.bank_connections') is not null
   and to_regclass('public.bank_transactions') is not null
   and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'external_id') = 1
   and not has_function_privilege('authenticated', 'public.bank_connection_secret(uuid)', 'execute')
   and not has_function_privilege('authenticated', 'public.payment_connection_store(uuid, text, text, text, jsonb)', 'execute') as ok;
