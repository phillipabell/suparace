# Changelog

## Unreleased

- Crash-safe pgmq race (`src/crash.ts`, `sql/007_crash.sql`): P% of workers crash holding a job, P% stall past the
  visibility timeout. `pop` vs `read` + vt + archive without and with an `on conflict do nothing` guard. Invariants: no
  lost jobs, no double completion. `--race crash[:m@P]`, drain mode. Measured self-hosted N=100 x5 at P=10 and 30
  (README). Results `results/crash-drain-2026-10-23.json[l]`.
- Fix: `src/race.ts` imported `./scenarios.ts` twice.
- Two-wallet transfer scenario (`transferRace`, `sql/005_transfer.sql`): naive client read-then-write, `FOR UPDATE` in
  caller order, and the fix (both rows locked in id order in one function). Invariants: total constant, no negative
  balance, no deadlock (client 40P01 or `pg_stat_database.deadlocks` delta), no client error. `--race transfer`,
  `transfer:<method>@<pause_ms>`. Measured self-hosted burst N=100 x5 (README).
- Exactly-once webhook race (`src/webhook.ts`, `sql/006_webhook.sql`): same event id delivered K times at once;
  naive check-then-process vs `insert ... on conflict do nothing returning` vs advisory lock. `--race webhook[:m@K]`.
  Measured self-hosted N=100 burst x5 at K=2/10/100: naive 44.8 / 67.8 / 71.2 extra side effects (mean), both
  fixes 0 in every run. Results `results/webhook-burst-2026-10-22.json[l]`.
- Tests: 17.

## 0.3.0 (2026-10-22)

- npm packaging: `bin: suparace`, compiled ESM JS + `.d.ts` in `dist/` (no TypeScript needed to use it), Node >=22
  (supabase-js 2.118 requires it). Library exports kept (`suparace`, `suparace/scenarios`, `suparace/cli`).
- `suparace init` writes `suparace/quickstart.sql` + `suparace/spend.race.mjs` (naive vs atomic spend).
- `suparace run [files|dirs]`: loads `*.race.{mjs,js,ts,mts}`, env `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
  PASS/FAIL lines, `--json` / `--out`, exit 0/1/2.
- README 5-minute quickstart, timed on a local Podman stack (6.5 s of command time); cloud timing is a hypothesis.
- Tests: 13 (6 new CLI tests).

## 0.2.0 (2026-10-22)

- Library API (`src/lib.ts`): `defineRace({ setup, worker, actor, invariants, response, measure, teardown, expect })`,
  `runRace(race, { n, mode: 'burst' | 'drain', runs, maxLoops, score })`, `exitCode(reports)`.
- Response-only vs invariant scoring on any race (`score: 'response' | 'invariant' | 'both'`).
- CI output: JSON row per run, JSON report with per-race pass/fail, exit code 0/1 (2 = bad config).
- v0.1 claim, spend and ledger (`--score`) scenarios ported onto the library (`src/scenarios.ts`); results match v0.1
  (burst N=100 x3, see README "v0.2 port check").
- Claim races gain a `none_left` invariant, so `atomic_update`'s burst stall now fails CI.
- Tests: `npm test` (node:test, 7 tests, no database needed).
- RLS matrix (`src/rls.ts`, `sql/004_rls.sql`): claim and spend as anon / user A / user B / service_role with real
  JWTs from throwaway users (created and deleted per run). INVOKER vs DEFINER (unchecked, checked) fixes.

## 0.1.0 (2026-10-21)

- Schema, naive client code, Postgres RPC fixes (atomic update, SKIP LOCKED, pgmq, conditional decrement, FOR UPDATE),
  race harness, burst and drain measurements, hosted free-tier reproduction.
