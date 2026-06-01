-- Explicit SMS opt-in column for A2P 10DLC compliance. Populated by the
-- checkbox at the bottom of the client form ("I agree to receive SMS
-- messages from Auto Pals USA …"). Required after TCR rejected our
-- previous campaign for lack of explicit opt-in documentation
-- (error 30896, field MESSAGE_FLOW).
--
-- NULL = legacy row (submitted before the checkbox existed).
-- true  = user actively checked the box on submission.
-- false = user explicitly declined SMS but still submitted the form.
--
-- The outbound SMS pipeline treats false as a hard "no SMS to this
-- client" gate, and NULL/true as "send transactional SMS as normal" —
-- so legacy clients keep receiving messages under their original
-- implicit consent.
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked into
-- the repo for migration-file parity.

alter table public.requests
  add column if not exists sms_consent boolean;

comment on column public.requests.sms_consent is
  'Explicit SMS consent captured by the checkbox at the bottom of the client form. NULL for legacy rows submitted before this column existed — those keep receiving transactional SMS under their original implicit consent. New rows: true if the checkbox was actively ticked, false if the user opted out, NULL if no phone was provided.';
