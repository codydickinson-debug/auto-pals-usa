-- Lead pipeline tracking (transitioning off Pipedrive).
--
-- Two new axes on a request, on top of the existing status/no_show flow:
--
--   call_outcome  — disposition of a completed intro call. 'good' | 'bad'
--                   | null. A no-show is NOT stored here; it keeps using the
--                   existing no_show_at column + rebooking drip. The dashboard
--                   shows a unified Good / Bad / No-show badge computed from
--                   call_outcome + no_show_at.
--
--   follow_up_stage — where a lead sits in the manual follow-up funnel.
--                   0 = not being followed up, 1..4 = follow-up #1..#4. Staff
--                   advance this by hand so we can measure where leads drop off
--                   between follow-ups. Independent of the automated SMS drip
--                   (client_sms_reminders_sent), which is messaging, not a
--                   human-worked pipeline stage.
--
--   follow_up_updated_at — when follow_up_stage last changed, so we can show
--                   "stuck in FU2 for N days" and time-to-drop-off metrics.

alter table public.requests
  add column if not exists call_outcome text,
  add column if not exists follow_up_stage smallint not null default 0,
  add column if not exists follow_up_updated_at timestamptz;

comment on column public.requests.call_outcome is
  'Intro-call disposition: good | bad | null. No-show lives in no_show_at, not here.';
comment on column public.requests.follow_up_stage is
  'Manual follow-up funnel position: 0 = none, 1..4 = follow-up #1..#4. Staff-advanced, for drop-off metrics.';
comment on column public.requests.follow_up_updated_at is
  'Timestamp follow_up_stage last changed (for time-in-stage / drop-off timing).';
