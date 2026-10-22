// SupaRace library: define a race once, run it N-wide in burst or drain mode, score it two ways, get JSON + exit code.
//
//   const race = defineRace({ name, setup, worker, actor, invariants, response, measure, teardown, expect });
//   const report = await runRace(race, { n: 100, mode: 'burst', runs: 3 });
//   process.exit(exitCode(report));
//
// Lifecycle per run: setup(ctx) -> worker() for each of N workers (untimed: open connections, warm up) ->
// timed phase where every worker calls actor() (burst: once; drain: until it returns null or maxLoops) ->
// invariants() / response() / measure() on the outcome -> teardown().
//
// Scoring:
//   invariant: a run is flagged if any invariant check is false (reads DB state, knows the limit).
//   response:  a run is flagged if any response check is false or any actor call threw (what a tool that only
//              sees HTTP responses can know).
// Exit code: 0 when every run matches race.expect ('clean' = no flag, 'violation' = flagged), 1 otherwise.

export type Mode = 'burst' | 'drain';
export type Score = 'invariant' | 'response' | 'both';
export type Checks = Record<string, boolean>;
type Awaitable<T> = T | Promise<T>;

export interface RunInfo { n: number; mode: Mode; items: number; run: number }

export interface Outcome<R> {
  n: number; mode: Mode; items: number;
  /** every non-null value an actor returned, in completion order */
  successes: R[];
  /** successes grouped by worker index */
  byWorker: R[][];
  errors: number; attempts: number; wall_ms: number; latencies_ms: number[];
}

export interface RaceSpec<C, W, R> {
  name: string;
  /** reset the target and return a context shared by all hooks of this run */
  setup: (info: RunInfo) => Awaitable<C>;
  /** per-worker state (e.g. a supabase-js client). Awaited for all workers before timing starts. */
  worker?: (ctx: C, i: number) => Awaitable<W>;
  /** one attempt. Return a value on success, null when refused / nothing left (stops the worker), throw on error */
  actor: (w: W, ctx: C, i: number, attempt: number) => Promise<R | null>;
  /** DB-state checks. All must be true for the run to pass invariant scoring. */
  invariants: (ctx: C, out: Outcome<R>) => Awaitable<Checks>;
  /** response-only checks (no DB reads). Optional; errors > 0 always flags response scoring. */
  response?: (ctx: C, out: Outcome<R>) => Awaitable<Checks>;
  /** extra numbers for the report row (violations, final balance, ...) */
  measure?: (ctx: C, out: Outcome<R>) => Awaitable<Record<string, unknown>>;
  teardown?: (ctx: C, out: Outcome<R>) => Awaitable<void>;
  /** what CI should see. 'clean' (default) for the code under test; 'violation' for a known-bad control. */
  expect?: 'clean' | 'violation';
  /** items for a run; default burst N/2, drain 5N */
  items?: (n: number, mode: Mode) => number;
}

export interface RunOptions {
  n: number;
  mode?: Mode;
  runs?: number;
  /** drain-mode cap on attempts per worker (default 1000). Burst is always 1. */
  maxLoops?: number;
  score?: Score;
  /** called with each row as it completes */
  onRow?: (row: Row) => void;
}

export interface Row {
  race: string; mode: Mode; n: number; items: number; run: number;
  successes: number; errors: number; attempts: number; wall_ms: number; ops_per_s: number; p50_ms: number; p95_ms: number;
  invariants?: Checks; invariant_flag?: boolean; response?: Checks; response_flag?: boolean;
  flagged: boolean; pass: boolean;
  [k: string]: unknown;
}

export interface Report {
  suparace: string; race: string; expect: 'clean' | 'violation'; mode: Mode; n: number; runs: number; score: Score;
  rows: Row[]; flagged_runs: number; pass: boolean;
}

export type Race<C = any, W = any, R = any> = Required<Pick<RaceSpec<C, W, R>, 'name' | 'setup' | 'actor' | 'invariants'>> & RaceSpec<C, W, R>;

