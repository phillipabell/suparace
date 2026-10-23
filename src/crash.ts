// Crash-safe pgmq race. Schema: sql/007_crash.sql (remove with sql/007_crash_drop.sql).
// Scenario: N workers drain a pgmq queue of 2N jobs. The first C workers (C = P% of N) "crash" on their first job:
// they take it and never finish it. The next C workers stall on their first job for longer than the visibility
// timeout, then finish it anyway. Everyone else works normally and keeps polling while messages are still in the
// queue (visible or hidden).
// Invariants: no lost jobs (every job finished), no double completion (each job's side effect applied once).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { defineRace, type Race } from './lib.ts';
import type { Target } from './scenarios.ts';

type Msg = { msg_id: number; job: number };
type TakeFn = (sb: SupabaseClient, vt: number) => Promise<Msg | null>;

const take = (fn: string, withVt: boolean): TakeFn => async (sb, vt) => {
  const { data, error } = await sb.rpc(fn, withVt ? { p_vt: vt } : {});
  if (error) throw error;
  const rows = (data ?? []) as Msg[];
  return rows.length ? rows[0] : null;
};

interface Method { take: TakeFn; idem: boolean; redeliver: boolean }
export const CRASH: Record<string, Method> = {
  /** The bug: pop() deletes the message as it reads it. A worker that dies after pop loses the job. */
  pop: { take: take('crash_pop', false), idem: true, redeliver: false },
  /** Half a fix: read() + visibility timeout + archive, but the handler is not idempotent. No job is lost, but a
   *  worker that stalls past vt and the worker that got the redelivery both apply the side effect. */
  read_no_dedupe: { take: take('crash_read', true), idem: false, redeliver: true },
  /** The fix: read() + vt + archive, and the side effect guarded by insert ... on conflict do nothing in the same
   *  transaction as the archive. */
  read_archive: { take: take('crash_read', true), idem: true, redeliver: true },
};
export const DEFAULT_PCT = 10;
export const DEFAULT_VT_S = 2;
const STALL_EXTRA_MS = 1000;   // stallers sleep vt + this before finishing
const POLL_MS = 250;           // idle poll while hidden messages may come back

const client = (t: Target) => createClient(t.url, t.key, { auth: { persistSession: false, autoRefreshToken: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** spec "pop", "read_archive@20": method plus optional percent of workers that crash (same percent stall). */
export function parseCrashSpec(spec: string): { method: string; pct: number } {
  const [method, ps] = spec.split('@');
  const pct = ps === undefined ? DEFAULT_PCT : Number(ps);
  if (!CRASH[method]) throw new Error(`unknown crash method ${method}`);
  if (!(Number.isInteger(pct) && pct >= 0 && pct <= 50)) throw new Error(`bad percent in crash:${spec} (0-50)`);
  return { method, pct };
}
/** workers that crash (and, separately, that stall): P% of N, at least 1 when P > 0 */
export const crashCount = (n: number, pct: number) => (pct === 0 ? 0 : Math.max(1, Math.round((n * pct) / 100)));
export type Role = 'crash' | 'stall' | 'ok';
export const roleOf = (i: number, c: number): Role => (i < c ? 'crash' : i < 2 * c ? 'stall' : 'ok');

export function crashRace(t: Target, spec: string, vt = DEFAULT_VT_S): Race {
  const { method, pct } = parseCrashSpec(spec);
  const m = CRASH[method];
  const admin = client(t);
  type Ctx = { jobs: number; c: number; per?: Map<number, number>; done?: number; left?: number; redelivered?: number };
  return defineRace<Ctx, SupabaseClient, number>({
    name: `crash:${method}@${pct}`,
    expect: method === 'read_archive' ? 'clean' : 'violation',
    items: (n) => 2 * n,
    setup: async ({ n, mode, items }) => {
      if (mode !== 'drain') throw new Error('crash race needs --mode drain (redelivery needs workers that keep polling)');
      const c = crashCount(n, pct);
      if (2 * c > n) throw new Error(`crash:${spec}: ${c} crashers + ${c} stallers > N=${n}`);
      const { error } = await admin.rpc('crash_reset', { n_jobs: items }); if (error) throw error;
      return { jobs: items, c };
    },
    worker: async () => { const sb = client(t); await sb.rpc('crash_queue_len'); return sb; },
    actor: async (sb, ctx, i, attempt) => {
      const role = attempt === 0 ? roleOf(i, ctx.c) : 'ok';   // a role applies to the worker's first job only
      for (;;) {
        const msg = await m.take(sb, vt);
        if (msg) {
          if (role === 'crash') return null;                   // dies holding the job: never finishes it
          if (role === 'stall') await sleep(vt * 1000 + STALL_EXTRA_MS);
          const { error } = await sb.rpc('crash_complete', { p_msg_id: msg.msg_id, p_job: msg.job, p_worker: `w${i}`, p_idem: m.idem });
          if (error) throw error;
          return msg.job;
        }
        if (!m.redeliver) return null;                         // pop: nothing visible = nothing left
        const { data, error } = await sb.rpc('crash_queue_len');
        if (error) throw error;
        if (Number(data) === 0) return null;
        await sleep(POLL_MS);                                  // hidden messages: wait for their vt to run out
      }
    },
    measure: async (ctx, o) => {
      const { data: eff, error: e1 } = await admin.from('crash_effects').select('job').limit(100000);
      const { count, error: e2 } = await admin.from('crash_done').select('job', { count: 'exact', head: true });
      const { data: left, error: e3 } = await admin.rpc('crash_queue_len');
      const { data: red, error: e4 } = await admin.rpc('crash_redelivered');
      if (e1 || e2 || e3 || e4) throw e1 ?? e2 ?? e3 ?? e4;
      const per = ctx.per = new Map<number, number>();
      for (const r of eff as { job: number }[]) per.set(r.job, (per.get(r.job) ?? 0) + 1);
      ctx.done = count ?? -1; ctx.left = Number(left); ctx.redelivered = Number(red);
      const extra = [...per.values()].reduce((a, c) => a + Math.max(0, c - 1), 0);
      const lost = ctx.jobs - ctx.done;
      return { op: 'crash', method, pct, vt_s: vt, jobs: ctx.jobs, crashers: ctx.c, stallers: ctx.c,
        jobs_done: ctx.done, lost_jobs: lost, side_effects: eff.length, double_completed: extra,
        redelivered: ctx.redelivered, queue_left: ctx.left, violations: lost + extra };
    },
    invariants: (ctx) => {
      const per = ctx.per!;
      return {
        no_lost_jobs: ctx.done === ctx.jobs,
        effect_once_per_job: per.size === ctx.jobs && [...per.values()].every((c) => c === 1),
        queue_drained: ctx.left === 0,
      };
    },
  });
}
