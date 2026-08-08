-- Lead source attribution — which channel a lead came through.
--
-- Captured automatically from the form URL (request.html?src=tiktok /
-- ?src=instagram / ?src=meta / …) by public/request.html getLeadSource(),
-- stored here so the dashboard can show + filter where each lead originated.
--
-- This is the AUTOMATIC acquisition channel, and is deliberately separate from
-- referral_source (the self-reported "How did you hear about us?" the client
-- picks on the form). Null = no ?src on the URL the lead used (direct/unknown).

alter table public.requests
  add column if not exists source text;

comment on column public.requests.source is
  'Automatic acquisition channel from the ?src= form URL (e.g. tiktok, instagram, meta). Null = direct/unknown. Distinct from referral_source (self-reported).';
