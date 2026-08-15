-- "Client Paid" — the total the client actually paid, tracked separately from
-- the vehicle Sale Price. Editable on the request profile (Deal Numbers) while
-- a car is in repair / awaiting paperwork, and recorded on the closed sale so
-- it shows in Sold Cars. Additive + idempotent; nothing reads it until the
-- v188 dashboard deploys, so this is safe to run ahead of the push.
alter table public.sales    add column if not exists client_paid numeric;
alter table public.requests add column if not exists client_paid numeric;
