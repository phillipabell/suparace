// Crash race config tests (no Supabase needed). The measured runs are in README "Crash-safe pgmq".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrashSpec, crashCount, roleOf, crashRace, DEFAULT_PCT } from '../src/crash.ts';

test('parseCrashSpec: method, optional @P, rejects bad input', () => {
  assert.deepEqual(parseCrashSpec('pop'), { method: 'pop', pct: DEFAULT_PCT });
  assert.deepEqual(parseCrashSpec('read_archive@20'), { method: 'read_archive', pct: 20 });
  assert.deepEqual(parseCrashSpec('read_no_dedupe@0'), { method: 'read_no_dedupe', pct: 0 });
  assert.throws(() => parseCrashSpec('nope'), /unknown crash method/);
  assert.throws(() => parseCrashSpec('pop@51'), /bad percent/);
  assert.throws(() => parseCrashSpec('pop@x'), /bad percent/);
});

test('crashCount and roleOf: P% crash, next P% stall, at least 1 when P > 0', () => {
  assert.equal(crashCount(100, 10), 10);
  assert.equal(crashCount(10, 1), 1);
  assert.equal(crashCount(100, 0), 0);
  assert.deepEqual([0, 9, 10, 19, 20].map((i) => roleOf(i, 10)), ['crash', 'crash', 'stall', 'stall', 'ok']);
  assert.equal(roleOf(0, 0), 'ok');
});

test('crashRace: name, expect, items', () => {
  const t = { url: 'http://127.0.0.1:1', key: 'x' };
  const pop = crashRace(t, 'pop'), half = crashRace(t, 'read_no_dedupe@20'), fix = crashRace(t, 'read_archive');
  assert.equal(pop.name, `crash:pop@${DEFAULT_PCT}`); assert.equal(pop.expect, 'violation');
  assert.equal(half.expect, 'violation'); assert.equal(fix.expect, 'clean');
  assert.equal(fix.items!(100, 'drain'), 200);
});
