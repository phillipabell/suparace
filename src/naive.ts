// The bug: read, decide in the client, then write. supabase-js has no client transaction to hold these together.
import type { SupabaseClient } from '@supabase/supabase-js';

export async function claimJobNaive(sb: SupabaseClient, worker: string): Promise<number | null> {
  const { data, error } = await sb.from('jobs').select('id').eq('status', 'pending').order('id').limit(1);
  if (error) throw error;
  if (!data.length) return null;
  const id = data[0].id as number;
  // Another client can read the same "pending" row between our select and this update.
  const { error: e2 } = await sb.from('jobs').update({ status: 'claimed', claimed_by: worker }).eq('id', id);
  if (e2) throw e2;
  return id;
}

// obs (optional, --score mode): records each HTTP status and the balance each read saw, and writes a ledger row
// per approved spend, the way a real app records a purchase.
export type SpendObs = { statuses: number[]; reads: number[] };
export async function spendNaive(sb: SupabaseClient, wallet: number, amount: number, obs?: SpendObs): Promise<number | null> {
  const { data, error, status } = await sb.from('wallets').select('balance').eq('id', wallet).single();
  obs?.statuses.push(status);
  if (error) throw error;
  obs?.reads.push(data.balance);
  if (data.balance < amount) return null;
  // Writes a value computed from a read that may already be stale: lost update + overspend.
  const { error: e2, status: s2 } = await sb.from('wallets').update({ balance: data.balance - amount }).eq('id', wallet);
  obs?.statuses.push(s2);
  if (e2) throw e2;
  if (obs) {
    const { error: e3, status: s3 } = await sb.from('spend_ledger').insert({ wallet, amount });
    obs.statuses.push(s3);
    if (e3) throw e3;
  }
  return data.balance - amount;
}
