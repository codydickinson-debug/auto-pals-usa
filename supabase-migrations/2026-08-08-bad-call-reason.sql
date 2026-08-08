-- Bad-call reason — free-text note on WHY a call was graded "bad".
--
-- Captured in the lead's Call Outcome section on the dashboard: marking a call
-- "Bad" opens a small box where staff type the reason (budget too low, not
-- serious, wrong number, etc.). Internal only — never shown to the client.
-- Null / '' = no reason given, or the call isn't graded bad.

alter table public.requests
  add column if not exists call_outcome_reason text;

comment on column public.requests.call_outcome_reason is
  'Free-text note on why a call was graded bad (staff-entered, internal). Null unless call_outcome = bad with a reason.';
