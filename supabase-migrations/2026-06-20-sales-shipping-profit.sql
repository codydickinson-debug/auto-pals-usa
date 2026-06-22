-- Optional shipping margin on public.sales — what the client paid for
-- shipping minus what we paid the carrier. User asked for it as a
-- post-close-out field they can leave empty at first and fill in later
-- via the Sold Cars Edit button (v167). When set, the value folds
-- straight into net profit alongside repair_profit + finder. When
-- null/0 it's a no-op and the profit math is unchanged from v167.
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked into
-- the repo for migration-file parity.

alter table public.sales
  add column if not exists shipping_profit numeric;

comment on column public.sales.shipping_profit is
  'Optional shipping margin (what the client paid for shipping minus what we paid). Added v168 — folds into net profit when set, leaves profit math unchanged when null/0.';
