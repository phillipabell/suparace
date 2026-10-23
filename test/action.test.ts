// The GitHub Action's shell steps, run locally with a stub CLI (no Supabase, no GitHub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore -- plain .mjs helper
import { summary } from '../action/summary.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const report = (pass: boolean) => ({ suparace: '0.3.0', pass, reports: [{
  race: 'spend:naive', expect: 'clean', mode: 'burst', n: 50, runs: 3, flagged_runs: pass ? 0 : 3, pass,
  rows: [{ successes: pass ? 25 : 50, invariants: { no_overspend: pass } }] }] });

test('summary lists failed checks and the verdict', () => {
  const md = summary(report(false), 1);
  assert.match(md, /SupaRace FAIL/);
  assert.match(md, /\| spend:naive \| \*\*FAIL\*\* \| clean \| 50 \| burst \| 3\/3 \| no_overspend \| 50 \|/);
  assert.match(summary(null, 2), /bad config or the target was unreachable/);
});

test('stack-env maps both key naming schemes', () => {
  const d = mkdtempSync(join(tmpdir(), 'sr-'));
  writeFileSync(join(d, 'old.env'), 'API_URL="http://127.0.0.1:54321"\nSERVICE_ROLE_KEY="srk"\nANON_KEY="ak"\nDB_URL="postgresql://x"\n');
  writeFileSync(join(d, 'new.env'), 'API_URL="http://127.0.0.1:54321"\nSECRET_KEY="sk"\nPUBLISHABLE_KEY="pk"\n');
  const sh = join(ROOT, 'action/stack-env.sh');
  assert.equal(execFileSync('bash', [sh, join(d, 'old.env')], { encoding: 'utf8' }),
    'SUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_SERVICE_ROLE_KEY=srk\nSUPABASE_ANON_KEY=ak\nSUPARACE_DB_URL=postgresql://x\n');
  assert.match(execFileSync('bash', [sh, join(d, 'new.env')], { encoding: 'utf8' }), /SERVICE_ROLE_KEY=sk\nSUPABASE_ANON_KEY=pk\n$/);
  writeFileSync(join(d, 'bad.env'), 'DB_URL="x"\n');
  assert.equal(spawnSync('bash', [sh, join(d, 'bad.env')]).status, 2);
});

function runStep(code: number, pass: boolean) {
  const ap = mkdtempSync(join(tmpdir(), 'sr-action-'));
  mkdirSync(join(ap, 'src')); mkdirSync(join(ap, 'action'));
  copyFileSync(join(ROOT, 'action/summary.mjs'), join(ap, 'action/summary.mjs'));
  // Stub CLI: record argv, write the report named by --out, exit with the given code.
  writeFileSync(join(ap, 'src/bin.ts'), `import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2); writeFileSync(${JSON.stringify(join(ap, 'argv.json'))}, JSON.stringify(a));
writeFileSync(a[a.indexOf('--out') + 1], ${JSON.stringify(JSON.stringify(report(pass)))}); process.exit(${code});`);
  const out = join(ap, 'gh_output'), sum = join(ap, 'summary.md');
  const r = spawnSync('bash', [join(ROOT, 'action/run.sh')], { cwd: ap, encoding: 'utf8', env: { ...process.env,
    ACTION_PATH: ap, RACES: 'suparace extra.race.mjs', RACE: 'spend:naive', N: '20', RUNS: '', MODE: 'burst', SCORE: '',
    REPORT: 'rep.json', CLI: 'action', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum } });
  return { r, argv: JSON.parse(readFileSync(join(ap, 'argv.json'), 'utf8')), output: readFileSync(out, 'utf8'), md: readFileSync(sum, 'utf8') };
}

test('run step passes inputs through, keeps the CLI exit code, writes outputs and summary', () => {
  const ok = runStep(0, true);
  assert.equal(ok.r.status, 0);
  assert.deepEqual(ok.argv, ['run', 'suparace', 'extra.race.mjs', '--race', 'spend:naive', '--n', '20', '--mode', 'burst', '--out', 'rep.json']);
  assert.equal(ok.output, 'pass=true\n');
  assert.match(ok.md, /SupaRace PASS/);
  const bad = runStep(1, false);
  assert.equal(bad.r.status, 1);
  assert.equal(bad.output, 'pass=false\n');
  assert.match(bad.r.stdout, /::error::SupaRace: a race broke an invariant/);
  assert.match(bad.md, /\*\*FAIL\*\*/);
});
