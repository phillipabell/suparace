create or replace function public.suparace_queue_len() returns bigint language sql security definer set search_path = public, pgmq as $$
  select queue_length from pgmq.metrics('suparace_jobs');
$$;
revoke execute on function public.suparace_queue_len() from public, anon, authenticated;
grant execute on function public.suparace_queue_len() to service_role;
notify pgrst, 'reload schema';