export function defineRace<C, W = undefined, R = unknown>(spec: RaceSpec<C, W, R>): Race<C, W, R> {
  for (const k of ['name', 'setup', 'actor', 'invariants'] as const) if (!spec[k]) throw new Error(`defineRace: ${k} is required`);
  return spec as Race<C, W, R>;
}

export const defaultItems = (n: number, mode: Mode) => Math.floor((mode === 'burst' ? 0.5 : 5) * n);

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const allTrue = (c: Checks) => Object.values(c).every(Boolean);

export async function runOnce<C, W, R>(race: Race<C, W, R>, info: RunInfo, maxLoops: number, score: Score): Promise<Row> {
  const ctx = await race.setup(info);
  const workers = await Promise.all(Array.from({ length: info.n }, (_, i) => race.worker ? race.worker(ctx, i) : (undefined as W)));
  const loops = info.mode === 'burst' ? 1 : maxLoops;
  const lat: number[] = []; const successes: R[] = []; const byWorker: R[][] = workers.map(() => []);
  let errors = 0;
  const t0 = performance.now();
  await Promise.all(workers.map(async (w, i) => {
    for (let k = 0; k < loops; k++) {
      const s = performance.now();
      try {
        const r = await race.actor(w, ctx, i, k); lat.push(performance.now() - s);
        if (r == null) break;
        successes.push(r); byWorker[i].push(r);
      } catch { errors++; lat.push(performance.now() - s); }
    }
  }));
  const wall = performance.now() - t0;
  const out: Outcome<R> = { n: info.n, mode: info.mode, items: info.items, successes, byWorker, errors,
    attempts: lat.length, wall_ms: wall, latencies_ms: lat };
  const row: Row = { race: race.name, mode: info.mode, n: info.n, items: info.items, run: info.run,
    successes: successes.length, errors, attempts: lat.length, wall_ms: Math.round(wall),
    ops_per_s: wall > 0 ? Math.round(lat.length / wall * 1000) : 0,
    p50_ms: +percentile(lat, .5).toFixed(1), p95_ms: +percentile(lat, .95).toFixed(1), flagged: false, pass: false };
  try {
    if (race.measure) Object.assign(row, await race.measure(ctx, out));
    let flagged = false;
    if (score !== 'response') {
      row.invariants = await race.invariants(ctx, out); row.invariant_flag = !allTrue(row.invariants); flagged ||= row.invariant_flag;
    }
    if (score !== 'invariant') {
      row.response = race.response ? await race.response(ctx, out) : {};
      row.response_flag = errors > 0 || !allTrue(row.response); flagged ||= row.response_flag;
    }
    row.flagged = flagged;
    row.pass = flagged === ((race.expect ?? 'clean') === 'violation');
  } finally {
    if (race.teardown) await race.teardown(ctx, out);
  }
  return row;
}

export async function runRace(race: Race, opts: RunOptions): Promise<Report> {
  const mode = opts.mode ?? 'burst', runs = opts.runs ?? 1, score = opts.score ?? 'invariant', maxLoops = opts.maxLoops ?? 1000;
  if (!(opts.n >= 1)) throw new Error('runRace: n must be >= 1');
  const items = (race.items ?? defaultItems)(opts.n, mode);
  const rows: Row[] = [];
  for (let r = 1; r <= runs; r++) {
    const row = await runOnce(race, { n: opts.n, mode, items, run: r }, maxLoops, score);
    rows.push(row); opts.onRow?.(row);
  }
  const flagged = rows.filter((x) => x.flagged).length;
  return { suparace: '0.2.0', race: race.name, expect: race.expect ?? 'clean', mode, n: opts.n, runs, score, rows,
    flagged_runs: flagged, pass: rows.every((x) => x.pass) };
}

/** 0 if every report passed (matched its expect), 1 otherwise */
export const exitCode = (reports: Report | Report[]) => ([] as Report[]).concat(reports).every((r) => r.pass) ? 0 : 1;
