// Hosted free-tier burst run. Same naive/fixed code as race.ts, burst mode only, four methods.
// The client wrapper maps table 'jobs' -> 'suparace_jobs' and rpc 'x' -> 'suparace_x' (see sql/hosted_free_tier.sql).
// Usage: SUPARACE_URL=https://<ref>.supabase.co SUPARACE_KEY=<anon key> node src/hosted.ts [N] [--runs R]
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { claimJobNaive, spendNaive } from './naive.ts';
import { claimJobSkipLocked, spendAtomic } from './fixed.ts';

const URL = process.env.SUPARACE_URL, KEY = process.env.SUPARACE_KEY;
if (!URL || !KEY) { console.error('set SUPARACE_URL and SUPARACE_KEY'); process.exit(2); }
const args = process.argv.slice(2); const ri = args.indexOf('--runs');
const RUNS = ri >= 0 ? Number(args.splice(ri, 2)[1]) : 3; const N = Number(args[0] ?? 100);
const P = 'suparace_';
const mk = (): SupabaseClient => {
  const c: any = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const from = c.from.bind(c), rpc = c.rpc.bind(c);
  c.from = (t: string) => from(t.startsWith(P) ? t : P + t);
  c.rpc = (f: string, a?: any, o?: any) => rpc(f.startsWith(P) ? f : P + f, a, o);
  return c;
};
const admin = mk();
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const reset = async (j: number, b: number) => { const { error } = await admin.rpc('reset', { n_jobs: j, start_balance: b }); if (error) throw error; };
const items = Math.floor(N / 2);

async function burst(op: 'claim' | 'spend', method: string, fn: (sb: SupabaseClient, i: number) => Promise<number | null>) {
  await reset(op === 'claim' ? items : 0, op === 'spend' ? items : 0);
  const clients = Array.from({ length: N }, mk);
  await Promise.all(clients.map((sb) => sb.from('wallets').select('id').limit(1)));
  const lat: number[] = [], got: number[] = []; let errors = 0;
  const t0 = performance.now();
  await Promise.all(clients.map(async (sb, i) => {
    const s = performance.now();
    try { const r = await fn(sb, i); if (r != null) got.push(r); } catch { errors++; }
    lat.push(performance.now() - s);
  }));
  const wall = performance.now() - t0;
  const base = { op, method, n: N, items, successes: got.length, errors, wall_ms: Math.round(wall),
                 p50_ms: +pct(lat, .5).toFixed(1), p95_ms: +pct(lat, .95).toFixed(1) };
  if (op === 'claim') {
    const { count } = await admin.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    const distinct = new Set(got).size;
    return { ...base, distinct, violations: got.length - distinct, left_unclaimed: count };
  }
  const { data } = await admin.from('wallets').select('balance').eq('id', 1).single();
  const final = data!.balance as number;
  return { ...base, final_balance: final, lost_updates: final - (items - got.length), violations: Math.max(0, got.length - items) };
}

const METHODS: [ 'claim' | 'spend', string, (sb: SupabaseClient, i: number) => Promise<number | null>][] = [
  ['claim', 'naive', (sb, i) => claimJobNaive(sb, `w${i}`)],
  ['claim', 'skip_locked', (sb, i) => claimJobSkipLocked(sb, `w${i}`)],
  ['spend', 'naive', (sb) => spendNaive(sb, 1, 1)],
  ['spend', 'conditional_update', (sb) => spendAtomic(sb, 1, 1)],
];
const rows: any[] = [];
for (let r = 1; r <= RUNS; r++) for (const [op, m, fn] of METHODS) {
  const x = { ...(await burst(op, m, fn)), run: r }; rows.push(x); console.log(JSON.stringify(x));
}
const out = `results/hosted-burst-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(out, JSON.stringify(rows, null, 1)); console.error(`wrote ${out}`);
