-- SupaRace quickstart schema. Paste into the SQL editor (or psql) of a project you are allowed to break.
-- Everything is prefixed suparace_ so it cannot collide with your tables. Remove it with the drop block at the end.
create table if not exists public.suparace_wallets (id int primary key, balance int not null);
-- RLS on with no policies: only the service_role key (which bypasses RLS) can touch this table.
alter table public.suparace_wallets enable row level security;

-- The fix: check and decrement in ONE statement. Postgres re-checks "balance >= p_amount" on the locked row,
-- so concurrent callers cannot both spend the last credit. Returns the new balance, or null when refused.
create or replace function public.suparace_spend(p_wallet int, p_amount int) returns int
language sql as $$
  update public.suparace_wallets set balance = balance - p_amount
  where id = p_wallet and balance >= p_amount
  returning balance
$$;
revoke execute on function public.suparace_spend(int, int) from public, anon, authenticated;
grant execute on function public.suparace_spend(int, int) to service_role;
notify pgrst, 'reload schema';

-- Clean up when done:
-- drop function if exists public.suparace_spend(int, int); drop table if exists public.suparace_wallets;
