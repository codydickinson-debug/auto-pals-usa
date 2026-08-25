-- communications: one durable row per real conversation event with a client —
-- every inbound text, and (once a voice provider is wired) every call.
--
-- WHY THIS EXISTS
-- The dashboard already has a Communications timeline (renderCommsTimeline in
-- public/form.html), but it can only show things we happened to keep:
--
--   • Outbound drip texts — we store WHICH label fired (requests.client_sms_
--     reminders_sent) + WHEN (requests.sms_sent_at) and re-derive the copy.
--   • Emails — email_log has the real subject + body.
--   • Portal messages — the two-way portal thread, server-backed in the
--     messages table and read through a localStorage cache the dashboard
--     rebuilds from the DB on load.
--
-- Two holes:
--   1. INBOUND TEXTS. api/salesmsg-inbound.js stamps requests.last_reply_at
--      and then throws the message away. We know a client replied; we have no
--      idea what they said.
--   2. CALLS. Nothing is recorded anywhere. Intro calls dial out from a
--      personal cell (CALL_FROM_NUMBER) and the Retell AI line only writes a
--      booking — neither leaves a conversation record.
--
-- This table is the durable home for both. It is deliberately provider-neutral:
-- channel/direction/body/ts are the shape every provider can fill, and anything
-- provider-specific goes in props. Swapping Salesmsg or adding a voice provider
-- becomes a mapping change in one webhook handler, not a schema migration.
--
-- The column names mirror the event vocabulary used by mainstream phone systems
-- (message.received / call.completed / call.recording.completed) so a future
-- provider maps onto it cleanly.
--
-- TOLERATED ABSENCE
-- Every writer inserts best-effort and ignores failure, exactly like
-- email_log.body and requests.sms_sent_at. Until this migration runs, inbound
-- texts keep stamping last_reply_at and nothing breaks; afterwards the bodies
-- start being kept. There is no backfill — we cannot recover message text we
-- never stored.
--
-- Safe to apply anytime.

create table if not exists public.communications (
  id            bigserial primary key,
  ts            timestamptz not null default now(),
  channel       text        not null,
  direction     text        not null,
  request_id    bigint      references public.requests(id) on delete set null,
  phone         text,
  phone_last10  text,
  body          text,
  duration_sec  int,
  outcome       text,
  recording_url text,
  transcript    text,
  summary       text,
  provider      text,
  provider_id   text,
  props         jsonb       not null default '{}'::jsonb
);

-- Timeline reads: newest-first for one client, or newest-first overall.
create index if not exists communications_ts_idx      on public.communications (ts desc);
create index if not exists communications_request_idx on public.communications (request_id, ts desc);

-- Most inbound webhooks identify the client only by phone number — the
-- request_id is resolved by matching the last 10 digits, same as
-- api/salesmsg-inbound.js already does for last_reply_at.
create index if not exists communications_phone_idx   on public.communications (phone_last10, ts desc);

-- Idempotency. Webhooks retry on any non-2xx, and Salesmsg/Retell will happily
-- redeliver the same event. Where the provider gives us its own id we refuse
-- duplicates outright, so a retry is a no-op instead of a doubled timeline
-- entry. Partial index: rows without a provider_id (manual/backfilled) are
-- exempt rather than colliding on NULL.
create unique index if not exists communications_provider_uidx
  on public.communications (provider, provider_id)
  where provider_id is not null;

-- Same posture as email_log: this holds client message content (PII). No anon
-- or authenticated access at all — only the service role, reached through the
-- staff-gated api/db.js proxy.
alter table public.communications enable row level security;
revoke all on public.communications from anon, authenticated;

comment on table public.communications is
  'Durable per-client conversation log: inbound texts and (once wired) calls. Powers the dashboard profile Communications timeline alongside email_log and the drip labels. Written best-effort by api/salesmsg-inbound.js and the voice webhook; absence of this table is tolerated by every writer.';

comment on column public.communications.channel is
  'Medium: sms | call. Free text rather than an enum so a new channel (whatsapp, portal) does not need a migration.';
comment on column public.communications.direction is
  'in = client -> us, out = us -> client. Free text for the same reason as channel; liberal webhook parsers should default to in when unsure.';
comment on column public.communications.request_id is
  'Client this belongs to, resolved by phone match at write time. Null when no request row matched (unknown number) — the row is still kept so the number can be reconciled later.';
comment on column public.communications.phone is
  'Counterparty number exactly as the provider sent it, for debugging odd formats.';
comment on column public.communications.phone_last10 is
  'Normalised last 10 digits of phone. The join key for matching a webhook to a requests row, since formatting varies by provider.';
comment on column public.communications.body is
  'Message text for sms. For a call, any short note or the AI summary when no separate summary is supplied.';
comment on column public.communications.duration_sec is
  'Call length in seconds. Null for sms.';
comment on column public.communications.outcome is
  'Call disposition: answered | missed | voicemail | completed. Null for sms. Distinct from requests.call_outcome, which is the human good/bad judgement of an intro call.';
comment on column public.communications.recording_url is
  'Provider URL for the call recording, when recording is enabled and consented to. Florida is an all-party consent state — do not populate this without an announcement on the call.';
comment on column public.communications.transcript is
  'Full call transcript when the provider supplies one. Arrives asynchronously, minutes after call.completed — the row must already exist when it lands.';
comment on column public.communications.summary is
  'AI-generated call summary. Written by a later async pass (api/ai.js), not by the webhook itself.';
comment on column public.communications.provider is
  'Which system produced this row: salesmsg | retell | manual. Half of the dedupe key.';
comment on column public.communications.provider_id is
  'The provider''s own id for this message/call. Other half of the dedupe key; null when the provider gives us nothing stable.';
comment on column public.communications.props is
  'Anything provider-specific worth keeping but not worth a column (media urls, raw status strings, webhook envelope ids).';
