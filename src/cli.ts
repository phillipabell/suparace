// suparace CLI (the npm bin). `suparace init` writes an example; `suparace run` runs race files.
// Repo-local v0.1/v0.2 scenario runner is src/race.ts (./run.sh), unchanged.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { defineRace, runRace, exitCode, type Mode, type Score, type Race, type Report } from './lib.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const RACE_FILE = /\.race\.(mjs|js|ts|mts)$/;

const HELP = `suparace ${VERSION}: race tests for supabase-js read-then-write bugs

Usage:
  suparace init [dir]        write <dir>/quickstart.sql and <dir>/spend.race.mjs (default dir: suparace)
  suparace run [files|dirs]  run race files (default: suparace/*.race.{mjs,js,ts,mts})

run options:
  --race a,b                 only races with these names
  --n N                      concurrent clients (default 50, or the race's defaults.n)
  --runs R                   runs per race (default 3)
  --mode burst|drain         burst: N/2 items, one try per client (default). drain: 5N items, loop until refused
  --score invariant|response|both   default invariant
  --out FILE                 also write the JSON report to FILE
  --json                     print the JSON report on stdout

Environment (run): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY); optional SUPABASE_ANON_KEY.
Race files get ({ client, anonClient, env }); client() is a new supabase-js client with the service role key.
Exit code: 0 every race matched its expect, 1 a race failed, 2 bad config. Never point it at production data.`;

class ConfigError extends Error {}
const fail = (m: string): never => { throw new ConfigError(m); };

export interface Helpers {
  client: () => SupabaseClient;
  anonClient: () => SupabaseClient;
  env: NodeJS.ProcessEnv;
}

export function helpers(env: NodeJS.ProcessEnv = process.env): Helpers {
  const url = env.SUPABASE_URL ?? env.SUPARACE_URL;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const mk = (key: string | undefined, name: string) => () => {
    if (!url) fail('set SUPABASE_URL (your project API URL)');
    if (!key) fail(`set ${name}`);
    return createClient(url!, key!, opts);
  };
  return {
    client: mk(env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_KEY ?? env.SUPARACE_KEY, 'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)'),
    anonClient: mk(env.SUPABASE_ANON_KEY ?? env.SUPARACE_ANON_KEY, 'SUPABASE_ANON_KEY'),
    env,
  };
}

export function init(dir = 'suparace', log = console.log): string[] {
  mkdirSync(dir, { recursive: true });
  const wrote: string[] = [];
  for (const f of ['quickstart.sql', 'spend.race.mjs']) {
    const dest = join(dir, f);
    if (existsSync(dest)) { log(`exists, left as is: ${dest}`); continue; }
    copyFileSync(join(ROOT, 'templates', f), dest); wrote.push(dest); log(`wrote ${dest}`);
  }
  return wrote;
}

export function findRaceFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths.length ? paths : ['suparace']) {
    if (!existsSync(p)) fail(paths.length ? `not found: ${p}` : 'no race files: run `suparace init` first, or pass files');
    if (statSync(p).isDirectory()) out.push(...readdirSync(p).filter((f) => RACE_FILE.test(f)).sort().map((f) => join(p, f)));
    else out.push(p);
  }
  if (!out.length) fail(`no *.race.{mjs,js,ts,mts} files in ${paths.join(' ') || 'suparace'}`);
  return out;
}

type RaceWithDefaults = Race & { defaults?: { n?: number; mode?: Mode; runs?: number } };

export async function loadRaces(files: string[], h: Helpers): Promise<RaceWithDefaults[]> {
  const races: RaceWithDefaults[] = [];
  for (const f of files) {
    let mod: any;
    try { mod = await import(pathToFileURL(resolve(f)).href); }
    catch (e: any) {
      const ts = /\.m?ts$/.test(f) ? ' (.ts race files need Node 22.18+ and erasable TypeScript only; or use .mjs)' : '';
      fail(`cannot load ${f}: ${e?.message ?? e}${ts}`);
    }
    let exp = mod.default;
    if (exp === undefined) fail(`${f}: no default export (export a race, an array of races, or ({ client }) => races)`);
    if (typeof exp === 'function') exp = await exp(h);
    for (const r of ([] as any[]).concat(exp)) {
      try { races.push(defineRace(r) as RaceWithDefaults); } catch (e: any) { fail(`${f}: ${e.message}`); }
    }
  }
  const names = races.map((r) => r.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) fail(`duplicate race name ${dup}`);
  return races;
}

