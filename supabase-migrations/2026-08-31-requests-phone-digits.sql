-- Fix phone matching — the bug behind "a client who texted STOP still got texts".
--
-- THE PROBLEM
-- requests.phone is stored exactly as the client typed it on the form
-- ("(561) 555-1234", "561-555-1234", "5615551234" — no normalization anywhere).
-- Seven code paths look a client up by the last 10 digits of the number the
-- provider reports, e.g.
--     requests?phone=like.*5615551234    ->  LIKE '%5615551234'
-- which matches ONLY if the stored value happens to be bare digits. For every
-- formatted number the lookup silently returns nothing. Consequences:
--   * api/_sms.js optOutPhone()      — a STOP reply never flips sms_consent,
--                                       so the drip keeps texting them (TCPA).
--   * api/call-reminders.js (x2)     — consent lookup finds nothing, smsConsent
--                                       stays undefined, and _sms.js only blocks
--                                       on an explicit false => an opted-out
--                                       client still receives call reminders.
--   * api/salesmsg-inbound.js (x2)   — replies never stamp last_reply_at.
--   * api/quo-webhook.js/_quo-sync.js — calls never link to their lead.
-- Voice-agent/auto-created leads store +1XXXXXXXXXX and DO match, which is why
-- this looked partly working.
--
-- THE FIX
-- A STORED GENERATED column holding just the digits, plus an index. Postgres
-- computes it for every existing row on creation and keeps it in sync forever,
-- so this repairs all historical leads with no data rewrite and no change to
-- how the number is displayed anywhere. The seven call sites now filter on
-- phone_digits instead of phone.
--
-- Safe to apply anytime, and safe to apply BEFORE the code deploys: nothing
-- reads the column until then. Likewise the updated code degrades to today's
-- behaviour (no match) if this migration hasn't run — every call site already
-- handles a failed lookup — so the two can land in either order.

alter table public.requests
  add column if not exists phone_digits text
  generated always as (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) stored;

create index if not exists requests_phone_digits_idx
  on public.requests (phone_digits);

comment on column public.requests.phone_digits is
  'Digits-only form of phone, auto-generated. Used for last-10 matching by _sms.js (STOP/opt-out), call-reminders.js (consent), salesmsg-inbound.js (reply tracking) and the Quo call linkers. Never write to this directly — it is GENERATED from phone.';

-- Verify after applying:
--   select phone, phone_digits from public.requests where phone is not null limit 5;
--   -- '(561) 555-1234' -> '5615551234'
