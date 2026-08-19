-- "Future Follow-ups" — park a lead who "isn't ready yet" with a date to circle
-- back. follow_up_at = when to follow up (drives the Future Follow-ups tab and
-- the cron reminder); follow_up_note = optional context ("wants to buy after tax
-- refund"); follow_up_sms_sent_at = set once the scheduled reminder SMS fired, so
-- it sends exactly once and the automatic drip stays paused until then.
-- Additive + idempotent; nothing reads these until the v192 code deploys.
alter table public.requests add column if not exists follow_up_at          timestamptz;
alter table public.requests add column if not exists follow_up_note        text;
alter table public.requests add column if not exists follow_up_sms_sent_at timestamptz;
