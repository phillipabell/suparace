# Changelog

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
