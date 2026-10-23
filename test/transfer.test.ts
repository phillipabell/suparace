import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferPlan } from '../src/scenarios.ts';

test('transferPlan: same seed same plan, distinct wallets, both directions, amounts in range', () => {
  const a = transferPlan(100, 10, 5, 1), b = transferPlan(100, 10, 5, 1), c = transferPlan(100, 10, 5, 2);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const t of a) {
    assert.notEqual(t.src, t.dst);
    assert.ok(t.src >= 1 && t.src <= 10 && t.dst >= 1 && t.dst <= 10);
    assert.ok(t.amount >= 1 && t.amount <= 5);
  }
  const pairs = new Set(a.map((t) => `${t.src}>${t.dst}`));
  assert.ok(a.some((t) => pairs.has(`${t.dst}>${t.src}`)), 'some pair runs in both directions');
});
