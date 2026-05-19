-- Stamps when a request was last moved to status = 'dormant'. The dashboard
-- Messages tab uses this to hide stale dormant threads until either side
-- sends a new message (msg.ts > dormant_at → thread re-appears).
--
-- Cleared back to NULL whenever a request leaves the dormant status, so a
-- subsequent re-dormant transition gets a fresh stamp.
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked into the
-- repo for parity with the other migration files.

alter table public.requests
  add column if not exists dormant_at timestamptz;

-- Backfill: any rows already in dormant status get stamped with their
-- last-modified time so they hide immediately under the new filter rule.
-- Falls back to submitted date if no other timestamp is available.
update public.requests
set dormant_at = coalesce(
  call_completed_at,
  booking_confirmed_at,
  case when submitted ~ '^\d' then to_timestamp(submitted, 'YYYY-MM-DD"T"HH24:MI:SS') else now() end
)
where status = 'dormant' and dormant_at is null;
