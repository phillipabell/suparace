-- Removes the crash-safe pgmq race schema (sql/007_crash.sql).
drop function if exists public.crash_reset(int);
drop function if exists public.crash_pop();
drop function if exists public.crash_read(int);
drop function if exists public.crash_complete(bigint,bigint,text,boolean);
drop function if exists public.crash_queue_len();
drop function if exists public.crash_redelivered();
drop table if exists public.crash_effects;
drop table if exists public.crash_done;
do $$ begin
  if exists (select 1 from pgmq.list_queues() where queue_name = 'suparace_crash') then
    perform pgmq.drop_queue('suparace_crash');
  end if;
end $$;
notify pgrst, 'reload schema';
