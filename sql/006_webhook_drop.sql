-- Removes the webhook race schema (sql/006_webhook.sql).
drop function if exists public.webhook_process_on_conflict(text,text);
drop function if exists public.webhook_process_advisory(text,text);
drop function if exists public.webhook_reset();
drop table if exists public.webhook_effects;
drop table if exists public.webhook_events;
notify pgrst, 'reload schema';
