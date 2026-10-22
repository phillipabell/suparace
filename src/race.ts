// SupaRace CLI over the library (src/lib.ts) and the v0.1 scenarios (src/scenarios.ts).
// Usage: SUPARACE_URL=... SUPARACE_KEY=<service_role> node src/race.ts [N...] [options]
//   --mode burst|drain   burst: N/2 items, one try per worker. drain: 5N items, loop until refused. Default drain
//                        (v0.1 default); BURST=1 in the env also selects burst.
//   --runs R             runs per race per N (default 3)
//   --race a,b           claim:<method>, spend:<method>, spend-ledger, or claim / spend for all methods.
//                        Default: claim + spend (all methods).
//   --score invariant|response|both   default invariant. Given alone (no --race), runs spend-ledger in burst mode,
//                        which is the v0.1 --score behaviour.
//   --out FILE           report path (default results/race-[burst-]<stamp>.json; '-' = stdout only)
// Output: one JSON row per run on stdout, a JSON report file, exit code 0 if every race matched its expect
// (fixes: no flagged run; naive controls: every run flagged), 1 otherwise, 2 on bad config.
import { writeFileSync } from 'node:fs';
import { runRace, exitCode, type Mode, type Score, type Report, type Race } from './lib.ts';
import { CLAIM, SPEND, claimRace, spendRace, spendLedgerRace, type Target } from './scenarios.ts';

const die = (m: string) => { console.error(m); process.exit(2); };
const url = process.env.SUPARACE_URL ?? 'http://127.0.0.1:8000', key = process.env.SUPARACE_KEY;
if (!key) die('set SUPARACE_KEY (service_role key)');
const t: Target = { url, key: key! };

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const runs = Number(opt('--runs') ?? 3);
const score = (opt('--score') ?? '') as Score | '';
let raceArg = opt('--race');
const out = opt('--out');
let mode = (opt('--mode') ?? (process.env.BURST === '1' ? 'burst' : 'drain')) as Mode;
if (score && !raceArg) { raceArg = 'spend-ledger'; mode = 'burst'; }
if (!['burst', 'drain'].includes(mode)) die(`bad --mode ${mode}`);
if (score && !['invariant', 'response', 'both'].includes(score)) die(`bad --score ${score}`);
const ns = args.length ? args.map(Number) : [10, 100];
if (ns.some((n) => !(n >= 1))) die(`bad N in ${args.join(' ')}`);

function races(): Race[] {
  const names = (raceArg ?? 'claim,spend').split(',').flatMap((r) =>
    r === 'claim' ? Object.keys(CLAIM).map((m) => `claim:${m}`) : r === 'spend' ? Object.keys(SPEND).map((m) => `spend:${m}`) : [r]);
  return names.map((r) => {
    const [op, m] = r.split(':');
    if (op === 'claim') return claimRace(t, m);
    if (op === 'spend') return spendRace(t, m);
    if (op === 'spend-ledger') return spendLedgerRace(t);
    return die(`unknown race ${r}`) as never;
  });
}

const reports: Report[] = [];
const list = races();
// v0.1 order: for each N, for each run, every method. Keep it (interleaves methods so drift hits all of them).
for (const n of ns) {
  const byRace = new Map<Race, Report>();
  for (let r = 1; r <= runs; r++) for (const race of list) {
    const rep = await runRace(race, { n, mode, runs: 1, score: score || 'invariant' });
    const row = { ...rep.rows[0], run: r };
    console.log(JSON.stringify(row));
    const acc = byRace.get(race);
    if (acc) { acc.rows.push(row); acc.runs++; acc.flagged_runs += row.flagged ? 1 : 0; acc.pass &&= row.pass; }
    else byRace.set(race, { ...rep, rows: [row] });
  }
  reports.push(...byRace.values());
}
const code = exitCode(reports);
const summary = { suparace: '0.2.0', target: url.replace(/\/\/[^@/]*@/, '//'), mode, score: score || 'invariant', ns, runs,
  pass: code === 0, races: reports.map((r) => ({ race: r.race, n: r.n, expect: r.expect, runs: r.runs, flagged_runs: r.flagged_runs, pass: r.pass })),
  reports };
if (out !== '-') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = out ?? `results/race-${score ? `score-${score}-` : ''}${mode === 'burst' ? 'burst-' : ''}${stamp}.json`;
  writeFileSync(file, JSON.stringify(summary, null, 1));
  console.error(`wrote ${file}`);
}
for (const r of summary.races) console.error(`${r.pass ? 'PASS' : 'FAIL'} ${r.race} N=${r.n} expect=${r.expect} flagged ${r.flagged_runs}/${r.runs}`);
process.exit(code);
