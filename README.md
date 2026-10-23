# SupaRace

**Race tests for supabase-js read-then-write bugs, and the Postgres fixes that stop them.**

Not affiliated with or endorsed by Supabase.

supabase-js has no client-side transactions. App code that reads a row, decides in JavaScript, then writes
(claim a job, sell stock, spend a balance, move money between two accounts) breaks when many clients do it at once, and every normal test still
passes because each request on its own returns 2xx. SupaRace contains:

- the naive client code (`src/naive.ts`) and the fixes as Postgres functions called with `supabase.rpc()`
  (`sql/`, `src/fixed.ts`): atomic UPDATE, `FOR UPDATE SKIP LOCKED`, pgmq, conditional decrement, `SELECT ... FOR UPDATE`;
- a race harness, usable as a library in CI, that fires N concurrent supabase-js clients at a scenario and then
  checks **database invariants** (not just HTTP responses);
- an RLS matrix that runs the same races as anon, two real signed-in users and service_role.

About the author's experience: this is a learning and test project. The author has not run Supabase in production.
Every number below is **measured** (with N, mode and target stated) unless it is marked **hypothesis**.

Status: v0.3, early. Packaged for npm as `suparace` (CLI + library) but **not published yet**; until it is, use a
clone (`npm install && npm run build && npm pack`, then `npx --package ./suparace-0.3.0.tgz suparace ...`).

## 5-minute quickstart (`npx suparace`)

Requirements: Node 22+ and a Supabase project you are allowed to break (a new Free plan project, or a local stack).
Everything the quickstart creates is prefixed `suparace_`.

```sh
npx suparace init                 # writes suparace/quickstart.sql and suparace/spend.race.mjs
# paste suparace/quickstart.sql into the SQL editor and run it (or: psql "$DATABASE_URL" -f suparace/quickstart.sql)
export SUPABASE_URL=https://<project-ref>.supabase.co          # Project Settings > API
export SUPABASE_SERVICE_ROLE_KEY=<service_role or sb_secret_ key>  # from your secret store; never commit it
npx suparace run --race spend:naive     # the read-then-write bug: FAIL, exit 1
npx suparace run --race spend:atomic    # the one-statement RPC fix: PASS, exit 0
```

What the race does: 50 concurrent supabase-js clients each try to spend 1 credit from a wallet holding 25.

```
FAIL spend:naive  N=50 burst expect=clean  flagged 3/3  failed: no_overspend, balance_matches  successes/run: 50,50,50  1.8s
PASS spend:atomic  N=50 burst expect=clean  flagged 0/3  successes/run: 25,25,25  1.5s
```

**Measured (2026-10-22), local self-hosted Supabase (Podman), not a cloud project:** from an empty folder with the
packed tarball, the five steps above (init, apply SQL, naive run, fixed run) took **6.5 s of command time** in total
(init 1.8 s with a cold npm cache, SQL 0.2 s, naive 2.4 s, fix 2.1 s); naive approved 50 spends against 25 credits in
3/3 runs, the fix approved exactly 25 in 3/3. **Hypothesis, not timed:** on a fresh cloud Free project the total stays
under 5 minutes; project creation (typically 1-2 minutes) and copying the URL and key are the slow part, and each run
takes longer over the internet than against localhost.

Write your own: copy `spend.race.mjs`. A race file default-exports a race, an array of races, or a function
`({ client, anonClient, env }) => race | race[]`, where `client()` is a new supabase-js client with the service role
key (`anonClient()` uses `SUPABASE_ANON_KEY`), so race files need no imports. Race files ending `.race.ts` also work
on Node 22.18+ (erasable TypeScript only: no enums or namespaces; relative imports need the `.ts` extension).
`npx suparace --help` lists the flags (`--n`, `--runs`, `--mode burst|drain`, `--score`, `--out report.json`,
`--json`). Exit code 0 = every race matched its `expect`, 1 = a race failed, 2 = bad config. A race can set
`expect: 'violation'` to act as a known-bad control, and `defaults: { n, mode, runs }`.

Why a CLI and not a vitest/jest plugin (consult, 2026-10-22): test runners default to short timeouts and run files in
parallel, which fights 50-200 concurrent HTTP clients resetting shared tables. To run a race inside vitest anyway:

