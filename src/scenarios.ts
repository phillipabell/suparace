// The v0.1 claim and spend scenarios, ported onto the library (src/lib.ts). Same naive/fixed code, same counts.
// Schema: sql/001_schema.sql (+ 002_queue_len.sql; 003_ledger.sql for spendLedgerRace).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { defineRace, type Race } from './lib.ts';
import { claimJobNaive, spendNaive, transferNaive, type SpendObs } from './naive.ts';
import { claimJobAtomic, claimJobSkipLocked, claimJobPgmq, spendAtomic, spendLocked, transferUnordered, transferOrdered } from './fixed.ts';

export interface Target { url: string; key: string }
type ClaimFn = (sb: SupabaseClient, w: string) => Promise<number | null>;
type SpendFn = (sb: SupabaseClient, wallet: number, amt: number) => Promise<number | null>;

export const CLAIM: Record<string, ClaimFn> = { naive: claimJobNaive, atomic_update: claimJobAtomic, skip_locked: claimJobSkipLocked, pgmq: claimJobPgmq };
export const SPEND: Record<string, SpendFn> = { naive: spendNaive, conditional_update: spendAtomic, for_update: spendLocked };
type TransferFn = (sb: SupabaseClient, src: number, dst: number, amt: number, pauseMs: number) => Promise<number | null>;
export const TRANSFER: Record<string, TransferFn> = { naive: (sb, s, d, a) => transferNaive(sb, s, d, a), unordered: transferUnordered, ordered: transferOrdered };

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

/** Small seeded PRNG so every method sees the same transfer plan for the same run index. */
export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export type Transfer = { src: number; dst: number; amount: number };
/** n transfers between random distinct wallets 1..wallets, amount 1..maxAmount, both directions. */
export function transferPlan(n: number, wallets: number, maxAmount: number, seed: number): Transfer[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const src = 1 + Math.floor(rnd() * wallets);
    let dst = 1 + Math.floor(rnd() * (wallets - 1)); if (dst >= src) dst++;
    return { src, dst, amount: 1 + Math.floor(rnd() * maxAmount) };
  });
}

/** N workers each make one transfer between a random pair of wallets (both directions occur).
 *  method: naive | unordered | ordered, optionally '@<ms>' = pause inside the lock (e.g. 'unordered@20').
 *  Invariants: total money constant, every wallet reconciles with the approved transfers, no balance below 0, no deadlock (40P01 seen by the client, or counted by
 *  Postgres in pg_stat_database during the run: needs a database used by nothing else). Needs sql/005_transfer.sql. */
export function transferRace(t: Target, methodArg: string, opts: { wallets?: number; start?: number; maxAmount?: number } = {}): Race {
  const [method, p] = methodArg.split('@'); const pauseMs = Number(p ?? 0);
  const fn = TRANSFER[method]; if (!fn || !(pauseMs >= 0)) throw new Error(`unknown transfer method ${methodArg}`);
  const W = opts.wallets ?? 10, START = opts.start ?? 10, MAX = opts.maxAmount ?? 5;
  const admin = client(t);
  let seed = 0;   // k-th run of every transfer race uses seed k: same plan across methods
  type Ctx = { plan: Transfer[]; codes: string[]; dl0: number; dbDeadlocks?: number; total?: number; min?: number; off?: number };
  // pg_stat counters are flushed by each backend within ~1 s of going idle; wait before reading so a run's
  // deadlocks are not counted in the next run.
  const deadlockCount = async () => { await new Promise((r) => setTimeout(r, 1500));
    const { data, error } = await admin.rpc('suparace_deadlocks'); if (error) throw error; return Number(data); };
  return defineRace<Ctx, SupabaseClient, number>({
    name: `transfer:${methodArg}`,
    expect: method === 'ordered' ? 'clean' : 'violation',
    items: () => W,
    setup: async ({ n }) => {
      const { error } = await admin.rpc('suparace_transfer_reset', { n_wallets: W, start_balance: START });
      if (error) throw error;
      return { plan: transferPlan(n, W, MAX, ++seed), codes: [], dl0: await deadlockCount() };
    },
    worker: async () => { const sb = client(t); await sb.from('transfer_wallets').select('id').limit(1); return sb; },
    actor: async (sb, ctx, i) => {
      const { src, dst, amount } = ctx.plan[i];
      try { return await fn(sb, src, dst, amount, pauseMs); }
      catch (e: any) { ctx.codes.push(String(e?.code || e?.message || 'unknown').slice(0, 60)); throw e; }
    },
    measure: async (ctx, o) => {
      const { data, error } = await admin.from('transfer_wallets').select('balance');
      if (error) throw error;
      ctx.total = data.reduce((a, r: any) => a + r.balance, 0); ctx.min = Math.min(...data.map((r: any) => r.balance));
      // per-wallet reconciliation: final = start + signed sum of the transfers that reported success
      const want = new Map<number, number>(Array.from({ length: W }, (_, k) => [k + 1, START]));
      o.byWorker.forEach((ok, i) => { if (ok.length) { const p = ctx.plan[i];
        want.set(p.src, want.get(p.src)! - p.amount); want.set(p.dst, want.get(p.dst)! + p.amount); } });
      const { data: rows, error: e2 } = await admin.from('transfer_wallets').select('id, balance');
      if (e2) throw e2;
      ctx.off = rows.filter((r: any) => r.balance !== want.get(r.id)).length;
      const deadlocks = ctx.codes.filter((c) => c === '40P01').length;
      ctx.dbDeadlocks = (await deadlockCount()) - ctx.dl0;
      return { op: 'transfer', method, pause_ms: pauseMs, wallets: W, total_start: W * START, total_final: ctx.total,
        money_delta: ctx.total - W * START, wallets_off: ctx.off, min_balance: ctx.min, db_deadlocks: ctx.dbDeadlocks, client_40P01: deadlocks, other_errors: ctx.codes.length - deadlocks,
        error_codes: ctx.codes.reduce((a: Record<string, number>, c) => (a[c] = (a[c] ?? 0) + 1, a), {}),
        refused: o.attempts - o.successes.length - o.errors, violations: Math.abs(ctx.total - W * START) };
    },
    response: (ctx) => ({ no_errors: ctx.codes.length === 0 }),
    invariants: (ctx) => ({ total_constant: ctx.total === W * START, reconciled: ctx.off === 0, none_negative: ctx.min! >= 0,
      no_deadlock: ctx.dbDeadlocks === 0 && !ctx.codes.includes('40P01'), no_errors: ctx.codes.length === 0 }),
  });
}
