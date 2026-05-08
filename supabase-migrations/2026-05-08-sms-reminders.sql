-- Twilio SMS rollout — adds tracking column for the client-facing
-- "book a call" SMS drip (3 nudges over 3 days) sent by api/cron.js.
-- Idempotent: safe to re-run.
-- Uses jsonb to match the existing booking_reminders_sent / deposit_reminders_sent columns.

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS client_sms_reminders_sent jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN requests.client_sms_reminders_sent IS
  'Labels of SMS booking reminders already sent to the client (e.g. ["r1","r2"]). Cron uses this to avoid duplicate sends.';
