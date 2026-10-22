drop function if exists public.rls_reset(uuid,uuid,int,int), public.rls_spend_invoker(int,int), public.rls_spend_locked_invoker(int,int),
  public.rls_spend_definer(int,int), public.rls_spend_definer_checked(int,int), public.rls_claim_invoker(),
  public.rls_claim_definer(), public.rls_claim_definer_checked();
drop table if exists public.rls_wallets, public.rls_jobs;
