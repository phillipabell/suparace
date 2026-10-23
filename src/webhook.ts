// Exactly-once webhook processing race. Schema: sql/006_webhook.sql (remove with sql/006_webhook_drop.sql).
// Scenario: providers retry and redeliver, so the same event id can arrive K times at once. N handlers fire in one
// burst; handler i gets event (i mod E), E = ceil(N/K), so every event is delivered K times concurrently.
// Invariant: the side effect (a webhook_effects row) is applied exactly once per event.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { defineRace, type Race } from './lib.ts';
import type { Target } from './scenarios.ts';

type ProcessFn = (sb: SupabaseClient, eventId: string, worker: string) => Promise<boolean>;

/** The bug: check "already processed?", run the side effect, then mark it processed. Three HTTP calls, no
 *  transaction: every duplicate that checks before the first mark lands also runs the side effect. The mark is an
 *  upsert that ignores duplicates, as handlers commonly do, so nothing errors and every response is 2xx. */
export async function processWebhookNaive(sb: SupabaseClient, eventId: string, worker: string): Promise<boolean> {
  const { data, error } = await sb.from('webhook_events').select('event_id').eq('event_id', eventId).maybeSingle();
  if (error) throw error;
  if (data) return false;                                     // seen before: skip
  const { error: e2 } = await sb.from('webhook_effects').insert({ event_id: eventId, worker });  // side effect
  if (e2) throw e2;
  const { error: e3 } = await sb.from('webhook_events')
    .upsert({ event_id: eventId, processed_by: worker }, { onConflict: 'event_id', ignoreDuplicates: true });
  if (e3) throw e3;
  return true;
}

const rpcBool = (fn: string): ProcessFn => async (sb, eventId, worker) => {
  const { data, error } = await sb.rpc(fn, { p_event_id: eventId, p_worker: worker });
  if (error) throw error;
  return data === true;
};
/** Fix 1: unique event id + INSERT ... ON CONFLICT DO NOTHING RETURNING, side effect in the same function. */
export const processWebhookOnConflict = rpcBool('webhook_process_on_conflict');
/** Fix 2: pg_advisory_xact_lock on the event id, then check-then-insert under the lock. */
export const processWebhookAdvisory = rpcBool('webhook_process_advisory');

export const WEBHOOK: Record<string, ProcessFn> = {
  naive: processWebhookNaive, on_conflict: processWebhookOnConflict, advisory_lock: processWebhookAdvisory,
};
export const DEFAULT_K = 10;

const client = (t: Target) => createClient(t.url, t.key, { auth: { persistSession: false, autoRefreshToken: false } });

/** spec "naive", "on_conflict@100", ...: method plus optional deliveries per event K (default 10). */
export function parseWebhookSpec(spec: string): { method: string; k: number } {
  const [method, ks] = spec.split('@');
  const k = ks === undefined ? DEFAULT_K : Number(ks);
  if (!WEBHOOK[method]) throw new Error(`unknown webhook method ${method}`);
  if (!(Number.isInteger(k) && k >= 1)) throw new Error(`bad K in webhook:${spec}`);
  return { method, k };
}
export const webhookEvents = (n: number, k: number) => Math.max(1, Math.ceil(n / k));

export function webhookRace(t: Target, spec: string): Race {
  const { method, k } = parseWebhookSpec(spec);
  const fn = WEBHOOK[method];
  const admin = client(t);
  type Ctx = { events: number; perEvent?: Map<string, number>; marked?: number };
  return defineRace<Ctx, SupabaseClient, string>({
    name: `webhook:${method}@${k}`,
    expect: method === 'naive' ? 'violation' : 'clean',
    items: (n) => webhookEvents(n, k),
    setup: async ({ items }) => {
      const { error } = await admin.rpc('webhook_reset'); if (error) throw error;
      return { events: items };
    },
    worker: async () => { const sb = client(t); await sb.from('webhook_events').select('event_id').limit(1); return sb; },
    // one delivery per handler, also in drain mode (a webhook is delivered, not polled)
    actor: async (sb, ctx, i, attempt) => {
      if (attempt > 0) return null;
      const ev = `evt-${i % ctx.events}`;
      return (await fn(sb, ev, `h${i}`)) ? ev : null;
    },
    measure: async (ctx, o) => {
      const { data: eff, error: e1 } = await admin.from('webhook_effects').select('event_id').limit(100000);
      const { count, error: e2 } = await admin.from('webhook_events').select('event_id', { count: 'exact', head: true });
      if (e1 || e2) throw e1 ?? e2;
      const per = ctx.perEvent = new Map<string, number>();
      for (const r of eff as { event_id: string }[]) per.set(r.event_id, (per.get(r.event_id) ?? 0) + 1);
      ctx.marked = count ?? -1;
      const extra = [...per.values()].reduce((a, c) => a + Math.max(0, c - 1), 0);
      return { op: 'webhook', method, k, events: ctx.events, deliveries: o.attempts, side_effects: eff.length,
        double_processed: extra, events_double_processed: [...per.values()].filter((c) => c > 1).length,
        max_effects_per_event: Math.max(0, ...per.values()), events_marked: ctx.marked,
        handlers_reported_processed: o.successes.length, violations: extra };
    },
    // response scoring: no response hook, so only thrown errors flag it (naive returns 2xx on every call)
    invariants: (ctx, o) => {
      const per = ctx.perEvent!;
      return {
        effect_once_per_event: per.size === ctx.events && [...per.values()].every((c) => c === 1),
        every_event_marked: ctx.marked === ctx.events,
        processed_replies_eq_effects: o.successes.length === [...per.values()].reduce((a, c) => a + c, 0),
        no_errors: o.errors === 0,
      };
    },
  });
}
