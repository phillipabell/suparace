-- SupaRace schema: a claim queue (jobs) and a balance (wallets). Same shape covers stock counts.
create schema if not exists suparace_private;

create table if not exists public.jobs (
  id         bigint generated always as identity primary key,
  status     text not null default 'pending' check (status in ('pending','claimed')),
  claimed_by text,
  claimed_at timestamptz
);
create index if not exists jobs_pending_idx on public.jobs (id) where status = 'pending';

create table if not exists public.wallets (
  id      int primary key,
  balance int not null          -- deliberately NO check (balance >= 0): the naive client must be able to fail
);

-- RLS on with no policies: anon/authenticated see nothing; the harness uses service_role (bypasses RLS).
alter table public.jobs    enable row level security;
alter table public.wallets enable row level security;

-- pgmq queue for fix (c)
create extension if not exists pgmq;
do $$ begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'suparace_jobs') then
    perform pgmq.create('suparace_jobs');
  end if;
end $$;

-- Reset: n pending jobs, n pgmq messages, wallet 1 with the given balance.
create or replace function public.suparace_reset(n_jobs int, start_balance int)
returns void language plpgsql security definer set search_path = public, pgmq as $$
begin
  truncate public.jobs restart identity;
  insert into public.jobs (status) select 'pending' from generate_series(1, n_jobs);
  perform pgmq.purge_queue('suparace_jobs');
  perform pgmq.send_batch('suparace_jobs', array(select jsonb_build_object('job', g) from generate_series(1, n_jobs) g));
  insert into public.wallets (id, balance) values (1, start_balance)
    on conflict (id) do update set balance = excluded.balance;
end $$;

-- ---------- FIXES ----------

-- (a) claim: one atomic UPDATE ... WHERE status='pending' RETURNING.
-- The status re-check in the outer WHERE is what blocks the double claim: a second writer waits on the row lock,
-- re-reads it after the first commits, sees 'claimed', and updates nothing.
create or replace function public.claim_job_atomic(worker text)
returns bigint language sql security definer set search_path = public as $$
  update public.jobs set status = 'claimed', claimed_by = worker, claimed_at = now()
  where id = (select id from public.jobs where status = 'pending' order by id limit 1)
    and status = 'pending'
  returning id;
$$;

-- (b) claim: FOR UPDATE SKIP LOCKED. Each caller locks a different pending row; nobody waits, nobody collides.
create or replace function public.claim_job_skip_locked(worker text)
returns bigint language sql security definer set search_path = public as $$
  update public.jobs set status = 'claimed', claimed_by = worker, claimed_at = now()
  where id = (select id from public.jobs where status = 'pending'
              order by id for update skip locked limit 1)
  returning id;
$$;

-- (c) claim: pgmq. pop() reads and deletes one message in one statement (pgmq uses SKIP LOCKED inside).
create or replace function public.claim_job_pgmq(worker text)
returns bigint language sql security definer set search_path = public, pgmq as $$
  select (message->>'job')::bigint from pgmq.pop('suparace_jobs');
$$;

-- (a) spend: conditional decrement. Returns new balance, or NULL when funds are short.
create or replace function public.spend_atomic(wallet int, amount int)
returns int language sql security definer set search_path = public as $$
  update public.wallets set balance = balance - amount
  where id = wallet and balance >= amount
  returning balance;
$$;

-- (b) spend: lock the row with FOR UPDATE, check, then write, inside one function (one transaction).
create or replace function public.spend_locked(wallet int, amount int)
returns int language plpgsql security definer set search_path = public as $$
declare b int;
begin
  select balance into b from public.wallets where id = wallet for update;
  if b is null or b < amount then return null; end if;
  update public.wallets set balance = b - amount where id = wallet;
  return b - amount;
end $$;

-- Only service_role may call these (the harness). Supabase grants EXECUTE to anon by default; take it back.
revoke execute on function public.suparace_reset(int,int), public.claim_job_atomic(text), public.claim_job_skip_locked(text),
  public.claim_job_pgmq(text), public.spend_atomic(int,int), public.spend_locked(int,int) from public, anon, authenticated;
grant execute on function public.suparace_reset(int,int), public.claim_job_atomic(text), public.claim_job_skip_locked(text),
  public.claim_job_pgmq(text), public.spend_atomic(int,int), public.spend_locked(int,int) to service_role;

notify pgrst, 'reload schema';
