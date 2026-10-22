// Library tests with an in-memory "database": no Supabase needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineRace, runRace, exitCode, percentile, defaultItems } from '../src/lib.ts';

const tick = () => new Promise((r) => setImmediate(r));

// A wallet whose naive spend reads, yields (like an HTTP round trip), then writes a stale value.
function walletRace(kind: 'naive' | 'atomic') {
  return defineRace<{ balance: number; start: number }, undefined, number>({
    name: `mem-spend:${kind}`,
    expect: kind === 'naive' ? 'violation' : 'clean',
    setup: ({ items }) => ({ balance: items, start: items }),
    actor: async (_w, db) => {
      if (kind === 'atomic') { await tick(); if (db.balance < 1) return null; return --db.balance; }
      const read = db.balance; await tick();
      if (read < 1) return null;
      db.balance = read - 1; return read - 1;
    },
    response: (_db, o) => ({ no_negative: o.successes.every((b) => b >= 0) }),
    invariants: (db, o) => ({ approved_le_start: o.successes.length <= db.start, conserved: db.balance === db.start - o.successes.length }),
    measure: (db, o) => ({ final_balance: db.balance, violations: Math.max(0, o.successes.length - db.start) }),
  });
}

test('defineRace rejects missing hooks', () => {
  assert.throws(() => defineRace({ name: 'x' } as any), /setup is required/);
});

test('burst: one attempt per worker, N/2 items; naive overspends, invariant flags it, response does not', async () => {
  const rep = await runRace(walletRace('naive'), { n: 100, mode: 'burst', runs: 3, score: 'both' });
  assert.equal(rep.rows.length, 3);
  for (const r of rep.rows) {
    assert.equal(r.items, 50); assert.equal(r.attempts, 100);
    assert.equal(r.successes, 100);                // every worker read 50 before anyone wrote
    assert.equal(r.violations, 50);
    assert.equal(r.invariant_flag, true); assert.equal(r.response_flag, false);
    assert.equal(r.pass, true);                    // expected violation, got one
  }
  assert.equal(rep.flagged_runs, 3); assert.equal(exitCode(rep), 0);
});

test('drain: workers loop until refused; atomic version is clean and exact', async () => {
  const rep = await runRace(walletRace('atomic'), { n: 10, mode: 'drain', runs: 2 });
  for (const r of rep.rows) {
    assert.equal(r.items, 50); assert.equal(r.successes, 50); assert.equal(r.final_balance, 0);
    assert.equal(r.attempts, 60);                  // 50 successes + one refusal per worker
    assert.equal(r.invariant_flag, false); assert.equal(r.response_flag, undefined);
  }
  assert.equal(exitCode(rep), 0);
});

test('exit code 1 when a clean-expected race is flagged, or a control fails to reproduce', async () => {
  const bad = { ...walletRace('naive'), expect: 'clean' as const };
  assert.equal(exitCode(await runRace(bad, { n: 20, runs: 1 })), 1);
  const control = { ...walletRace('atomic'), expect: 'violation' as const };
  assert.equal(exitCode(await runRace(control, { n: 20, runs: 1 })), 1);
});

test('thrown actor errors count and flag response scoring; maxLoops caps drain', async () => {
  let calls = 0;
  const r = defineRace({ name: 'err', setup: () => ({}), invariants: () => ({ ok: true }),
    actor: async () => { if (++calls % 2) throw new Error('boom'); return 1; } });
  const rep = await runRace(r, { n: 4, mode: 'drain', maxLoops: 3, score: 'both' });
  assert.equal(rep.rows[0].attempts, 12); assert.equal(rep.rows[0].errors, 6);
  assert.equal(rep.rows[0].response_flag, true); assert.equal(rep.rows[0].invariant_flag, false);
  assert.equal(exitCode(rep), 1);
});

test('teardown runs even when measure throws', async () => {
  let torn = false;
  const r = defineRace({ name: 't', setup: () => ({}), actor: async () => null, invariants: () => ({}),
    measure: () => { throw new Error('db gone'); }, teardown: () => { torn = true; } });
  await assert.rejects(runRace(r, { n: 1 }), /db gone/); assert.equal(torn, true);
});

test('helpers', () => {
  assert.equal(percentile([], .5), 0); assert.equal(percentile([3, 1, 2], .5), 2);
  assert.equal(defaultItems(100, 'burst'), 50); assert.equal(defaultItems(100, 'drain'), 500);
});
