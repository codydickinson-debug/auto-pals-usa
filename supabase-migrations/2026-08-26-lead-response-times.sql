-- lead_response_times — speed-to-lead, measured honestly.
--
-- Time from a lead submitting the form to the first OUTBOUND call we place.
-- In vehicle sourcing this is the number most tightly tied to conversion, and
-- until call logging existed it could not be measured at all.
--
-- THREE THINGS THIS VIEW GUARDS AGAINST
--
-- 1. requests.submitted is TEXT, not timestamptz, and holds two formats:
--    ISO ("2026-08-26T15:10:43.264Z", ~1000 rows) and Postgres-style
--    ("2026-06-01 19:51:31.606+00", ~21 rows). Both cast fine, but an
--    unguarded cast would take the whole view down the first time a malformed
--    value appears. The cast is therefore pattern-guarded and yields NULL
--    rather than raising.
--
-- 2. CALL LOGGING ONLY BEGAN ON 2026-08-25. Every lead submitted before that
--    has no call history — not because nobody rang them, but because nothing
--    was recording it. Treating those as "never contacted" would report ~1000
--    ignored leads and start a fire drill over an absence of data. The
--    `measurable` flag marks the boundary, and every consumer MUST filter on
--    it before drawing a conclusion.
--
-- 3. Only OUTBOUND calls count. A lead ringing US is not our response time —
--    it is theirs. first_any_call_at is exposed separately so "have we spoken
--    at all" stays answerable.
--
-- Safe to apply anytime; creates nothing but a view.

-- The moment call logging began. Anything submitted before this is unmeasurable
-- for response time. Update only if the history is ever genuinely backfilled.
create or replace function public.call_tracking_since()
returns timestamptz language sql immutable as
$$ select timestamptz '2026-08-25 00:00:00+00' $$;

comment on function public.call_tracking_since() is
  'When call logging started. Leads submitted before this have no call history and cannot be scored for response time — see lead_response_times.measurable.';

create or replace view public.lead_response_times as
with parsed as (
  select
    r.id,
    r.email,
    r.phone,
    r.status,
    r.source,
    r.deposit_paid,
    -- Guarded cast: accepts both stored formats, NULL for anything else.
    case
      when r.submitted ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}'
      then r.submitted::timestamptz
    end as submitted_at
  from public.requests r
)
select
  p.id                as request_id,
  p.email,
  p.phone,
  p.status,
  p.source,
  p.deposit_paid,
  p.submitted_at,

  -- Only leads submitted after logging began can be scored.
  (p.submitted_at >= public.call_tracking_since()) as measurable,

  oc.first_outbound_call_at,
  ac.first_any_call_at,

  case
    when oc.first_outbound_call_at is not null
    then round(extract(epoch from (oc.first_outbound_call_at - p.submitted_at)) / 3600.0, 2)
  end as hours_to_first_call,

  -- Buckets for the dashboard. 'never' is only meaningful when measurable.
  case
    when oc.first_outbound_call_at is null then 'never'
    when oc.first_outbound_call_at - p.submitted_at <= interval '1 hour'  then 'under_1h'
    when oc.first_outbound_call_at - p.submitted_at <= interval '4 hours' then 'under_4h'
    when oc.first_outbound_call_at - p.submitted_at <= interval '24 hours' then 'under_24h'
    else 'over_24h'
  end as speed_bucket

from parsed p
left join lateral (
  select min(c.ts) as first_outbound_call_at
  from public.communications c
  where c.request_id = p.id
    and c.channel   = 'call'
    and c.direction = 'out'
    -- A call placed before the form arrived belongs to an earlier conversation,
    -- not to this submission, and would otherwise yield a negative response time.
    and c.ts >= p.submitted_at
) oc on true
left join lateral (
  select min(c.ts) as first_any_call_at
  from public.communications c
  where c.request_id = p.id
    and c.channel = 'call'
    and c.ts >= p.submitted_at
) ac on true
where p.submitted_at is not null;

comment on view public.lead_response_times is
  'Speed-to-lead: hours from form submission to our first OUTBOUND call. ALWAYS filter on measurable = true — leads submitted before call_tracking_since() have no call history and would read as never contacted. Read via the staff-gated api/db.js proxy only.';

alter view public.lead_response_times set (security_invoker = on);
revoke all on public.lead_response_times from anon, authenticated;
