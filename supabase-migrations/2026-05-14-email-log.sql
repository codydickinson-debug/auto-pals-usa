-- email_log: durable record of every staff/client email attempt so nothing is
-- ever invisible again. Written by api/email.js on every send (ok or fail).
create table if not exists public.email_log (
  id            bigserial primary key,
  ts            timestamptz   not null default now(),
  template      text          not null,
  recipients    text          not null,
  subject       text,
  ok            boolean       not null,
  attempts      smallint      not null default 1,
  sg_status     int,
  error         text,
  request_id    bigint,
  is_staff      boolean       not null default false
);

create index if not exists email_log_ts_idx       on public.email_log (ts desc);
create index if not exists email_log_ok_idx       on public.email_log (ok)            where ok = false;
create index if not exists email_log_template_idx on public.email_log (template);

alter table public.email_log enable row level security;

-- No public access. Only service_role (used by api/email.js) writes/reads.
revoke all on public.email_log from anon, authenticated;
