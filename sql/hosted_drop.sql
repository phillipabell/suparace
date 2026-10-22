drop function if exists public.suparace_reset(int,int), public.suparace_claim_job_skip_locked(text), public.suparace_spend_atomic(int,int);
drop table if exists public.suparace_jobs, public.suparace_wallets;
notify pgrst, 'reload schema';
