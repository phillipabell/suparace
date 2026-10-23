-- Crash-safe pgmq race (src/crash.ts). Workers drain a queue; some "crash" holding a job (never finish it), some
-- stall past the visibility timeout and finish late.
-- crash_done:    one row per finished job (primary key = job id): "the job is done".
-- crash_effects: the handler's side effect, one row per time a handler actually ran it. Deliberately no unique
--   constraint: it records double completion instead of blocking it.
create extension if not exists pgmq;
do $$ begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'suparace_crash') then
    perform pgmq.create('suparace_crash');
  end if;
end $$;
create table if not exists public.crash_done (
  job    bigint primary key,
  worker text not null,
  at     timestamptz not null default now()
);
create table if not exists public.crash_effects (
  id     bigint generated always as identity primary key,
  job    bigint not null,
  worker text not null,
  at     timestamptz not null default now()
);
alter table public.crash_done    enable row level security;
alter table public.crash_effects enable row level security;
revoke all on public.crash_done, public.crash_effects from anon, authenticated;

-- n jobs in the queue, empty archive and result tables.
create or replace function public.crash_reset(n_jobs int)
returns void language plpgsql security definer set search_path = public, pgmq as $$
begin
  perform pgmq.purge_queue('suparace_crash');
  truncate pgmq.a_suparace_crash;
  truncate public.crash_done;
  truncate public.crash_effects restart identity;
  perform pgmq.send_batch('suparace_crash', array(select jsonb_build_object('job', g) from generate_series(1, n_jobs) g));
end $$;

-- The bug: pop() reads and deletes in one statement. A worker that dies after pop loses the job for good.
create or replace function public.crash_pop()
returns table (msg_id bigint, job bigint) language sql security definer set search_path = public, pgmq as $$
  select msg_id, (message->>'job')::bigint from pgmq.pop('suparace_crash');
$$;

-- The fix: read() hides the message for p_vt seconds instead of deleting it. If the worker dies, the message
-- becomes visible again and another worker gets it (read_ct goes up).
create or replace function public.crash_read(p_vt int)
returns table (msg_id bigint, job bigint) language sql security definer set search_path = public, pgmq as $$
  select msg_id, (message->>'job')::bigint from pgmq.read('suparace_crash', p_vt, 1);
$$;

-- Finish a job: side effect + archive in one transaction. p_idem = true: the side effect runs only if this call
-- is the first to finish the job (insert ... on conflict do nothing returning). p_idem = false: the side effect
-- always runs, so a worker that stalled past vt and a redelivered worker both apply it.
-- archive() on a popped (already deleted) message just returns false.
create or replace function public.crash_complete(p_msg_id bigint, p_job bigint, p_worker text, p_idem boolean)
returns boolean language plpgsql security definer set search_path = public, pgmq as $$
declare got bigint;
begin
  insert into public.crash_done (job, worker) values (p_job, p_worker)
    on conflict (job) do nothing
    returning job into got;
  if got is not null or not p_idem then
    insert into public.crash_effects (job, worker) values (p_job, p_worker);
  end if;
  perform pgmq.archive('suparace_crash', p_msg_id);
  return got is not null;
end $$;

-- Messages still in the queue, visible or not (a crashed worker's message is invisible until vt runs out).
create or replace function public.crash_queue_len()
returns bigint language sql security definer set search_path = public, pgmq as $$
  select count(*) from pgmq.q_suparace_crash;
$$;

-- Archived messages that were read more than once (= redelivered after a vt ran out).
create or replace function public.crash_redelivered()
returns bigint language sql security definer set search_path = public, pgmq as $$
  select count(*) from pgmq.a_suparace_crash where read_ct > 1;
$$;

revoke execute on function public.crash_reset(int), public.crash_pop(), public.crash_read(int),
  public.crash_complete(bigint,bigint,text,boolean), public.crash_queue_len(), public.crash_redelivered()
  from public, anon, authenticated;
grant execute on function public.crash_reset(int), public.crash_pop(), public.crash_read(int),
  public.crash_complete(bigint,bigint,text,boolean), public.crash_queue_len(), public.crash_redelivered()
  to service_role;
grant select on public.crash_done, public.crash_effects to service_role;
notify pgrst, 'reload schema';
