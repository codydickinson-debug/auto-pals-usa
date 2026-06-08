-- PSI Period deal fields.
--
-- When staff move a car into the PSI Period tab they now also enter the
-- mileage and the sale price (what the client pays). These carry over to the
-- Sold Cars log when the deal closes, so the data is entered once.
--
-- Follows 2026-06-08-psi-period.sql (psi_car, psi_started_at).

alter table public.requests
  add column if not exists psi_miles integer,
  add column if not exists psi_sale_price numeric;

comment on column public.requests.psi_miles is
  'Vehicle mileage captured when the car entered PSI. Prefills "Mileage at Sale" in the Sold Cars modal.';
comment on column public.requests.psi_sale_price is
  'Agreed sale price (what the client pays) captured when the car entered PSI. Prefills "Sale Price" in the Sold Cars modal.';
