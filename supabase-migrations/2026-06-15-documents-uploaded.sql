-- Track which documents each client has uploaded via the portal so the
-- staff dashboard can show "✓ Driver's License uploaded on …" badges in
-- the detail view, instead of requiring staff to dig through email for
-- the attachment.
--
-- The file itself still rides to staff as a SendGrid attachment via the
-- staffClientDocumentUploaded email template — this column is purely
-- visibility/audit. Not file storage.
--
-- Structure example:
--   {
--     "license":   { "uploaded_at": "2026-06-15T19:30:00Z", "filename": "license.jpg",   "size_kb": 1287 },
--     "insurance": { "uploaded_at": "2026-06-15T19:31:00Z", "filename": "insurance.pdf", "size_kb": 412  }
--   }
-- NULL or empty object = nothing uploaded yet.
--
-- Already applied to remote project phbdpvfdnxvzxpybfgbr; checked into
-- the repo for migration-file parity.

alter table public.requests
  add column if not exists documents_uploaded jsonb;

comment on column public.requests.documents_uploaded is
  'Per-doc metadata for files the client has uploaded via the portal. Keyed by doc_key (license / insurance / ...). Values: { uploaded_at, filename, size_kb }. The file itself is delivered to staff via staffClientDocumentUploaded email; this column is the dashboard-side audit/status surface.';
