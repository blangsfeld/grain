-- Widen dx_commitments.status to accept the closure-sync vocabulary.
-- Notion kept-list Status maps back via lib/closure-sync.ts:
--   Done          → done
--   Recurring     → recurring     (exempt from stale sweeps — Ben's explicit park)
--   Dormant/Evolved/Not a thing → dismissed

ALTER TABLE dx_commitments DROP CONSTRAINT dx_commitments_status_check;

ALTER TABLE dx_commitments ADD CONSTRAINT dx_commitments_status_check
  CHECK (status = ANY (ARRAY['open'::text, 'done'::text, 'dismissed'::text, 'recurring'::text]));
