-- Sales rows from the dashboard POST a payload that already includes
-- `vin` (required client-side since v161) and `repair_profit` (the
-- markup the client paid on top of wholesale, sent as camelCase
-- `repairProfit` from the form). Until this migration, neither column
-- existed on public.sales, so Supabase rejected the INSERT and the row
-- silently vanished — the dashboard cached it locally, then the next
-- loadFromDB() overwrote `sales = []` and the user thought the entry
-- was lost.
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked into
-- the repo for migration-file parity.

alter table public.sales
  add column if not exists vin text,
  add column if not exists repair_profit numeric;

comment on column public.sales.vin is
  '17-char VIN — required client-side from v161; column added in v163 to stop the insert from silently failing.';

comment on column public.sales.repair_profit is
  'Repair markup the client paid on top of wholesale; was being dropped by the dashboard POST until v163 because the column did not exist.';
