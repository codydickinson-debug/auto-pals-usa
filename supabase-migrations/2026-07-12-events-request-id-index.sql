-- Add a covering index for the events.request_id foreign key.
-- The Supabase performance linter flagged events_request_id_fkey as unindexed,
-- which can make FK lookups / cascade checks do a sequential scan. Cheap to add.

create index if not exists events_request_id_idx
  on public.events (request_id);
