-- SECURITY (critical): stop the anon role from reading customer PII directly.
--
-- Background
-- ----------
-- The staff dashboard and public forms never talk to Supabase from the
-- browser — every DB call goes through the server-side function in
-- api/db.js, which authenticates with the SERVICE ROLE key. That function
-- already enforces staff auth + portal-code scoping (the v177 fix).
--
-- BUT the project's anon API key is committed in api/db.js as a fallback, and
-- the GitHub repo is PUBLIC. Anyone can lift that key and hit PostgREST
-- directly, bypassing api/db.js entirely. As of 2026-08-09 the anon role could
-- read, with no auth at all:
--     requests  — 709 rows  (name, email, phone, address, budget, notes …)
--     bookings  — 187 rows  (name, email, phone, vehicle)
--     messages  — 369 rows  (full client/staff conversations)
-- sales, repair_cars, events, and feedback already deny anon — these three
-- tables are the gap.
--
-- Fix
-- ---
-- Revoke the anon (and unused authenticated) role's table privileges on the
-- three exposed tables, and make sure RLS is on as defense-in-depth. The
-- service_role key api/db.js uses is unaffected — it bypasses RLS and its
-- grants are not revoked here — so the app keeps working with zero code
-- changes. The browser never uses the anon key (verified: no Supabase creds
-- in public/), so nothing client-side depends on anon access either.
--
-- PRECONDITION (confirm before applying)
-- --------------------------------------
-- Vercel prod MUST have SUPABASE_SERVICE_ROLE_KEY set, or api/db.js will fall
-- back to the anon key and every read/write breaks the moment this lands.
-- Strong evidence it is set: staff writes to sales/repair_cars succeed today,
-- and those tables already deny anon — impossible unless the server is using
-- the service role. Confirm in Vercel → Project → Settings → Environment
-- Variables before applying. Ideally apply on a Supabase preview branch first.

revoke all privileges on table public.requests  from anon, authenticated;
revoke all privileges on table public.bookings  from anon, authenticated;
revoke all privileges on table public.messages  from anon, authenticated;

alter table public.requests enable row level security;
alter table public.bookings enable row level security;
alter table public.messages enable row level security;

-- Verification (run as the anon key, or let Claude re-run its probe):
--   curl "$SUPABASE_URL/rest/v1/requests?select=id" \
--        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
--   → expect 401 / permission denied (was: 709 rows of PII).
