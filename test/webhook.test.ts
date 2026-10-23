// Webhook race config tests (no Supabase needed). The measured runs are in README "Exactly-once webhook processing".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhookSpec, webhookEvents, webhookRace, DEFAULT_K } from '../src/webhook.ts';

test('parseWebhookSpec: method, optional @K, rejects bad input', () => {
  assert.deepEqual(parseWebhookSpec('naive'), { method: 'naive', k: DEFAULT_K });
  assert.deepEqual(parseWebhookSpec('on_conflict@100'), { method: 'on_conflict', k: 100 });
  assert.throws(() => parseWebhookSpec('nope'), /unknown webhook method/);
  assert.throws(() => parseWebhookSpec('naive@0'), /bad K/);
  assert.throws(() => parseWebhookSpec('naive@x'), /bad K/);
});

test('webhookEvents: ceil(N/K) events, at least 1', () => {
  assert.equal(webhookEvents(100, 2), 50);
  assert.equal(webhookEvents(100, 10), 10);
  assert.equal(webhookEvents(100, 100), 1);
  assert.equal(webhookEvents(100, 300), 1);
  assert.equal(webhookEvents(10, 3), 4);
});

test('webhookRace: name, expect, items', () => {
  const t = { url: 'http://127.0.0.1:1', key: 'x' };
  const naive = webhookRace(t, 'naive@2'), fixed = webhookRace(t, 'advisory_lock');
  assert.equal(naive.name, 'webhook:naive@2'); assert.equal(naive.expect, 'violation');
  assert.equal(fixed.name, `webhook:advisory_lock@${DEFAULT_K}`); assert.equal(fixed.expect, 'clean');
  assert.equal(naive.items!(100, 'burst'), 50); assert.equal(fixed.items!(100, 'drain'), 10);
});
