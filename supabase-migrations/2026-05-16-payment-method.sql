-- Capture how the client plans to pay so staff can structure financing
-- (Westlake Financial / tier-1 rate match) up front rather than learning
-- it on the discovery call.
--   payment_method: 'cash' | 'financing'  (nullable for historical rows)
--   down_payment:    client's preferred down payment, in dollars
--   monthly_payment: client's target monthly payment, in dollars
-- Both numeric fields only meaningful when payment_method = 'financing'.
alter table public.requests
  add column if not exists payment_method  text,
  add column if not exists down_payment    numeric,
  add column if not exists monthly_payment numeric;
