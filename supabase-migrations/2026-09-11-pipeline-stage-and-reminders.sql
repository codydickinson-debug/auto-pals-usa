-- 2026-09-11  Pipeline kanban board + staff follow-up reminders
-- Applied to production via Supabase MCP (apply_migration
-- "add_pipeline_stage_and_reminder_columns"). Recorded here for auditability.
--
-- Adds three nullable columns to `requests`:
--   pipeline_stage  the 11-stage board column (Pipedrive-matched). SEPARATE from
--                   `status`, which still drives the drips + Pipedrive sync.
--   reminder_at     a STAFF follow-up reminder timestamp. Shows a due/overdue dot
--                   on the board card. Does NOT text the client (distinct from
--                   follow_up_at, which feeds the SMS drip).
--   reminder_note   optional note shown with the reminder.
--
-- All additive + nullable — no existing data changes. Reversible by dropping them.

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS pipeline_stage text,
  ADD COLUMN IF NOT EXISTS reminder_at    timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_note  text;

-- One-time backfill: place every existing lead into a board column from its
-- current status / call outcome / deposit state (staff refine by dragging).
UPDATE requests SET pipeline_stage = CASE
  WHEN deposit_paid IS TRUE                                THEN 'closed_deposit'
  WHEN status IN ('sold','awaiting_paperwork','psi')       THEN 'closed_deposit'
  WHEN status IN ('rejected','dormant')                    THEN 'lost'
  WHEN no_show_at IS NOT NULL                              THEN 'no_show'
  WHEN call_outcome = 'bad'                                THEN 'bad_call'
  WHEN call_outcome = 'good'                               THEN 'good_call'
  WHEN call_completed_at IS NOT NULL                       THEN 'good_call'
  WHEN status = 'searching'                                THEN 'good_call'
  WHEN booking_confirmed_at IS NOT NULL                    THEN 'call_scheduled'
  WHEN status = 'qualified'                                THEN 'contact_attempted'
  ELSE 'new_lead'
END
WHERE pipeline_stage IS NULL;
