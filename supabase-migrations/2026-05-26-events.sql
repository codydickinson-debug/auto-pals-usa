-- Lightweight client-side analytics table. Used to answer questions
-- like "where in the form do people drop off?" and "what % of form-
-- submitters click Book-a-Call on the success screen?" — questions
-- the requests table alone can't answer because it only stores
-- successful submissions, not the path that led there.
--
-- Schema is intentionally generic (name + props JSONB) so we can
-- track new events by just calling track('whatever', {...}) on the
-- frontend without a migration each time.
--
-- session_id is a crypto.randomUUID() stored in localStorage so
-- repeat-visits group together. Not tied to any auth — purely an
-- anonymous funnel identifier.

create table if not exists public.events (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  name        text not null,
  session_id  text,
  page        text,
  props       jsonb,
  request_id  bigint references public.requests(id) on delete set null
);

create index if not exists events_ts_idx          on public.events (ts desc);
create index if not exists events_name_ts_idx     on public.events (name, ts desc);
create index if not exists events_session_idx     on public.events (session_id);

-- Disable RLS — events are anonymous funnel data, no PII beyond the
-- request_id link (which is only present on post-submit events).
-- Anon role can INSERT via the api/db.js proxy. SELECT is staff-only
-- but goes through the proxy too, not direct.
alter table public.events disable row level security;

comment on table  public.events is
  'Anonymous funnel events for the client-facing surface (form, booking, success screen, portal). Written via api/db.js POST /events. Used by the weekly funnel report and ad-hoc drop-off analysis.';
comment on column public.events.name is
  'Event name in snake_case. Examples: form_view, form_submit_success, success_book_click, booking_submit_success.';
comment on column public.events.session_id is
  'crypto.randomUUID() stored in localStorage on first track() call; groups events from the same visitor across page loads.';
comment on column public.events.page is
  'Document path that fired the event (e.g. /form.html). Useful for filtering when the same event name fires from multiple pages.';
comment on column public.events.props is
  'Arbitrary JSON properties — e.g. {budget_max, skip_the_line, referral_source, step}.';
comment on column public.events.request_id is
  'Link to a row in requests when the event happened in the context of a known submission (form_submit_success, booking_submit_success, etc.). Null for pre-submit events.';
