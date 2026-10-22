// The fixes: one RPC call, the read-check-write happens inside Postgres in one statement or one transaction.
import type { SupabaseClient } from '@supabase/supabase-js';

async function rpcNum(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<number | null> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data ?? null;
}
export const claimJobAtomic     = (sb: SupabaseClient, worker: string) => rpcNum(sb, 'claim_job_atomic', { worker });
export const claimJobSkipLocked = (sb: SupabaseClient, worker: string) => rpcNum(sb, 'claim_job_skip_locked', { worker });
export const claimJobPgmq       = (sb: SupabaseClient, worker: string) => rpcNum(sb, 'claim_job_pgmq', { worker });
export const spendAtomic = (sb: SupabaseClient, wallet: number, amount: number) => rpcNum(sb, 'spend_atomic', { wallet, amount });
export const spendLocked = (sb: SupabaseClient, wallet: number, amount: number) => rpcNum(sb, 'spend_locked', { wallet, amount });
