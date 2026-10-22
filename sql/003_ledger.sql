-- Spend ledger for the response-only vs invariant scoring test (--score). One row per approved spend.
create table if not exists public.spend_ledger (
  id     bigint generated always as identity primary key,
  wallet int not null,
  amount int not null,
  at     timestamptz not null default now()
);
alter table public.spend_ledger enable row level security;

create or replace function public.suparace_reset(n_jobs int, start_balance int)
returns void language plpgsql security definer set search_path = public, pgmq as $$
begin
  truncate public.jobs restart identity;
  truncate public.spend_ledger restart identity;
  insert into public.jobs (status) select 'pending' from generate_series(1, n_jobs);
  perform pgmq.purge_queue('suparace_jobs');
  perform pgmq.send_batch('suparace_jobs', array(select jsonb_build_object('job', g) from generate_series(1, n_jobs) g));
  insert into public.wallets (id, balance) values (1, start_balance)
    on conflict (id) do update set balance = excluded.balance;
end $$;
revoke execute on function public.suparace_reset(int,int) from public, anon, authenticated;
grant execute on function public.suparace_reset(int,int) to service_role;
notify pgrst, 'reload schema';
