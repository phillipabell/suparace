// SupaRace RLS matrix: the claim and spend races run through the Data API as anon, user A, user B and service_role,
// with real user JWTs (two throwaway users made with the Auth admin API, deleted at the end).
// Schema: sql/004_rls.sql. Wallet 1 belongs to A, wallet 2 to B, both start at N/2; N/2 pending jobs per owner.
// Every spend actor targets wallet 1 (A's). Claim actors take "the next pending job" with no owner filter.
//
// Checks per run (lib invariants = race_* + rls_*; live_* are reported, not scored):
//   race_*  the v0.1 invariants (claimed once; approvals <= start; balance conserved and >= 0)
//   rls_*   no cross-tenant effect: a non-owner changes nothing of A's; nobody touches wallet 2; a user only ever
//           claims its own jobs; anon claims nothing
//   live_*  the permitted caller gets everything done (A drains wallet 1 / claims all A's jobs; service_role all jobs)
// Usage: SUPARACE_URL=... SUPARACE_KEY=<service_role> SUPARACE_ANON_KEY=<anon> node src/rls.ts [N] [--runs R]
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { defineRace, runRace, exitCode, type Race, type Report } from './lib.ts';

const url = process.env.SUPARACE_URL ?? 'http://127.0.0.1:8000';
const SERVICE = process.env.SUPARACE_KEY, ANON = process.env.SUPARACE_ANON_KEY;
if (!SERVICE || !ANON) { console.error('set SUPARACE_KEY (service_role) and SUPARACE_ANON_KEY'); process.exit(2); }
const args = process.argv.slice(2);
const ri = args.indexOf('--runs'); const RUNS = ri >= 0 ? Number(args.splice(ri, 2)[1]) : 3;
const N = Number(args[0] ?? 100);

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, SERVICE, opts);
type Role = 'anon' | 'user_a' | 'user_b' | 'service_role';
const ROLES: Role[] = ['anon', 'user_a', 'user_b', 'service_role'];
const EMAIL = { user_a: 'suparace-a@example.com', user_b: 'suparace-b@example.com' };
const users: Record<'user_a' | 'user_b', { id: string; jwt: string }> = {} as any;

function clientFor(role: Role): SupabaseClient {
  if (role === 'service_role') return createClient(url, SERVICE!, opts);
  if (role === 'anon') return createClient(url, ANON!, opts);
  return createClient(url, ANON!, { ...opts, global: { headers: { Authorization: `Bearer ${users[role].jwt}` } } });
}
const uidOf = (role: Role) => (role === 'user_a' || role === 'user_b') ? users[role].id : null;

async function deleteTestUsers() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  for (const u of data.users) if (Object.values(EMAIL).includes(u.email ?? '')) {
    const { error: e } = await admin.auth.admin.deleteUser(u.id); if (e) throw e;
  }
}
async function makeTestUsers() {
  await deleteTestUsers();
  for (const role of ['user_a', 'user_b'] as const) {
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await admin.auth.admin.createUser({ email: EMAIL[role], password, email_confirm: true });
    if (error) throw error;
    const anon = createClient(url, ANON!, opts);
    const { data: s, error: e2 } = await anon.auth.signInWithPassword({ email: EMAIL[role], password });
    if (e2) throw e2;
    users[role] = { id: data.user.id, jwt: s.session!.access_token };
  }
}

async function reset(start: number) {
  const { error } = await admin.rpc('rls_reset', { a: users.user_a.id, b: users.user_b.id, n_each: start, start_balance: start });
  if (error) throw error;
}
async function warm(role: Role) { const sb = clientFor(role); await sb.from('rls_wallets').select('id').limit(1); return sb; }
async function rpcNum(sb: SupabaseClient, fn: string, a: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(fn, a); if (error) throw error; return (data ?? null) as number | null;
}

// ---- spend ----
async function spendNaive(sb: SupabaseClient): Promise<number | null> {
  const { data, error } = await sb.from('rls_wallets').select('balance').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!data || data.balance < 1) return null;               // RLS hides the row from a non-owner: refused
  const { data: up, error: e2 } = await sb.from('rls_wallets').update({ balance: data.balance - 1 }).eq('id', 1).select('id');
  if (e2) throw e2;
  if (!up.length) return null;                               // update matched no visible row
  return data.balance - 1;
}
const SPEND: Record<string, (sb: SupabaseClient) => Promise<number | null>> = {
  naive: spendNaive,
  conditional_invoker: (sb) => rpcNum(sb, 'rls_spend_invoker', { wallet: 1, amount: 1 }),
  for_update_invoker: (sb) => rpcNum(sb, 'rls_spend_locked_invoker', { wallet: 1, amount: 1 }),
  conditional_definer: (sb) => rpcNum(sb, 'rls_spend_definer', { wallet: 1, amount: 1 }),
  conditional_definer_checked: (sb) => rpcNum(sb, 'rls_spend_definer_checked', { wallet: 1, amount: 1 }),
};

async function wallets() {
  const { data, error } = await admin.from('rls_wallets').select('id, balance').order('id');
  if (error) throw error; return { w1: data[0].balance as number, w2: data[1].balance as number };
}