function parse(argv: string[]) {
  const a = [...argv];
  const flag = (name: string) => { const i = a.indexOf(name); return i >= 0 ? (a.splice(i, 1), true) : false; };
  const opt = (name: string) => {
    const i = a.indexOf(name); if (i < 0) return undefined;
    const v = a[i + 1]; if (v === undefined || v.startsWith('--')) fail(`${name} needs a value`);
    a.splice(i, 2); return v;
  };
  const o = { race: opt('--race'), n: opt('--n'), runs: opt('--runs'), mode: opt('--mode'), score: opt('--score'),
    out: opt('--out'), json: flag('--json') };
  const unknown = a.find((x) => x.startsWith('--')); if (unknown) fail(`unknown option ${unknown}`);
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const x = Number(v); if (!(Number.isInteger(x) && x >= 1)) fail(`${name} must be a whole number >= 1`); return x;
  };
  if (o.mode && !['burst', 'drain'].includes(o.mode)) fail(`bad --mode ${o.mode}`);
  if (o.score && !['invariant', 'response', 'both'].includes(o.score)) fail(`bad --score ${o.score}`);
  return { files: a, race: o.race?.split(','), n: num(o.n, '--n'), runs: num(o.runs, '--runs'),
    mode: o.mode as Mode | undefined, score: o.score as Score | undefined, out: o.out, json: o.json };
}

export async function run(argv: string[], env = process.env, log = (s: string) => console.error(s)): Promise<{ code: number; reports: Report[] }> {
  const o = parse(argv);
  let races = await loadRaces(findRaceFiles(o.files), helpers(env));
  if (o.race) {
    const missing = o.race.filter((r) => !races.some((x) => x.name === r));
    if (missing.length) fail(`no race named ${missing.join(', ')} (have: ${races.map((r) => r.name).join(', ')})`);
    races = races.filter((r) => o.race!.includes(r.name));
  }
  const reports: Report[] = [];
  for (const race of races) {
    const n = o.n ?? race.defaults?.n ?? 50, mode = o.mode ?? race.defaults?.mode ?? 'burst', runs = o.runs ?? race.defaults?.runs ?? 3;
    const t0 = performance.now();
    const rep = await runRace(race, { n, mode, runs, score: o.score ?? 'invariant' });
    reports.push(rep);
    const bad = new Set<string>();
    for (const row of rep.rows) for (const [k, v] of Object.entries({ ...row.invariants, ...row.response })) if (!v) bad.add(k);
    const errs = rep.rows.reduce((s, r) => s + r.errors, 0);
    log(`${rep.pass ? 'PASS' : 'FAIL'} ${race.name}  N=${n} ${mode} expect=${rep.expect}  flagged ${rep.flagged_runs}/${runs}` +
      (bad.size ? `  failed: ${[...bad].join(', ')}` : '') + (errs ? `  errors: ${errs}` : '') +
      `  successes/run: ${rep.rows.map((r) => r.successes).join(',')}  ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
  const code = exitCode(reports);
  const summary = { suparace: VERSION, pass: code === 0, reports };
  if (o.out) { const { writeFileSync } = await import('node:fs'); writeFileSync(o.out, JSON.stringify(summary, null, 1)); log(`wrote ${o.out}`); }
  if (o.json) console.log(JSON.stringify(summary));
  return { code, reports };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return cmd ? 0 : 2; }
    if (cmd === '--version' || cmd === '-v') { console.log(VERSION); return 0; }
    if (cmd === 'init') { init(rest[0]); console.log('next: run quickstart.sql in your project, then `npx suparace run`'); return 0; }
    if (cmd === 'run') return (await run(rest)).code;
    fail(`unknown command ${cmd} (try --help)`);
  } catch (e: any) {
    console.error(e instanceof ConfigError ? `suparace: ${e.message}`
      : `suparace: error: ${e?.message ?? JSON.stringify(e)}${e?.hint ? ` (hint: ${e.hint})` : ''}`);
    return 2;
  }
  return 2;
}

