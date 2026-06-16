-- Two columns on repair_cars to support the rolling-out-this-week
-- Repairs tab + portal-side reconditioning quote view:
--
-- 1) quote_approved_at — set when the client clicks "Approve this
--    quote" in the portal (action=approve-quote on api/portal-sign.js,
--    portal-code-gated). NULL = not yet approved. Staff dashboard
--    renders an "✓ Approved {date}" badge based on this value.
--
-- 2) request_id — links the repair back to the originating client
--    request so the portal can fetch "my quote" by request id. Set on
--    insert when the modal is opened from a request row; older rows
--    are backfilled by client-name match against
--    requests.first_name + last_name (case-insensitive).
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked
-- into the repo for migration-file parity.

alter table public.repair_cars
  add column if not exists quote_approved_at timestamptz;

comment on column public.repair_cars.quote_approved_at is
  'When the client clicked Approve on the reconditioning quote in the portal. NULL = not yet approved. Approval is captured by api/portal-sign.js with action=approve-quote.';

alter table public.repair_cars
  add column if not exists request_id bigint;

comment on column public.repair_cars.request_id is
  'Originating requests.id this repair was opened for. Populated on insert when the modal was opened from a request row; older rows backfilled by client-name match. Used by the portal to fetch the client''s own reconditioning quote.';

-- Backfill any pre-existing rows from before request_id was tracked.
-- Match on client name → first_name + last_name (case-insensitive trim).
-- Anything ambiguous or unmatched stays NULL.
update public.repair_cars rc
set request_id = r.id
from public.requests r
where rc.request_id is null
  and rc.client is not null
  and lower(trim(rc.client)) = lower(trim(r.first_name || ' ' || r.last_name));
