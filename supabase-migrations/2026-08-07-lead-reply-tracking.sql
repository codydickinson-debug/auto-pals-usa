-- Reply tracking: when did the client last text us back.
--
-- Stamped by api/salesmsg-inbound.js (a Salesmsg "inbound message received"
-- webhook) onto every requests row matching the sender's phone. Powers the
-- dashboard's engagement view — who's replying to follow-ups vs going cold —
-- so drop-off analysis reflects real two-way activity, not just sends.

alter table public.requests
  add column if not exists last_reply_at timestamptz;

comment on column public.requests.last_reply_at is
  'Timestamp of the client''s most recent inbound SMS (from the Salesmsg inbound webhook). Null = never replied.';
