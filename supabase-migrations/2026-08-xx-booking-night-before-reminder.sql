-- Night-before call reminder: a second SMS nudge sent ~6pm ET the evening
-- before a booked intro call (in addition to the existing ~1-hour reminder).
--
-- api/call-reminders.js claims + stamps this column exactly like it does
-- reminder_sms_sent_at for the 1-hour reminder, so the night-before text
-- fires exactly once per booking. The code is written to fail safe if this
-- column is absent (the night-before pass just no-ops — it never spams and
-- never disturbs the 1-hour reminder), so applying this migration is what
-- turns the feature ON.
--
-- Safe to apply anytime.

alter table public.bookings
  add column if not exists reminder_night_sms_sent_at timestamptz;

comment on column public.bookings.reminder_night_sms_sent_at is
  'When the night-before SMS reminder was sent for this booking (~6pm ET the evening prior). NULL = not yet sent. Claimed race-safely by api/call-reminders.js.';
