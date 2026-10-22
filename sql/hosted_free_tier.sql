-- Hosted free-tier variant. Everything is prefixed suparace_ so it cannot collide with the
-- project's own tables, and sql/hosted_drop.sql removes all of it. Tables live in public with a prefix because
-- hosted PostgREST only exposes the schemas set in the dashboard (public by default).
-- Only the anon key was available, so the harness runs as anon: these grants/policies open ONLY suparace_ objects
-- to anon, for the minutes the test runs, then everything is dropped.
create table public.suparace_jobs (
  id bigint generated always as identity primary key,
  status text not null default 'pending' check (status in ('pending','claimed')),
  claimed_by text, claimed_at timestamptz);
create index suparace_jobs_pending_idx on public.suparace_jobs (id) where status = 'pending';
create table public.suparace_wallets (id int primary key, balance int not null);
alter table public.suparace_jobs enable row level security;
alter table public.suparace_wallets enable row level security;
create policy suparace_anon_all on public.suparace_jobs for all to anon using (true) with check (true);
create policy suparace_anon_all on public.suparace_wallets for all to anon using (true) with check (true);
grant select, insert, update on public.suparace_jobs, public.suparace_wallets to anon;

create function public.suparace_reset(n_jobs int, start_balance int)
returns void language plpgsql security definer set search_path = public as $$
begin
  truncate public.suparace_jobs restart identity;
  insert into public.suparace_jobs (status) select 'pending' from generate_series(1, n_jobs);
  insert into public.suparace_wallets (id, balance) values (1, start_balance)
    on conflict (id) do update set balance = excluded.balance;
end $$;
create function public.suparace_claim_job_skip_locked(worker text)
returns bigint language sql security definer set search_path = public as $$
  update public.suparace_jobs set status = 'claimed', claimed_by = worker, claimed_at = now()
  where id = (select id from public.suparace_jobs where status = 'pending'
              order by id for update skip locked limit 1)
  returning id; $$;
create function public.suparace_spend_atomic(wallet int, amount int)
returns int language sql security definer set search_path = public as $$
  update public.suparace_wallets set balance = balance - amount
  where id = wallet and balance >= amount returning balance; $$;
revoke execute on function public.suparace_reset(int,int), public.suparace_claim_job_skip_locked(text),
  public.suparace_spend_atomic(int,int) from public, authenticated;
grant execute on function public.suparace_reset(int,int), public.suparace_claim_job_skip_locked(text),
  public.suparace_spend_atomic(int,int) to anon;
notify pgrst, 'reload schema';
