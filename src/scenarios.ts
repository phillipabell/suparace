// The v0.1 claim and spend scenarios, ported onto the library (src/lib.ts). Same naive/fixed code, same counts.
// Schema: sql/001_schema.sql (+ 002_queue_len.sql; 003_ledger.sql for spendLedgerRace).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { defineRace, type Race } from './lib.ts';
import { claimJobNaive, spendNaive, type SpendObs } from './naive.ts';
import { claimJobAtomic, claimJobSkipLocked, claimJobPgmq, spendAtomic, spendLocked } from './fixed.ts';

export interface Target { url: string; key: string }
type ClaimFn = (sb: SupabaseClient, w: string) => Promise<number | null>;
type SpendFn = (sb: SupabaseClient, wallet: number, amt: number) => Promise<number | null>;

export const CLAIM: Record<string, ClaimFn> = { naive: claimJobNaive, atomic_update: claimJobAtomic, skip_locked: claimJobSkipLocked, pgmq: claimJobPgmq };
export const SPEND: Record<string, SpendFn> = { naive: spendNaive, conditional_update: spendAtomic, for_update: spendLocked };

const client = (t: Target) => createClient(t.url, t.key, { auth: { persistSession: false, autoRefreshToken: false } });

async function reset(admin: SupabaseClient, nJobs: number, balance: number) {
  const { error } = await admin.rpc('suparace_reset', { n_jobs: nJobs, start_balance: balance });
  if (error) throw error;
}
// warm-up: open each client's HTTP connection before timing, so cold starts don't count against any method
async function warmClient(t: Target) {
  const sb = client(t);
  await sb.from('wallets').select('id').limit(1);
  return sb;
}

/** N workers claim from a queue of pending jobs. Invariant: each job claimed once, none left pending. */
export function claimRace(t: Target, method: string): Race {
  const fn = CLAIM[method]; if (!fn) throw new Error(`unknown claim method ${method}`);
  const admin = client(t);
  return defineRace<{ left?: number }, SupabaseClient, number>({
    name: `claim:${method}`,
    expect: method === 'naive' ? 'violation' : 'clean',
    setup: async ({ items }) => { await reset(admin, items, 0); return {}; },
    worker: () => warmClient(t),
    actor: (sb, _c, i) => fn(sb, `w${i}`),
    measure: async (ctx, o) => {
      // pgmq claims don't touch the jobs table, so "left pending" comes from the queue for that method
      if (method === 'pgmq') { const { data } = await admin.rpc('suparace_queue_len'); ctx.left = Number(data); }
      else { const { count } = await admin.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'pending'); ctx.left = count ?? -1; }
      const distinct = new Set(o.successes).size;
      return { op: 'claim', method, distinct, violations: o.successes.length - distinct, left_unclaimed: ctx.left };
    },
    invariants: (ctx, o) => ({ claimed_once: new Set(o.successes).size === o.successes.length, none_left: ctx.left === 0 }),
  });
}

/** N workers spend 1 credit each from one wallet. Invariant: approvals <= start, balance >= 0, balance conserved, drained. */
export function spendRace(t: Target, method: string): Race {
  const fn = SPEND[method]; if (!fn) throw new Error(`unknown spend method ${method}`);
  const admin = client(t);
  return defineRace<{ start: number; final?: number }, SupabaseClient, number>({
    name: `spend:${method}`,
    expect: method === 'naive' ? 'violation' : 'clean',
    setup: async ({ items }) => { await reset(admin, 0, items); return { start: items }; },
    worker: () => warmClient(t),
    actor: (sb) => fn(sb, 1, 1),
    measure: async (ctx, o) => {
      const { data, error } = await admin.from('wallets').select('balance').eq('id', 1).single();
      if (error) throw error;
      const ok = o.successes.length, final = ctx.final = data.balance as number;
      return { op: 'spend', method, overspend: ok - ctx.start, final_balance: final, lost_updates: final - (ctx.start - ok),
               violations: Math.max(0, ok - ctx.start) };
    },
    invariants: (ctx, o) => ({ approved_le_start: o.successes.length <= ctx.start, balance_ge_0: ctx.final! >= 0,
      conserved: ctx.final === ctx.start - o.successes.length, drained: ctx.final === 0 }),
  });
}

/** v0.1 --score scenario: naive spend + a ledger row per approved spend, with response-level observations.
 *  Needs sql/003_ledger.sql. Run with score 'both' to see response-only vs invariant scoring side by side. */
export function spendLedgerRace(t: Target): Race {
  const admin = client(t);
  type Ctx = { start: number; obs: SpendObs; final?: number; rows?: number; sum?: number };
  return defineRace<Ctx, SupabaseClient, number>({
    name: 'spend-ledger:naive',
    expect: 'violation',
    setup: async ({ items }) => { await reset(admin, 0, items); return { start: items, obs: { statuses: [], reads: [] } }; },
    worker: () => warmClient(t),
    actor: (sb, ctx) => spendNaive(sb, 1, 1, ctx.obs),
    measure: async (ctx, o) => {
      const { data: w, error: e1 } = await admin.from('wallets').select('balance').eq('id', 1).single();
      const { data: led, error: e2 } = await admin.from('spend_ledger').select('amount');
      if (e1 || e2) throw e1 ?? e2;
      ctx.final = w.balance as number; ctx.rows = led.length; ctx.sum = led.reduce((a, r: any) => a + r.amount, 0);
      return { op: 'spend-ledger', method: 'naive', start: ctx.start, approved: o.successes.length,
        http_calls: ctx.obs.statuses.length, non2xx: ctx.obs.statuses.filter((s) => s < 200 || s > 299).length,
        neg_balance_returned: o.successes.filter((b) => b < 0).length, distinct_balances_read: new Set(ctx.obs.reads).size,
        final_balance: ctx.final, ledger_rows: ctx.rows, ledger_sum: ctx.sum };
    },
    response: (ctx, o) => ({ all_2xx: ctx.obs.statuses.every((s) => s >= 200 && s <= 299),
      no_negative_balance_returned: o.successes.every((b) => b >= 0) }),
    invariants: (ctx, o) => ({ approved_le_start: ctx.sum! <= ctx.start, balance_ge_0: ctx.final! >= 0,
      ledger_eq_approved: ctx.rows === o.successes.length, conserved: ctx.final === ctx.start - ctx.sum! }),
  });
}
