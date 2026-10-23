-- SupaRace transfer scenario: move money between two wallets. Remove with sql/005_transfer_drop.sql.
-- Invariants: total money constant, no balance below 0.
-- Separate table from public.wallets so the spend scenarios are untouched.
create table if not exists public.transfer_wallets (
  id      int primary key,
  balance int not null          -- deliberately NO check (balance >= 0): the naive client must be able to fail
);
alter table public.transfer_wallets enable row level security;   -- no policies: service_role only

-- Reset: wallets 1..n_wallets, each with start_balance.
create or replace function public.suparace_transfer_reset(n_wallets int, start_balance int)
returns void language plpgsql security definer set search_path = public as $$
begin
  truncate public.transfer_wallets;
  insert into public.transfer_wallets (id, balance) select g, start_balance from generate_series(1, n_wallets) g;
end $$;

-- Naive lock: FOR UPDATE on src, then on dst, in the caller's order. Race-safe, but two opposite transfers
-- (A->B and B->A) can each hold one row and wait for the other: Postgres aborts one with 40P01 deadlock_detected.
-- pause_ms simulates work between the two locks (a fraud check, a second query) and widens the window.
create or replace function public.transfer_unordered(src int, dst int, amount int, pause_ms int default 0)
returns int language plpgsql security definer set search_path = public as $$
declare b int;
begin
  if src is null or dst is null or amount is null or src = dst or amount <= 0 then return null; end if;
  select balance into b from public.transfer_wallets where id = src for update;
  if pause_ms > 0 then perform pg_sleep(pause_ms / 1000.0); end if;
  perform 1 from public.transfer_wallets where id = dst for update;
  if not found or b is null or b < amount then return null; end if;
  update public.transfer_wallets set balance = balance - amount where id = src;
  update public.transfer_wallets set balance = balance + amount where id = dst;
  return b - amount;
end $$;

-- The fix: lock BOTH rows in one statement, in id order, then check and write. Every caller takes locks in the
-- same global order, so no cycle can form; same pause_ms hook (after both locks) for a fair comparison.
-- Only holds if EVERY code path that locks two wallets uses the same order (a plain multi-row UPDATE or another
-- function locking src-then-dst can still deadlock against it). Under READ COMMITTED the re-select after the lock
-- sees the latest committed balance.
create or replace function public.transfer_ordered(src int, dst int, amount int, pause_ms int default 0)
returns int language plpgsql security definer set search_path = public as $$
declare b int; locked int;
begin
  -- reject self-transfers, non-positive and NULL amounts (a NULL comparison would fall through the check below)
  if src is null or dst is null or amount is null or src = dst or amount <= 0 then return null; end if;
  perform 1 from public.transfer_wallets where id in (src, dst) order by id for update;
  get diagnostics locked = row_count;
  if locked <> 2 then return null; end if;   -- a missing wallet would make the dst UPDATE a no-op: money destroyed
  if pause_ms > 0 then perform pg_sleep(pause_ms / 1000.0); end if;
  select balance into b from public.transfer_wallets where id = src;
  if b is null or b < amount then return null; end if;
  update public.transfer_wallets set balance = balance - amount where id = src;
  update public.transfer_wallets set balance = balance + amount where id = dst;
  return b - amount;
end $$;

-- Deadlocks Postgres detected in this database so far (pg_stat_database). The harness reads it before and after a
-- run, because a deadlock does not always reach the client as an error (see README).
create or replace function public.suparace_deadlocks()
returns bigint language sql security definer set search_path = public as $$
  select deadlocks from pg_stat_database where datname = current_database();
$$;

revoke execute on function public.suparace_deadlocks() from public, anon, authenticated;
grant execute on function public.suparace_deadlocks() to service_role;
revoke execute on function public.suparace_transfer_reset(int,int), public.transfer_unordered(int,int,int,int),
  public.transfer_ordered(int,int,int,int) from public, anon, authenticated;
grant execute on function public.suparace_transfer_reset(int,int), public.transfer_unordered(int,int,int,int),
  public.transfer_ordered(int,int,int,int) to service_role;

notify pgrst, 'reload schema';