```ts
import { test, expect } from 'vitest';
import { runRace, exitCode } from 'suparace';
import races from '../suparace/spend.race.mjs';
import { helpers } from 'suparace/cli';
test('spend is race-safe', async () => {
  const race = races(helpers()).find((r) => r.name === 'spend:atomic');
  expect(exitCode(await runRace(race, { n: 50, mode: 'burst', runs: 3 }))).toBe(0);
}, 60_000);   // and run race files serially (e.g. vitest --no-file-parallelism)
```

## Full scenarios from a clone

Requirements: Node 22.18+ (runs `.ts` files directly), a Supabase project you are allowed to break. A local
self-hosted stack is the intended target; a throwaway Free plan project also works (see "Hosted free-tier
reproduction"). Do not point it at production data: the scenarios reset their own tables.

```sh
npm install
npm test                                   # 14 unit tests, in-memory, no database needed

# apply the schema (self-hosted example; use the SQL editor on hosted)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/002_queue_len.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/003_ledger.sql     # for --score

export SUPARACE_URL=http://127.0.0.1:8000  # your API URL
export SUPARACE_KEY=<service_role key>     # read from your env; never commit it
./run.sh 100 --mode burst --runs 3         # all claim + spend races, burst mode
```

`pgmq` races need the pgmq extension (`create extension pgmq`). The RLS matrix also needs
`sql/004_rls.sql` and `SUPARACE_ANON_KEY`; remove it with `sql/004_rls_drop.sql`.

## v0.2: the harness as a library (CI)

`src/lib.ts` is the reusable part; the v0.1 scenarios now sit on top of it (`src/scenarios.ts`).

```ts
import { defineRace, runRace, exitCode } from 'suparace';

const race = defineRace({
  name: 'spend:mine',
  expect: 'clean',                        // 'violation' for a known-bad control
  setup: async ({ n, mode, items }) => { /* reset rows */ return ctx; },
  worker: async (ctx, i) => client,       // per-worker state, built and warmed before timing
  actor: (client, ctx, i, attempt) => spend(client),  // value = success, null = refused/stop, throw = error
  invariants: async (ctx, out) => ({ approved_le_start: ..., conserved: ... }),  // reads DB state
  response: (ctx, out) => ({ all_2xx: ... }),          // optional, response-only view
  measure: async (ctx, out) => ({ final_balance: ... }), // extra numbers for the row
  teardown: async (ctx) => {},
});
const report = await runRace(race, { n: 100, mode: 'burst', runs: 3, score: 'both' });
process.exit(exitCode(report));
```

- `mode`: `burst` (N/2 items, one attempt per worker) or `drain` (5N items, loop until null, cap `maxLoops`,
  default 1000). Override item counts with `items: (n, mode) => ...`.
- `score`: `invariant` (default), `response`, or `both`. Response scoring flags a run if any response check is false
  or any actor call threw; invariant scoring flags it if any invariant is false.
- Exit code: 0 when every run matches `expect` (clean race: no run flagged; violation control: every run flagged),
  1 otherwise. The CLI exits 2 on bad config.
- CLI: `./run.sh 100 --mode burst --runs 3 [--race claim,spend:naive,spend-ledger] [--score both] [--out FILE]`.
  One JSON row per run on stdout, a JSON report file with `pass` per race, PASS/FAIL lines on stderr.
  v0.1 invocations still work (`BURST=1`, `--score` alone runs the ledger scenario in burst mode).
- Tests: `npm test` (node:test, in-memory races, no Supabase needed; 14 tests).

Note: `claim:atomic_update` now fails CI in burst mode. Its double-claim count is still 0, but the `none_left`
invariant catches the stall described below (about half the jobs left pending). That is the harness doing its job.

### v0.2 port check (measured 2026-10-22, self-hosted, burst, N=100, 3 runs each, mean)

v0.1 harness and v0.2 library run back to back on the same stack. Raw: `results/v01-ab-burst-2026-10-22.json`,
`results/v02-burst-2026-10-22.json`, `results/v02-score-both-2026-10-22.json`.

| Race | v0.1 successes / violations | v0.2 successes / violations | v0.2 CI result |
|---|---|---|---|
| claim:naive | 100 / 89.7 (39.7 left pending) | 100 / 89.0 (39.0 left) | flagged 3/3, PASS (control) |
| claim:atomic_update | 24.7 / 0 (25.3 left) | 24.0 / 0 (26.0 left) | flagged 3/3 (none_left), FAIL |
| claim:skip_locked | 50 / 0 | 50 / 0 | 0/3, PASS |
| claim:pgmq | 50 / 0 | 50 / 0 | 0/3, PASS |
| spend:naive | 100 / 50 (96.7 lost updates) | 100 / 50 (98.0 lost) | flagged 3/3, PASS (control) |
| spend:conditional_update | 50 / 0 | 50 / 0 | 0/3, PASS |
| spend:for_update | 50 / 0 | 50 / 0 | 0/3, PASS |
| spend-ledger:naive, score both | (v0.1: 0/5 response, 5/5 invariant) | 300 calls all 2xx; response flagged 0/3, invariant 3/3 | PASS (control) |

Same counts within run-to-run noise; the fixes are 0 violations in every run under both harnesses.

## RLS matrix: the races through the Data API with real JWTs (measured 2026-10-22)

`src/rls.ts` (schema `sql/004_rls.sql`, remove with `sql/004_rls_drop.sql`). Two throwaway users are created with
the Auth admin API, signed in with a password for real access tokens, and deleted at the end (0 left, checked by
the script). Wallet 1 belongs to user A, wallet 2 to user B, both start at 50; 50 pending jobs per owner. Policies:
owner-only select/update for `authenticated`, nothing for `anon`. Every spend targets wallet 1 (A's); claims take
"the next pending job" with no owner filter. Each fix comes as SECURITY INVOKER and as SECURITY DEFINER, unchecked
(the common mistake) and checked (`owner = auth.uid()` inside the function). Functions: EXECUTE for
`authenticated` and `service_role` only.

Run: `SUPARACE_SCRIPT=src/rls.ts ./run.sh 100 --runs 3`. Self-hosted, burst, N=100 clients per role, 3 runs each,
all 36 race x role cells matched their expected outcome (exit 0). Raw: `results/rls-burst-2026-10-22T19-03-47-963Z.json`.

| Method | anon | user A (owner) | user B (other tenant) | service_role |
|---|---|---|---|---|
| spend naive | 100 errors, no effect | 100 approved / 50, ~97 lost updates (race fails 3/3) | 0 approved, no effect | 100 approved / 50 (race fails 3/3) |
| spend conditional, INVOKER | denied | 50/50, balance 0 | 0, no effect | 50/50 |
| spend FOR UPDATE, INVOKER | denied | 50/50 | 0, no effect | 50/50 |
| spend conditional, DEFINER unchecked | denied | 50/50 | **50 spent from A's wallet (RLS bypass, 3/3)** | 50/50 |
| spend conditional, DEFINER checked | denied | 50/50 | 0, no effect | **0: locked out (auth.uid() is null)** |
| claim naive | denied | 100 "claims", ~40 of A's 50 left pending (double claims 3/3) | same on B's jobs | same, all on A's jobs |
| claim SKIP LOCKED, INVOKER | denied | 50, all A's, none left | 50, all B's | 100, all |
| claim SKIP LOCKED, DEFINER unchecked | denied | **100: took all 50 of B's jobs (3/3)** | **100: took A's jobs (3/3)** | 100 |
| claim SKIP LOCKED, DEFINER checked | denied | 50, own only | 50, own only | **0: locked out** |

What this shows (measured, this setup only):
- RLS does not fix the race. With an owner's real JWT the naive read-then-write still fails exactly as with
  service_role: RLS decides who may touch a row, not whether two of your own requests interleave.
- The INVOKER fixes keep both properties: no double claim or overspend, and no cross-tenant effect.
- A DEFINER fix without its own owner check is race-safe and breaks tenancy: user B spent A's credits and each
  user claimed the other's jobs in every run. Response-only scoring would see 50 or 100 clean 2xx successes.
- Adding `owner = auth.uid()` makes DEFINER safe for users but returns nothing for service_role, so a backend
  worker using that same function silently does no work (`live_done` false). Hypothesis: most apps want INVOKER for
  user-facing calls and a separate service-only function for backend workers.
- Not tested: the free hosted project (this run was self-hosted only), policies with joins or `security_barrier`
  views, pgmq under RLS (pgmq queues have no row owner).

## Two-wallet transfer: lock ordering and deadlocks (measured 2026-10-22)

`transferRace` in `src/scenarios.ts`, schema `sql/005_transfer.sql` (remove with `sql/005_transfer_drop.sql`).
10 wallets x 10 credits = 100 in total. Burst: N clients each make ONE transfer of 1-5 credits from a random wallet to
a different random wallet, so many pairs run in both directions at once. The plan is seeded: run k of every method
uses the same transfers. Invariants: total stays 100, every wallet reconciles (final = start + signed sum of the transfers that reported
success), no balance below 0, no deadlock, no client error.

- `transfer:naive`: the client reads both balances, checks in JS, then PATCHes src and dst with the computed values.
- `transfer:unordered`: one function, `SELECT src FOR UPDATE`, then `SELECT dst FOR UPDATE`, check, two UPDATEs.
  Race-safe, but A->B and B->A can each hold one row and wait for the other.
- `transfer:ordered` (the fix): one function that locks both rows in one statement in id order, then checks:

```sql
if src is null or dst is null or amount is null or src = dst or amount <= 0 then return null; end if;
perform 1 from public.transfer_wallets where id in (src, dst) order by id for update;
get diagnostics locked = row_count;
if locked <> 2 then return null; end if;   -- missing wallet: the dst UPDATE would silently do nothing
select balance into b from public.transfer_wallets where id = src;
if b is null or b < amount then return null; end if;
update public.transfer_wallets set balance = balance - amount where id = src;
update public.transfer_wallets set balance = balance + amount where id = dst;
```

- `@20` runs the same function with `pause_ms=20` inside the lock (a stand-in for extra work in the transaction).

Deadlocks are counted two ways: SQLSTATE `40P01` seen by the client, and the change in Postgres's own counter
(`pg_stat_database.deadlocks`, read 1.5 s after the run so the backends have flushed their stats; this needs a database
nothing else is using). Run: `./run.sh 100 --mode burst --runs 5 --race transfer,transfer:unordered@20,transfer:ordered@20`.
Raw rows: `results/transfer-burst-2026-10-22.jsonl` (+ `.json` report). Self-hosted, burst, N=100, 5 runs, mean:

| Method | Approved / refused | Client errors | Money created (+) or destroyed (-) per run | Wallets that do not reconcile (of 10) | Postgres deadlocks per run (range) | Wall ms | p50 / p95 ms | CI |
|---|---|---|---|---|---|---|---|---|
| naive | 97.8 / 2.2 | 0 | +20, +15, +25, +22, +2 | 9.8 | 0 | 409 | 176 / 238 | flagged 5/5 (control) |
| unordered | 81.2 / 18.8 | 0 | 0 | 0 | **9.8** (5-14) | 5,425 | 2,531 / 5,214 | flagged 5/5 (control) |
| ordered | 82.4 / 17.6 | 0 | 0 | 0 | 0 | 567 | 138 / 398 | 0/5, PASS |
| unordered@20 | 81.0 / 19.0 | 0 | 0 | 0 | **16.6** (14-18) | 7,818 | 5,129 / 7,773 | flagged 5/5 (control) |
| ordered@20 | 82.4 / 17.6 | 0 | 0 | 0 | 0 | 1,026 | 488 / 951 | 0/5, PASS |

Lowest balance seen: 0 for the locking methods, 3 for naive. Cross-check of the deadlock count: Postgres's counter moved
by 132 over the whole batch (read again 12 s after the last run), equal to the sum of the per-run counts.

What this shows (measured, this setup only):
- The naive transfer breaks the books in every run: an overwritten PATCH erases another transfer's effect, so credits
  appear or vanish, and on average 9.8 of 10 wallets end with a balance that does not match the transfers that
  reported success. Run 5 is the warning case: the total was off by only +2 while all 10 wallets were wrong, so a
  "total is constant" check alone can miss errors that cancel out. No request failed and no balance went negative,
  so neither a response check nor a `balance >= 0` constraint would have caught any of it.
- `FOR UPDATE` in caller order keeps the money right but deadlocks in every run. **No client ever received 40P01.**
  Postgres counted the deadlocks; the clients saw slow successes instead: p50 2.5 s against 0.14 s for the ordered
  fix, about 10x the wall time; with 20 ms of work inside the lock, 16.6 deadlocks per run and 7.8 s wall.
- In an earlier batch of the same races the same evening (host busier; before the reconciliation check and the
  missing-wallet guard were added), `unordered@20` also lost on average 23.8 of 100 calls per run to `PGRST003`
  (PostgREST timed out waiting for a free DB connection, its pool is 10), with 23.0 deadlocks per run and 10.3 s
  wall; the ordered fix had 0 errors and 0 deadlocks in that batch too. Its raw rows were overwritten by the
  final batch above, so treat it as a note, not a table row.
- Locking both rows in id order: 0 deadlocks, 0 errors, books reconciled in all 10 runs, and the fastest locking method.
- Why 40P01 never reached the client (measured, one direct probe): two opposite transfers (`pause_ms=500`, sent 50 ms
  apart) with curl straight to PostgREST's own port, bypassing the API gateway and supabase-js, through a copy of
  the unordered function that bumps a sequence on entry (sequences survive rollback). Result: Postgres counted 1
  deadlock, the function ran 3 times for 2 requests, both requests returned HTTP 200 and both transfers were applied
  exactly once (10/10 -> 12/8). So PostgREST itself re-runs a transaction aborted by a deadlock (PostgREST 14.18; not
  checked against its source or other versions). Practical effect: on Supabase a lock-order bug shows up as seconds
  of latency and, under load, pool timeouts for unrelated requests, not as deadlock errors in your logs.
- Approved counts differ between methods on the same plan because the commit order differs, and a wallet can be
  short at one moment and funded the next. "Refused" means insufficient funds, not an error. Naive approves more
  because stale reads pass the funds check. Naive makes 3 HTTP calls per transfer against 1 RPC, so its latency is
  not comparable.
- The id-order fix only holds if every code path that locks two wallets uses the same order; a plain multi-row
  UPDATE or another function locking src-then-dst can still deadlock against it.
- Not tested (review suggestions, open): hosted Free project (self-hosted only), SERIALIZABLE + retry,
  `lock_timeout`/`NOWAIT`, a single `UPDATE ... CASE` transfer, advisory locks, pool size and wallet-count sweeps
  (10 hot wallets here), more than 5 runs.

## How it runs

- Measured setup for every "self-hosted" number in this README: the official self-hosted Supabase stack under
  Podman in a local VM (Postgres 17.6, PostgREST behind the gateway at `127.0.0.1:8000`, 3 vCPU, 4 GB RAM).
  The harness runs on the VM's host machine, Node 22, `@supabase/supabase-js` 2.118.0.
- Schema and fixes: `sql/001_schema.sql`, `sql/002_queue_len.sql`, `sql/003_ledger.sql` (ledger for `--score`).
- Run: `./run.sh 10 100 --runs 5` (drain mode) and `BURST=1 ./run.sh 10 100 --runs 5` (burst mode).
  `run.sh` takes the key from your environment; no key is stored in this repo.
- Summaries: `python3 src/summarize.py results/run-full.jsonl`. Raw per-run rows are in `results/`.

Two workloads, each with N concurrent clients (one supabase-js client each, all in one Node process):

| Mode | Claim test | Spend test |
|---|---|---|
| Drain | 5N pending jobs; each worker claims until it gets nothing | wallet starts at 5N credits; each worker spends 1 until refused |
| Burst | N/2 pending jobs; each worker tries once | wallet starts at N/2; each worker tries once ("100 buyers, 50 in stock") |

Invariants: every job claimed exactly once and none left pending; successful spends equal the starting balance,
final balance 0. Violations = successes minus distinct jobs (claim) or successes minus starting balance (spend).
All tables have RLS on with no policies, so only the service_role key can touch them; every function has EXECUTE
revoked from `anon` and `authenticated`.

## Headline (measured, 5 runs each, mean)

| Test | N | Naive | Fixes |
|---|---|---|---|
| Burst claim, 50 jobs | 100 | 100 workers "got a job", only 11 distinct jobs, up to 40 left pending (89 double claims) | skip_locked, pgmq: 50/50 claimed once, 0 double claims |
| Burst spend, 50 credits | 100 | 100 spends approved (50 overspent), final balance still ~47 (97 lost updates) | conditional_update, for_update: exactly 50 approved, balance 0 |
| Drain claim, 500 jobs | 100 | 5,850 claims for 500 jobs (5,350 double claims, worst run 6,001) | all three fixes: 500 claims, 0 double claims |
| Drain spend, 500 credits | 100 | 28,222 spends approved against 500 credits; run took 95 s | both fixes: exactly 500, ~1.7-1.9 s |

## Per-solution results

Full tables: `results/summary-full.md` (drain) and `results/summary-burst.md` (burst). Calls/s counts every RPC
including the final "nothing left" call. Everything below the tables is measured unless it says hypothesis.

### Naive (the bug): `src/naive.ts`

```ts
const { data } = await sb.from('jobs').select('id').eq('status', 'pending').order('id').limit(1);
if (!data.length) return null;
await sb.from('jobs').update({ status: 'claimed', claimed_by: worker }).eq('id', data[0].id);
```

Fails at every N tested. N=10 drain: 184 double claims for 50 jobs; spend: 498 approved against 50 credits.
N=100 numbers are in the headline. Even N=10 burst (5 jobs) gave 9 double claims in every run.

### Fix (a) claim: single atomic UPDATE with a status re-check

```sql
update public.jobs set status = 'claimed', claimed_by = worker, claimed_at = now()
where id = (select id from public.jobs where status = 'pending' order by id limit 1)
  and status = 'pending'
returning id;
```

| Mode | N | Double claims | Claimed / jobs | Left pending (max) | Wall ms | p50 / p95 ms |
|---|---|---|---|---|---|---|
| Drain | 10 | 0 | 50/50 | 0 | 236 | 4.6 / 38.9 |
| Drain | 100 | 0 | 500/500 | 0 | 2,480 | 5.1 / 140.8 |
| Burst | 10 | 0 | 1/5 | 4 | 33 | 21.3 / 33.2 |
| Burst | 100 | 0 | 25/50 | 26 | 155 | 88.0 / 147.4 |

Never double claims, but it under-delivers: concurrent callers all pick the same first pending row, one wins, the
rest re-check, see `claimed`, and get NULL back even though other jobs are still pending. In burst mode at N=100 only
half the jobs got claimed. In drain mode (a worker stops at its first NULL) it left 0 pending in all 5 runs, but took about 5x as long as
SKIP LOCKED (2.5 s vs 0.5 s at N=100). Why drain never stranded a job while burst did is not established; hypothesis:
some worker was always still running when the last jobs were left. Use it for "update this one known row", not for
picking from a queue.

### Fix (a) spend: conditional decrement

```sql
update public.wallets set balance = balance - amount
where id = wallet and balance >= amount
returning balance;
```

| Mode | N | Overspend | Approved / credits | Final balance | Wall ms | p50 / p95 ms |
|---|---|---|---|---|---|---|
| Drain | 10 | 0 | 50/50 | 0 | 181 | 20.4 / 72.8 |
| Drain | 100 | 0 | 500/500 | 0 | 1,659 | 192.2 / 839.2 |
| Burst | 10 | 0 | 5/5 | 0 | 31 | 19.2 / 30.8 |
| Burst | 100 | 0 | 50/50 | 0 | 203 | 173.2 / 190.6 |

Here it is the right tool: the target row is known, so there is no "wrong row" problem. Fastest spend fix measured.

### Fix (b) claim: FOR UPDATE SKIP LOCKED

```sql
update public.jobs set status = 'claimed', claimed_by = worker, claimed_at = now()
where id = (select id from public.jobs where status = 'pending'
            order by id for update skip locked limit 1)
returning id;
```

| Mode | N | Double claims | Claimed / jobs | Left pending | Wall ms | Calls/s | p50 / p95 ms |
|---|---|---|---|---|---|---|---|
| Drain | 10 | 0 | 50/50 | 0 | 50 | 1,242 | 7.9 / 12.3 |
| Drain | 100 | 0 | 500/500 | 0 | 500 | 1,214 | 56.8 / 228.7 |
| Burst | 10 | 0 | 5/5 | 0 | 9 | 1,171 | 6.0 / 8.5 |
| Burst | 100 | 0 | 50/50 | 0 | 62 | 1,610 | 48.9 / 61.4 |

Correct and complete in every run, and the fastest claim method. Each caller locks a different row, so nobody waits.

### Fix (b) spend: SELECT ... FOR UPDATE then UPDATE in one function

```sql
select balance into b from public.wallets where id = wallet for update;
if b is null or b < amount then return null; end if;
update public.wallets set balance = b - amount where id = wallet;
```

| Mode | N | Overspend | Approved / credits | Final balance | Wall ms | p50 / p95 ms |
|---|---|---|---|---|---|---|
| Drain | 10 | 0 | 50/50 | 0 | 192 | 24.4 / 78.6 |
| Drain | 100 | 0 | 500/500 | 0 | 1,908 | 208.7 / 860.2 |
| Burst | 10 | 0 | 5/5 | 0 | 31 | 20.0 / 31.4 |
| Burst | 100 | 0 | 50/50 | 0 | 343 | 177.2 / 329.1 |

Correct. Slightly slower than the conditional decrement (two statements under the lock instead of one). Worth it
when the check is more than one comparison (several rows, a ledger insert, business rules).

### Fix (c) claim: pgmq

pgmq 1.5.1 ships in the self-hosted image (`create extension pgmq` worked). The RPC wraps `pgmq.pop`:

```sql
select (message->>'job')::bigint from pgmq.pop('suparace_jobs');
```

| Mode | N | Double claims | Claimed / msgs | Left in queue | Wall ms | Calls/s | p50 / p95 ms |
|---|---|---|---|---|---|---|---|
| Drain | 10 | 0 | 50/50 | 0 | 50 | 1,211 | 8.3 / 12.2 |
| Drain | 100 | 0 | 500/500 | 0 | 540 | 1,129 | 59.5 / 248.6 |
| Burst | 10 | 0 | 5/5 | 0 | 9 | 1,078 | 6.7 / 9.3 |
| Burst | 100 | 0 | 50/50 | 0 | 73 | 1,407 | 50.6 / 72.0 |

Same correctness as SKIP LOCKED and within about 10% on speed here. `pop` deletes on read, so a worker that crashes
after pop loses the message. `pgmq.read` with a visibility timeout plus `pgmq.delete` after the work is the
crash-safe version; not tested yet.

### What these numbers do not cover

- One Node process on the same machine as the database VM, over loopback. Real clients over the internet add round-trip time,
  which makes the naive read-write gap wider (hypothesis: more violations, not fewer).
- PostgREST's own DB pool sits between the clients and Postgres, so N=100 clients are not 100 DB connections.
- The p50/p95 at N=100 are mostly queueing in that pool, not Postgres work.
- Default READ COMMITTED only. SERIALIZABLE with retry, advisory locks, idempotency keys: not tested.

## Response-only vs invariant scoring

Question: would a race tool that only looks at HTTP responses (Turbo Intruder style) catch the naive burst spend?
Run: apply `sql/003_ledger.sql` (adds `spend_ledger`, one row per approved spend), then
`./run.sh 100 --runs 5 --score both` (also `response` or `invariant`). Same naive burst spend as the headline
(100 buyers, 50 credits, one try each), plus a ledger insert after each approved spend. Raw rows:
`results/score-both-*.json`. Measured 2026-10-21 ~03:19 EDT.

- (a) response-only: flags a run if any call is non-2xx, any call throws, or an approved spend returns a negative
  balance (wrong on its own).
- (b) invariant: flags a run if sum(ledger) > starting balance, final balance < 0, ledger rows != approved, or
  final balance != start - sum(ledger).

| Run | Approved / credits | HTTP calls, non-2xx | (a) flags? | Final balance | Ledger rows / sum | (b) flags? |
|---|---|---|---|---|---|---|
| 1 | 100 / 50 | 300, 0 | no | 44 | 100 / 100 | yes |
| 2 | 100 / 50 | 300, 0 | no | 48 | 100 / 100 | yes |
| 3 | 100 / 50 | 300, 0 | no | 49 | 100 / 100 | yes |
| 4 | 100 / 50 | 300, 0 | no | 48 | 100 / 100 | yes |
| 5 | 100 / 50 | 300, 0 | no | 47 | 100 / 100 | yes |
| Mean | 100 / 50 | 300, 0 | 0 of 5 | 47.2 | 100 / 100 | 5 of 5 |

Every response was 2xx and no approved spend returned a negative balance, so response-only scoring saw 100 clean
successes and flagged nothing. The invariant check failed two ways in every run: 100 credits approved against 50,
and the balance (mean 47.2) did not match 50 - 100 = -50 (lost updates). Balance never went negative and the
ledger matched the approved count, so those two checks alone would also have missed it.

The one response-level hint: across 100 reads only 3-6 distinct balances were seen (mean 4.2), so many buyers were
approved off the same balance. Spotting that needs the rule "each approval should see a lower balance", which is
the invariant again. Hypothesis: a response-only tool can only catch this class of bug when the tester already
knows the limit (here, "at most 50 approvals") and counts against it; the harness checks the DB, which knows it.

## Hosted free-tier reproduction

Run 2026-10-21 against a free hosted project (Free plan org, us-east-2, Postgres 17.11, max_connections 60)
from a client machine over the internet. Burst mode, N=100 clients, 50 items,
3 runs per method. Harness `src/hosted.ts` (same `naive.ts` / `fixed.ts` code as the VM runs; a client wrapper maps
`jobs` -> `suparace_jobs` and each RPC to its `suparace_` name). Schema `sql/hosted_free_tier.sql`, removed after
the run with `sql/hosted_drop.sql`; verified afterwards that no `suparace_` table, function or policy is left and
the project's own table is untouched. Only the project's anon key was available (no service_role key), so for the
run anon was granted access to the `suparace_` objects only. Raw rows: `results/hosted-burst-2026-10-21T07-24-04-984Z.json`.

The naive code fails on hosted Supabase the same way it fails on the local self-hosted stack.

| Test | Method | Violations hosted (mean / max) | Violations local VM (mean / max) | Hosted p50 / p95 ms | Local VM p50 / p95 ms | Hosted wall ms | Local VM wall ms |
|---|---|---|---|---|---|---|---|
| Claim, 50 jobs | naive | 96 / 97 double claims (3-6 distinct jobs, 44-47 left pending) | 89 / 90 (40 left pending max) | 291 / 1,444 * | 158 / 240 | 1,477 * | 252 |
| Claim, 50 jobs | skip_locked | 0 / 0 (50/50 claimed) | 0 / 0 | 162 / 203 | 49 / 61 | 208 | 62 |
| Spend, 50 credits | naive | 50 / 50 overspent, 99 lost updates mean, final balance 48-49 | 50 / 50, 97 lost updates | 291 / 377 | 186 / 332 | 396 | 344 |
| Spend, 50 credits | conditional_update | 0 / 0 (exactly 50 approved, balance 0) | 0 / 0 | 203 / 246 | 173 / 191 | 250 | 203 |

Means over 3 hosted runs and 5 local runs. * The first hosted call was a cold start (run 1 naive claim: p95 3,593 ms,
wall 3,647 ms); runs 2-3 alone: p95 370 ms, wall 392 ms. Hosted latency is mostly the internet round trip to
us-east-2 (each naive op is 2 HTTP calls, each fix 1). 0 HTTP errors in all 12 runs; the free tier did not throttle
a 100-client burst.

## Ideas not built yet (hypotheses, untested)

**Row safety across regions.**
- Read replicas: Supabase read replicas are asynchronous. A client that reads stock or balance from a replica and
  then writes to the primary is the naive bug again with a bigger window (replica lag). Rule: every check that guards
  a write runs on the primary, inside the same RPC as the write. Test idea: point the read half of the naive client
  at a replica (or a lagged copy) and measure violations against lag.
- Multi-master / multi-region writes: Postgres does not do this natively; with logical replication both ways
  (or a distributed Postgres), two regions can each approve the last unit and the conflict is found after commit.
  The fixes above are only safe per primary. Options to write up: one home region per row (route writes for a
  wallet to its owner region), conflict-free designs (append-only ledger, reconcile later), or escrow (split the
  balance across regions up front). Test idea: two VMs with bidirectional logical replication, same burst test.
- Hypothesis to check: Supavisor in transaction mode does not change these results, since each RPC is one
  transaction either way.

**RLS check.** The race fixes run as `security definer`, which bypasses RLS. That is a permissions hole if the
function does not check `auth.uid()` itself. Planned test matrix: for each RPC, call as anon, as user A on
user A's wallet, as user A on user B's wallet; expect allow/deny per row. Same idea as positive and negative
authorization tests against an IAM policy. Also check that the RPC is not callable at all by `anon` (EXECUTE is
revoked from anon in `sql/001_schema.sql`; the RLS matrix above confirms anon is denied).

## Roadmap

1. npm package with a `npx suparace init|run` CLI, then a thin GitHub Action over the CLI.
2. RLS matrix rerun on a free hosted project (so far self-hosted only).
3. Crash-safe pgmq (`read` + visibility timeout + `delete`): kill a worker mid-job, measure redelivery.
4. Exactly-once webhook processing (unique idempotency key + `insert ... on conflict do nothing`).
5. SERIALIZABLE + retry loop as a comparison row (claim, spend, transfer).
6. Transfer race on a free hosted project.

## License

MIT, see `LICENSE`. Not affiliated with or endorsed by Supabase.
