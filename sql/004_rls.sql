-- SupaRace RLS matrix: tenant-owned wallets and jobs, owner-only policies, and each fix in SECURITY INVOKER and
-- SECURITY DEFINER form (definer unchecked = the common mistake, definer checked = owner test inside the function).
-- Remove with sql/004_rls_drop.sql.

create table if not exists public.rls_wallets (
  id      int primary key,
  owner   uuid not null,
  balance int not null          -- no check (balance >= 0), same as v0.1: the naive client must be able to fail
);
create table if not exists public.rls_jobs (
  id         bigint generated always as identity primary key,
  owner      uuid not null,
  status     text not null default 'pending' check (status in ('pending','claimed')),
  claimed_by uuid,
  claimed_at timestamptz
);
create index if not exists rls_jobs_pending_idx on public.rls_jobs (owner, id) where status = 'pending';

alter table public.rls_wallets enable row level security;
alter table public.rls_jobs    enable row level security;
revoke all on public.rls_wallets, public.rls_jobs from anon;
grant select, update on public.rls_wallets, public.rls_jobs to authenticated;

drop policy if exists own_select on public.rls_wallets;
drop policy if exists own_update on public.rls_wallets;
drop policy if exists own_select on public.rls_jobs;
drop policy if exists own_update on public.rls_jobs;
create policy own_select on public.rls_wallets for select to authenticated using (owner = (select auth.uid()));
create policy own_update on public.rls_wallets for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy own_select on public.rls_jobs for select to authenticated using (owner = (select auth.uid()));
create policy own_update on public.rls_jobs for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- Reset: wallet 1 owned by a, wallet 2 owned by b, each with start_balance; n_each pending jobs per owner.
create or replace function public.rls_reset(a uuid, b uuid, n_each int, start_balance int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  truncate public.rls_jobs restart identity;
  insert into public.rls_jobs (owner) select a from generate_series(1, n_each);
  insert into public.rls_jobs (owner) select b from generate_series(1, n_each);
  insert into public.rls_wallets (id, owner, balance) values (1, a, start_balance), (2, b, start_balance)
    on conflict (id) do update set owner = excluded.owner, balance = excluded.balance;
end $$;

-- ---------- spend ----------
create or replace function public.rls_spend_invoker(wallet int, amount int)
returns int language sql security invoker set search_path = '' as $$
  update public.rls_wallets set balance = balance - amount where id = wallet and balance >= amount returning balance;
$$;
create or replace function public.rls_spend_locked_invoker(wallet int, amount int)
returns int language plpgsql security invoker set search_path = '' as $$
declare b int;
begin
  select balance into b from public.rls_wallets where id = wallet for update;
  if b is null or b < amount then return null; end if;
  update public.rls_wallets set balance = b - amount where id = wallet;
  return b - amount;
end $$;
create or replace function public.rls_spend_definer(wallet int, amount int)
returns int language sql security definer set search_path = '' as $$
  update public.rls_wallets set balance = balance - amount where id = wallet and balance >= amount returning balance;
$$;
create or replace function public.rls_spend_definer_checked(wallet int, amount int)
returns int language sql security definer set search_path = '' as $$
  update public.rls_wallets set balance = balance - amount
  where id = wallet and balance >= amount and owner = (select auth.uid()) returning balance;
$$;

-- ---------- claim (SKIP LOCKED) ----------
create or replace function public.rls_claim_invoker()
returns bigint language sql security invoker set search_path = '' as $$
  update public.rls_jobs set status = 'claimed', claimed_by = (select auth.uid()), claimed_at = now()
  where id = (select id from public.rls_jobs where status = 'pending' order by id for update skip locked limit 1)
  returning id;
$$;
create or replace function public.rls_claim_definer()
returns bigint language sql security definer set search_path = '' as $$
  update public.rls_jobs set status = 'claimed', claimed_by = (select auth.uid()), claimed_at = now()
  where id = (select id from public.rls_jobs where status = 'pending' order by id for update skip locked limit 1)
  returning id;
$$;
create or replace function public.rls_claim_definer_checked()
returns bigint language sql security definer set search_path = '' as $$
  update public.rls_jobs set status = 'claimed', claimed_by = (select auth.uid()), claimed_at = now()
  where id = (select id from public.rls_jobs where status = 'pending' and owner = (select auth.uid())
              order by id for update skip locked limit 1)
  returning id;
$$;

do $$ declare f text; begin
  foreach f in array array['rls_spend_invoker(int,int)','rls_spend_locked_invoker(int,int)','rls_spend_definer(int,int)',
    'rls_spend_definer_checked(int,int)','rls_claim_invoker()','rls_claim_definer()','rls_claim_definer_checked()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.rls_reset(uuid,uuid,int,int) from public, anon, authenticated;
grant execute on function public.rls_reset(uuid,uuid,int,int) to service_role;
