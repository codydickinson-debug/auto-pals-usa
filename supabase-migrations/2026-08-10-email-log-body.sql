-- Store the email BODY so the profile Communications timeline can show the full
-- message that was sent, not just the subject line.
--
-- api/email.js logs every send to email_log; it now includes `body` (the
-- plaintext version of the email, capped ~8k chars). The logger falls back to
-- inserting WITHOUT body if this column is absent, so email logging keeps
-- working whether or not this migration has run yet — emails sent before it
-- simply have no stored body (subject still shows).
--
-- Safe to apply anytime.

alter table public.email_log
  add column if not exists body text;

comment on column public.email_log.body is
  'Plaintext body of the sent email (~8k cap), for the dashboard profile Communications timeline. Written best-effort by api/email.js; absence is tolerated (logger retries without it).';
