-- Marketing attribution column for client requests. Populated by a
-- required dropdown at the bottom of the client form ("How did you
-- hear about us?"). On each new submission api/db.js also fires a
-- Google Sheets append to the "Leads" tab so the team can scan
-- channel performance without opening Supabase.
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked
-- into the repo for parity with the other migration files.

alter table public.requests
  add column if not exists referral_source text;

comment on column public.requests.referral_source is
  'Marketing attribution — how the client found Auto Pals USA. Captured by the required dropdown at the bottom of the client form. Mirrored to the Leads tab of the team Google Sheet on submission.';
