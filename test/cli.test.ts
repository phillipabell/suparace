// CLI tests: init writes the example, run loads race files and returns the right exit code. No Supabase needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, run, findRaceFiles, loadRaces, helpers } from '../src/cli.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'suparace-cli-'));
const quiet = () => {};
const tick = () => new Promise((r) => setImmediate(r));

// in-memory spend race as a race file (function export; no import of suparace needed)
const RACE = (kind: string) => `
export default () => ['naive', 'atomic'].map((kind) => ({
  name: 'mem:' + kind, defaults: { n: 20, runs: 2 },
  setup: ({ items }) => ({ balance: items, start: items }),
  actor: async (_w, db) => {
    if (kind === 'atomic') { await new Promise((r) => setImmediate(r)); if (db.balance < 1) return null; return --db.balance; }
    const read = db.balance; await new Promise((r) => setImmediate(r)); if (read < 1) return null; db.balance = read - 1; return read - 1;
  },
  invariants: (db, o) => ({ no_overspend: o.successes.length <= db.start, balance_matches: db.balance === db.start - o.successes.length }),
}));`;

test('init writes the SQL and race file, never overwrites', () => {
  const d = join(tmp(), 'suparace');
  assert.equal(init(d, quiet).length, 2);
  assert.match(readFileSync(join(d, 'quickstart.sql'), 'utf8'), /create or replace function public\.suparace_spend/);
  writeFileSync(join(d, 'spend.race.mjs'), '// mine');
  assert.equal(init(d, quiet).length, 0);
  assert.equal(readFileSync(join(d, 'spend.race.mjs'), 'utf8'), '// mine');
});

test('the init race file loads and builds two races with lazy clients', async () => {
  const d = join(tmp(), 'suparace'); init(d, quiet);
  const env = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'x' };
  const races = await loadRaces(findRaceFiles([d]), helpers(env));
  assert.deepEqual(races.map((r) => r.name), ['spend:naive', 'spend:atomic']);
});

test('missing env is a config error naming the variable', async () => {
  const d = join(tmp(), 'suparace'); init(d, quiet);
  await assert.rejects(run([d], {}, quiet), /SUPABASE_URL/);
});

test('run: naive fails (exit 1), atomic passes (exit 0), --race filters, --out writes JSON', async () => {
  const d = tmp(); writeFileSync(join(d, 'mem.race.mjs'), RACE(''));
  const lines: string[] = [];
  const all = await run([d], {}, (s) => lines.push(s));
  assert.equal(all.code, 1);
  assert.match(lines.join('\n'), /FAIL mem:naive .*failed: no_overspend/);
  assert.match(lines.join('\n'), /PASS mem:atomic/);
  const out = join(d, 'r.json');
  const fixed = await run([d, '--race', 'mem:atomic', '--n', '10', '--runs', '1', '--out', out], {}, quiet);
  assert.equal(fixed.code, 0);
  assert.equal(fixed.reports[0].n, 10);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).pass, true);
});

test('bad flags and unknown races are config errors', async () => {
  const d = tmp(); writeFileSync(join(d, 'mem.race.mjs'), RACE(''));
  await assert.rejects(run([d, '--race', 'nope'], {}, quiet), /no race named nope/);
  await assert.rejects(run([d, '--n', '0'], {}, quiet), /--n must be/);
  await assert.rejects(run([d, '--mode', 'x'], {}, quiet), /bad --mode/);
  await assert.rejects(run([join(d, 'missing.race.mjs')], {}, quiet), /not found/);
});

test('a .ts race file loads (Node strips types outside node_modules)', async () => {
  const d = tmp();
  writeFileSync(join(d, 'one.race.ts'), `const n: number = 1;
export default { name: 'ts:one', setup: () => ({}), actor: async (): Promise<number | null> => n, invariants: () => ({ ok: true }) };`);
  const races = await loadRaces(findRaceFiles([d]), helpers({}));
  assert.equal(races[0].name, 'ts:one');
});
