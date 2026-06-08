-- PSI Period tab support for the employee dashboard.
--
-- The dashboard's "PSI Period" tab (left sidebar, under Actively Searching)
-- moves a request to status 'psi' after we buy the client's car. These two
-- columns store which car we bought (psi_car) and when the PSI period started
-- (psi_started_at), so the tab can show each client, their car, and how long
-- they've been in PSI.
--
-- No status enum to update — requests.status is free-text.

alter table public.requests
  add column if not exists psi_car text,
  add column if not exists psi_started_at timestamptz;

comment on column public.requests.psi_car is
  'The vehicle we purchased for the client, captured when staff move the request into the PSI Period tab.';
comment on column public.requests.psi_started_at is
  'Timestamp the PSI period began (when the request was moved to status ''psi''). Drives the "how long in PSI" counter on the PSI Period tab.';
