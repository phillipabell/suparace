-- Exactly-once webhook processing race (src/webhook.ts). Same event id delivered K times at once.
-- webhook_events: one row per processed event id (the dedupe key; primary key = unique event id).
-- webhook_effects: the side effect, one row per time a handler actually ran it (e.g. "credit the account",
--   "send the email"). Deliberately no unique constraint: it records double processing instead of blocking it.
create table if not exists public.webhook_events (
  event_id     text primary key,
  processed_by text not null,
  processed_at timestamptz not null default now()
);
create table if not exists public.webhook_effects (
  id       bigint generated always as identity primary key,
  event_id text not null,
  worker   text not null,
  at       timestamptz not null default now()
);
alter table public.webhook_events  enable row level security;
alter table public.webhook_effects enable row level security;
revoke all on public.webhook_events, public.webhook_effects from anon, authenticated;

create or replace function public.webhook_reset()
returns void language plpgsql security definer set search_path = public as $$
begin
  truncate public.webhook_events;
  truncate public.webhook_effects restart identity;
end $$;

-- Fix 1: unique event id + INSERT ... ON CONFLICT DO NOTHING RETURNING, and the side effect in the same
-- transaction (one function = one transaction). A concurrent duplicate waits on the first insert's row lock,
-- then sees the conflict and does nothing. Returns true if this call processed the event.
create or replace function public.webhook_process_on_conflict(p_event_id text, p_worker text)
returns boolean language plpgsql security definer set search_path = public as $$
declare got text;
begin
  insert into public.webhook_events (event_id, processed_by) values (p_event_id, p_worker)
    on conflict (event_id) do nothing
    returning event_id into got;
  if got is null then return false; end if;              -- duplicate delivery: already processed
  insert into public.webhook_effects (event_id, worker) values (p_event_id, p_worker);  -- the side effect
  return true;
end $$;

-- Fix 2: transaction-scoped advisory lock on the event id, then check-then-insert under the lock.
-- Read committed takes a fresh snapshot per statement, so the check after the lock sees the winner's commit.
create or replace function public.webhook_process_advisory(p_event_id text, p_worker text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('webhook:' || p_event_id, 0));
  if exists (select 1 from public.webhook_events where event_id = p_event_id) then return false; end if;
  insert into public.webhook_events (event_id, processed_by) values (p_event_id, p_worker);
  insert into public.webhook_effects (event_id, worker) values (p_event_id, p_worker);
  return true;
end $$;

revoke execute on function public.webhook_reset(), public.webhook_process_on_conflict(text,text),
  public.webhook_process_advisory(text,text) from public, anon, authenticated;
grant execute on function public.webhook_reset(), public.webhook_process_on_conflict(text,text),
  public.webhook_process_advisory(text,text) to service_role;
grant select, insert, update on public.webhook_events, public.webhook_effects to service_role;
notify pgrst, 'reload schema';
