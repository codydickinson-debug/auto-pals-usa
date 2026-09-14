-- Pipedrive-style Activities (tasks / to-dos). Applied to prod
-- (phbdpvfdnxvzxpybfgbr) 2026-09-14 via apply_migration create_activities_table.
-- A lightweight task with an optional link to a lead (request_id), a type, a
-- due date, and a done flag. Staff-only in api/db.js (not in isPublicOp).
create table if not exists public.activities (
  id          bigint primary key,
  request_id  bigint,
  type        text        not null default 'task',
  title       text        not null,
  due_at      timestamptz,
  done        boolean     not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists activities_done_due_idx on public.activities (done, due_at);
create index if not exists activities_request_idx  on public.activities (request_id);
