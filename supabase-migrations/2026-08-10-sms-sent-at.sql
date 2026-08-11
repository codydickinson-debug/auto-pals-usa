-- Exact SMS send-times for the profile Communications timeline.
--
-- The drip records WHICH texts fired (labels in requests.client_sms_reminders_sent
-- like pre1..pre4 / post0..post3 / noshow0..noshow2) but never recorded WHEN.
-- This adds a companion JSONB map on requests: label -> ISO send timestamp.
--
--   { "pre1": "2026-08-10T14:03:11.204Z", "post0": "2026-08-12T18:22:40.001Z" }
--
-- Written best-effort by api/cron.js (stampSmsSentAt) and api/db.js (the instant
-- post0 / noshow0 sends), each in a SEPARATE PATCH from the label-array stamp.
-- Until this column exists those extra PATCHes simply 400 and are ignored — the
-- drip keeps working with no duplicate texts. Once applied, new sends start
-- recording exact times; texts sent before this migration stay "time not
-- recorded" in the timeline (we can't backfill a time we never captured).
--
-- Safe to apply anytime; the code already tolerates the column being absent.

alter table public.requests
  add column if not exists sms_sent_at jsonb not null default '{}'::jsonb;

comment on column public.requests.sms_sent_at is
  'Map of drip SMS label -> ISO send timestamp (pre1..4 / post0..3 / noshow0..2). Powers exact SMS send-times in the dashboard profile Communications timeline. Written best-effort by cron.js + db.js; absence is tolerated by the code.';
