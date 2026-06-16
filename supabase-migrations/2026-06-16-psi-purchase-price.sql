-- New `psi_purchase_price` column on requests so the auction-side cost
-- can be captured the same place the rest of the PSI deal numbers
-- live (psi_car, psi_miles, psi_sale_price). The Awaiting Paperwork
-- modal then prefills sm-purchase from psi_purchase_price, completing
-- the user-asked "everything pre-filled from PSI" promise without
-- forcing staff to re-type the auction price.
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked
-- into the repo for migration-file parity.

alter table public.requests
  add column if not exists psi_purchase_price numeric;

comment on column public.requests.psi_purchase_price is
  'What we paid at the auction when sourcing the vehicle. Captured in the Move-to-PSI modal so it can prefill the Awaiting Paperwork / Sold Cars financial form without staff re-typing the number.';