function spendRace(method: string, role: Role): Race {
  type C = { start: number; w1?: number; w2?: number };
  const owner = role === 'user_a' || role === 'service_role';   // may legitimately spend wallet 1
  return defineRace<C, SupabaseClient, number>({
    name: `spend:${method}:${role}`,
    expect: (method === 'naive' && owner) || (method === 'conditional_definer' && role === 'user_b') ? 'violation' : 'clean',
    setup: async ({ items }) => { await reset(items); return { start: items }; },
    worker: () => warm(role),
    actor: (sb) => SPEND[method](sb),
    measure: async (c, o) => {
      Object.assign(c, await wallets());
      const ok = o.successes.length;
      return { op: 'spend', method, role, start: c.start, w1: c.w1, w2: c.w2, overspend: Math.max(0, ok - c.start),
        lost_updates: c.w1! - (c.start - ok), live_done: owner ? c.w1 === 0 : null };
    },
    invariants: (c, o) => {
      const ok = o.successes.length;
      const chk: Record<string, boolean> = { race_approved_le_start: ok <= c.start, race_conserved: c.w1 === c.start - ok,
        race_balance_ge_0: c.w1! >= 0, rls_wallet2_untouched: c.w2 === c.start };
      if (!owner) chk.rls_nonowner_no_effect = ok === 0 && c.w1 === c.start;
      return chk;
    },
  });
}

// ---- claim ----
async function claimNaive(sb: SupabaseClient, uid: string | null): Promise<number | null> {
  const { data, error } = await sb.from('rls_jobs').select('id').eq('status', 'pending').order('id').limit(1);
  if (error) throw error;
  if (!data.length) return null;
  const { data: up, error: e2 } = await sb.from('rls_jobs').update({ status: 'claimed', claimed_by: uid }).eq('id', data[0].id).select('id');
  if (e2) throw e2;
  if (!up.length) return null;
  return data[0].id as number;
}
const CLAIM: Record<string, (sb: SupabaseClient, uid: string | null) => Promise<number | null>> = {
  naive: claimNaive,
  skip_locked_invoker: (sb) => rpcNum(sb, 'rls_claim_invoker'),
  skip_locked_definer: (sb) => rpcNum(sb, 'rls_claim_definer'),
  skip_locked_definer_checked: (sb) => rpcNum(sb, 'rls_claim_definer_checked'),
};

function claimRace(method: string, role: Role): Race {
  type C = { each: number; owners?: Map<number, string>; pending?: { a: number; b: number } };
  const uid = () => uidOf(role);
  return defineRace<C, SupabaseClient, number>({
    name: `claim:${method}:${role}`,
    // definer (no owner filter) hands a user the other tenant's pending jobs
    expect: (method === 'naive' && role !== 'anon') || (method === 'skip_locked_definer' && !!uidOf(role)) ? 'violation' : 'clean',
    items: (n) => n,                                // n/2 per owner, n total
    setup: async ({ items }) => { await reset(Math.floor(items / 2)); return { each: Math.floor(items / 2) }; },
    worker: () => warm(role),
    actor: (sb) => CLAIM[method](sb, uid()),
    measure: async (c) => {
      const { data, error } = await admin.from('rls_jobs').select('id, owner, status');
      if (error) throw error;
      c.owners = new Map(data.map((j: any) => [Number(j.id), j.owner]));
      const pend = (o: string) => data.filter((j: any) => j.owner === o && j.status === 'pending').length;
      c.pending = { a: pend(users.user_a.id), b: pend(users.user_b.id) };
      const live = role === 'service_role' ? c.pending.a + c.pending.b === 0 : role === 'anon' ? null
        : (role === 'user_a' ? c.pending.a : c.pending.b) === 0;
      return { op: 'claim', method, role, pending_a: c.pending.a, pending_b: c.pending.b, live_done: live };
    },
    invariants: (c, o) => {
      const distinct = new Set(o.successes);
      const chk: Record<string, boolean> = { race_claimed_once: distinct.size === o.successes.length };
      const me = uidOf(role);
      if (me) {
        chk.rls_own_jobs_only = [...distinct].every((id) => c.owners!.get(id) === me);
        chk.rls_other_untouched = (role === 'user_a' ? c.pending!.b : c.pending!.a) === c.each;
      }
      if (role === 'anon') chk.rls_anon_no_effect = o.successes.length === 0 && c.pending!.a + c.pending!.b === 2 * c.each;
      return chk;
    },
  });
}

const reports: Report[] = [];
try {
  await makeTestUsers();
  for (const role of ROLES) {
    for (const m of Object.keys(CLAIM)) reports.push(await runRace(claimRace(m, role), { n: N, mode: 'burst', runs: RUNS }));
    for (const m of Object.keys(SPEND)) reports.push(await runRace(spendRace(m, role), { n: N, mode: 'burst', runs: RUNS }));
  }
} finally {
  await deleteTestUsers();
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  console.error(`test users left after cleanup: ${data?.users.filter((u) => Object.values(EMAIL).includes(u.email ?? '')).length}`);
}
const mean = (xs: number[]) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
const table = reports.map((r) => ({ race: r.race, expect: r.expect, pass: r.pass, flagged: `${r.flagged_runs}/${r.runs}`,
  successes: mean(r.rows.map((x) => x.successes)), errors: mean(r.rows.map((x) => x.errors)),
  failed_checks: [...new Set(r.rows.flatMap((x) => Object.entries(x.invariants ?? {}).filter(([, v]) => !v).map(([k]) => k)))].join(' '),
  live_done: r.rows.map((x) => x.live_done).join('/') }));
for (const t of table) console.log(JSON.stringify(t));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`results/rls-burst-${stamp}.json`, JSON.stringify({ suparace: '0.2.0', n: N, runs: RUNS, mode: 'burst', table, reports }, null, 1));
console.error(`wrote results/rls-burst-${stamp}.json`);
process.exit(exitCode(reports));
