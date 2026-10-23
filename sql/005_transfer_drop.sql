drop function if exists public.transfer_ordered(int,int,int,int), public.transfer_unordered(int,int,int,int),
  public.suparace_transfer_reset(int,int), public.suparace_deadlocks();
drop table if exists public.transfer_wallets;
notify pgrst, 'reload schema';
